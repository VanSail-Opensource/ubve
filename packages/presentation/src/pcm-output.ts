import { DEFAULT_PCM_BLOCK_FRAMES, DEFAULT_PCM_POOL_BLOCKS, validatePcmConfiguration } from './audio-protocol.js';
import type { PcmConfiguration, PcmEvent, PcmSnapshot } from './audio-protocol.js';

export interface PcmOutputOptions {
  readonly sampleRate: number;
  readonly channelLabels: readonly string[];
  readonly workletUrl?: string;
  readonly blockFrames?: number;
  readonly poolBlocks?: number;
  readonly primeMs?: number;
  readonly firstMediaSample?: bigint;
  readonly onEvent?: (event: PcmEvent) => void;
}

type Pending = { readonly expected: string; readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: PcmEvent) => void; readonly reject: (reason: Error) => void };

class PcmControlRejection extends Error {
  readonly reason: string | undefined;
  constructor(reason: string | undefined) { super(`Audio control rejected: ${reason}`); this.reason = reason; }
}

function cancelledStart(): DOMException { return new DOMException('Scheduled audio start was cancelled', 'AbortError'); }

function withStartSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function checkedSample(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PCM sample position is outside the exact graph boundary');
  return Number(value);
}

/** Browser graph transport. No compressed audio decoding occurs here.
 * Speaker identity, native resampling, gain and the physical sink remain separate
 * qualification obligations even when every Float32 sample is delivered. */
export class PcmOutput {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly gain: GainNode;
  readonly config: PcmConfiguration;
  #producer: MessagePort;
  #free: { id: number; buffer: ArrayBuffer }[] = [];
  #inFlight = new Map<number, number>();
  #pending = new Map<number, Pending>();
  #nextId = 0;
  #epoch = 0;
  #nextWritten: number;
  #finalSample: number | null = null;
  #disposed = false;
  #disposing: Promise<void> | null = null;
  #resetting = false;
  #terminalError: Error | null = null;
  #starting: { readonly abort: AbortController; readonly result: Promise<PcmEvent> } | null = null;
  #snapshot: PcmSnapshot | null = null;
  #listeners = new Set<(event: PcmEvent) => void>();
  #capacityWaiters = new Set<(error?: Error) => void>();

  private constructor(context: AudioContext, node: AudioWorkletNode, config: PcmConfiguration, producer: MessagePort) {
    this.context = context; this.node = node; this.config = config; this.#producer = producer;
    this.#epoch = config.epoch; this.#nextWritten = config.firstMediaSample;
    this.gain = context.createGain();
    this.gain.channelCount = config.channels;
    this.gain.channelCountMode = 'explicit';
    this.gain.channelInterpretation = 'discrete';
    node.connect(this.gain); this.gain.connect(context.destination);
    for (let id = 0; id < config.poolBlocks; id++) this.#free.push({ id, buffer: new ArrayBuffer(config.blockFrames * config.channels * 4) });
    producer.onmessage = event => {
      const message = event.data as { type: string; id: number; epoch: number; buffer: ArrayBuffer };
      if (message?.type !== 'release') return;
      if (!this.#disposed) {
        if (!this.#inFlight.has(message.id) || this.#inFlight.get(message.id) !== message.epoch || !(message.buffer instanceof ArrayBuffer)
          || message.buffer.byteLength !== this.config.blockFrames * this.config.channels * Float32Array.BYTES_PER_ELEMENT) {
          this.#fail(new Error('Invalid or duplicate PCM buffer return')); return;
        }
        this.#inFlight.delete(message.id);
        this.#free.push({ id: message.id, buffer: message.buffer });
        for (const notify of this.#capacityWaiters) notify();
        this.#capacityWaiters.clear();
      }
    };
    producer.start();
    node.port.onmessage = event => {
      const message = event.data as PcmEvent;
      if (!message || typeof message.type !== 'string') return;
      if (!this.#terminalError || message.type === 'disposed') this.#snapshot = message.snapshot;
      if (message.type === 'error') { this.#fail(new Error(message.reason ?? 'AudioWorklet failed')); return; }
      const pending = message.requestId === undefined ? undefined : this.#pending.get(message.requestId);
      if (pending && (message.type === pending.expected || message.type === 'control-rejected')) {
        this.#pending.delete(message.requestId!); clearTimeout(pending.timer);
        if (message.type === 'control-rejected') pending.reject(message.reason === 'START_CANCELLED'
          ? cancelledStart() : new PcmControlRejection(message.reason));
        else pending.resolve(message);
      }
      for (const listener of this.#listeners) listener(message);
    };
    node.onprocessorerror = () => this.#fail(new Error('AudioWorklet processor failed'));
  }

  static async create(options: PcmOutputOptions): Promise<PcmOutput> {
    if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet is unavailable');
    const blockFrames = options.blockFrames ?? DEFAULT_PCM_BLOCK_FRAMES;
    const primeFrames = Math.ceil(options.sampleRate * (options.primeMs ?? 200) / 1000);
    const poolBlocks = options.poolBlocks ?? Math.max(DEFAULT_PCM_POOL_BLOCKS, Math.ceil(primeFrames / blockFrames) + 2);
    const config: PcmConfiguration = {
      sampleRate: options.sampleRate, channels: options.channelLabels.length, channelLabels: [...options.channelLabels],
      blockFrames, poolBlocks, primeFrames, epoch: 0, firstMediaSample: checkedSample(options.firstMediaSample ?? 0n),
    };
    validatePcmConfiguration(config);
    const context = new AudioContext({ sampleRate: options.sampleRate, latencyHint: 'playback' });
    let instance: PcmOutput | null = null;
    try {
      if (context.sampleRate !== options.sampleRate) throw new Error('E_RATE_UNQUALIFIED: browser changed the requested sample rate');
      if (context.destination.maxChannelCount < config.channels) {
        throw new Error(`Output supports ${context.destination.maxChannelCount} channels; explicit downmix is required for ${config.channels}`);
      }
      context.destination.channelCount = config.channels;
      context.destination.channelCountMode = 'explicit';
      context.destination.channelInterpretation = 'discrete';
      await finite(context.audioWorklet.addModule(options.workletUrl ?? '/vendor/ubve/pcm-worklet.js'), 10_000, 'AudioWorklet module load');
      const node = new AudioWorkletNode(context, 'ubve-pcm-v1', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [config.channels],
        channelCount: config.channels, channelCountMode: 'explicit', channelInterpretation: 'discrete', processorOptions: config,
      });
      const channel = new MessageChannel();
      instance = new PcmOutput(context, node, config, channel.port1);
      if (options.onEvent) instance.#listeners.add(options.onEvent);
      await instance.#control('bind', 'bound', { port: channel.port2 }, [channel.port2]);
      return instance;
    } catch (error) {
      if (instance) await instance.dispose();
      else await context.close().catch(() => undefined);
      throw error;
    }
  }

  get epoch(): number { return this.#epoch; }
  get availableBlocks(): number { return this.#free.length; }
  get nextWrittenSample(): bigint { return BigInt(this.#nextWritten); }
  get snapshot(): PcmSnapshot | null { return this.#snapshot; }
  get transportBytes(): number { return this.config.poolBlocks * this.config.blockFrames * this.config.channels * 4; }

  subscribe(listener: (event: PcmEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  /** Copies into one already-reserved transport buffer. False leaves input owned
   * by the caller. Gaps must be declared/reset, never silently filled. */
  tryWrite(interleaved: Float32Array, firstSample: bigint, frames = interleaved.length / this.config.channels): boolean {
    this.#ensureLive();
    const first = checkedSample(firstSample);
    if (first !== this.#nextWritten || !Number.isSafeInteger(frames) || frames < 1 || frames > this.config.blockFrames
      || interleaved.length !== frames * this.config.channels || !Number.isSafeInteger(first + frames)
      || (this.#finalSample !== null && first + frames > this.#finalSample)) throw new Error('Invalid or noncontiguous PCM block');
    const slot = this.#free.at(-1);
    if (!slot) return false;
    for (const value of interleaved) if (!Number.isFinite(value)) throw new Error('Nonfinite PCM sample');
    this.#free.pop();
    new Float32Array(slot.buffer).set(interleaved);
    try {
      this.#producer.postMessage({ type: 'block', id: slot.id, epoch: this.#epoch,
        startMediaSample: first, frames, channels: this.config.channels, buffer: slot.buffer }, [slot.buffer]);
      this.#inFlight.set(slot.id, this.#epoch);
      this.#nextWritten += frames;
    } catch (error) { this.#free.push(slot); throw error; }
    return true;
  }

  async waitForCapacity(signal?: AbortSignal): Promise<void> {
    this.#ensureLive();
    if (signal?.aborted) throw new Error('PCM write cancelled');
    if (this.#free.length) return;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error): void => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#capacityWaiters.delete(done);
        if (error) reject(error); else resolve();
      };
      const abort = (): void => done(new Error('PCM write cancelled'));
      const timer = setTimeout(() => done(new Error('PCM capacity deadline exceeded')), 5_000);
      this.#capacityWaiters.add(done); signal?.addEventListener('abort', abort, { once: true });
    });
  }

  start(): Promise<PcmEvent> {
    try { this.#ensureLive(); } catch (error) { return Promise.reject(error); }
    if (this.#starting) return this.#starting.result;
    const abort = new AbortController();
    const result = this.#prepareStart(abort.signal).finally(() => {
      if (this.#starting?.abort === abort) this.#starting = null;
    });
    this.#starting = { abort, result }; return result;
  }

  async #prepareStart(signal: AbortSignal): Promise<PcmEvent> {
    await withStartSignal(finite(this.context.resume(), 5_000, 'AudioContext resume (user gesture may be required)'), signal);
    // Queue messages and the start control use different ports. A snapshot
    // handshake alone cannot order those ports; await a concrete primed snapshot.
    await this.#waitPrimed(signal);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const frame = Math.ceil((this.context.currentTime + 0.05) * this.config.sampleRate);
      try { return await withStartSignal(this.#control('start', 'started', { epoch: this.#epoch, startGraphFrame: frame }), signal); }
      catch (error) {
        if (attempt !== 0 || !(error instanceof PcmControlRejection) || error.reason !== 'LATE_ANCHOR') throw error;
      }
    }
  }

  async pause(): Promise<bigint> {
    this.#ensureLive(); this.#cancelStart();
    const event = await this.#control('pause', 'paused', { epoch: this.#epoch });
    return BigInt(event.nextMediaSample);
  }

  async reset(firstSample: bigint): Promise<void> {
    const first = checkedSample(firstSample);
    this.#ensureLive(); this.#cancelStart(); this.#resetting = true;
    const next = this.#epoch + 1;
    try {
      await this.#control('reset', 'reset', { epoch: next, firstMediaSample: first });
      this.#epoch = next; this.#nextWritten = first; this.#finalSample = null;
    } finally { this.#resetting = false; }
  }

  async end(finalSample = this.nextWrittenSample): Promise<void> {
    this.#ensureLive();
    const end = checkedSample(finalSample);
    if (end < this.#nextWritten || (this.#finalSample !== null && this.#finalSample !== end)) throw new Error('Invalid PCM EOS boundary');
    this.#finalSample = end;
    await this.#control('eos', 'eos', { epoch: this.#epoch, finalMediaSample: end });
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Volume must be between zero and one');
    this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
  }

  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#cancelStart();
    this.#disposing = this.#disposeOwned(); return this.#disposing;
  }

  async #disposeOwned(): Promise<void> {
    try { await this.#control('dispose', 'disposed', {}, [], 1_000); }
    finally {
      this.#disposed = true;
      const error = new Error('PCM output disposed'); this.#rejectAll(error);
      this.node.disconnect(); this.gain.disconnect(); this.node.port.close(); this.#producer.close();
      this.#free.length = 0; this.#inFlight.clear(); this.#listeners.clear();
      for (const notify of this.#capacityWaiters) notify(error);
      this.#capacityWaiters.clear();
      await finite(this.context.close(), 1_000, 'AudioContext close').catch(() => undefined);
    }
  }

  #waitPrimed(signal: AbortSignal): Promise<void> {
    const enough = (): boolean => this.#snapshot?.epoch === this.#epoch
      && (this.#snapshot.queuedFrames >= this.config.primeFrames
        || (this.#snapshot.queuedFrames > 0 && this.#snapshot.finalMediaSample !== null
          && this.#snapshot.nextMediaSample + this.#snapshot.queuedFrames === this.#snapshot.finalMediaSample));
    // The processor itself enforces short-tail EOS and rejects unprimed starts.
    signal.throwIfAborted();
    if (enough()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (error?: unknown): void => {
        clearTimeout(timer); this.#listeners.delete(listener); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const listener = (): void => { if (enough()) done(); };
      const abort = (): void => done(signal.reason);
      const timer = setTimeout(() => done(new Error('PCM priming deadline exceeded')), 5_000);
      this.#listeners.add(listener);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  #control(type: string, expected: string, payload: Record<string, unknown>, transfer: Transferable[] = [], timeoutMs = 5_000): Promise<PcmEvent> {
    if (this.#disposed) return Promise.reject(new Error('PCM output is disposed'));
    const requestId = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error(`PCM ${type} deadline exceeded`)); }, timeoutMs);
      this.#pending.set(requestId, { expected, timer, resolve, reject });
      try { this.node.port.postMessage({ type, requestId, ...payload }, transfer); }
      catch (error) { clearTimeout(timer); this.#pending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  #ensureLive(): void {
    if (this.#disposed || this.#disposing) throw new Error('PCM output is disposed');
    if (this.#terminalError) throw this.#terminalError;
    if (this.#resetting) throw new Error('PCM output is resetting');
  }

  #cancelStart(reason: Error = cancelledStart()): void {
    this.#starting?.abort.abort(reason); this.#starting = null;
  }

  #fail(error: Error): void {
    if (this.#terminalError || this.#disposed) return;
    this.#terminalError = error; this.#cancelStart(error); this.#rejectAll(error);
    for (const notify of this.#capacityWaiters) notify(error);
    this.#capacityWaiters.clear();
    const snapshot: PcmSnapshot = {
      state: 'failed', epoch: this.#epoch, graphFrame: Math.floor(this.context.currentTime * this.config.sampleRate),
      nextMediaSample: this.config.firstMediaSample, finalMediaSample: null, queuedFrames: 0, acceptedBlocks: 0,
      returnedBlocks: 0, consumedFrames: 0, underruns: 0, rejectedBlocks: 0,
      capacityFrames: this.config.poolBlocks * this.config.blockFrames, transportBytes: this.transportBytes,
      ...this.#snapshot,
    };
    this.#snapshot = { ...snapshot, state: 'failed' };
    for (const listener of this.#listeners) listener({ type: 'error', reason: error.message, epoch: snapshot.epoch,
      graphFrame: snapshot.graphFrame, nextMediaSample: snapshot.nextMediaSample, snapshot: this.#snapshot });
  }
}

export async function finite<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
