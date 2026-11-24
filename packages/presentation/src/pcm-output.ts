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
  #pending = new Map<number, Pending>();
  #nextId = 0;
  #epoch = 0;
  #nextWritten: number;
  #disposed = false;
  #snapshot: PcmSnapshot | null = null;
  #listeners = new Set<(event: PcmEvent) => void>();
  #capacityWaiters = new Set<() => void>();

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
      const message = event.data as { type: string; id: number; buffer: ArrayBuffer };
      if (message.type !== 'release' || !(message.buffer instanceof ArrayBuffer)) return;
      if (!this.#disposed) {
        if (this.#free.some(slot => slot.id === message.id)) { this.#rejectAll(new Error('Duplicate PCM buffer return')); return; }
        this.#free.push({ id: message.id, buffer: message.buffer });
        for (const notify of this.#capacityWaiters) notify();
        this.#capacityWaiters.clear();
      }
    };
    producer.start();
    node.port.onmessage = event => {
      const message = event.data as PcmEvent;
      if (!message || typeof message.type !== 'string') return;
      this.#snapshot = message.snapshot;
      if (message.type === 'error') this.#rejectAll(new Error(message.reason ?? 'AudioWorklet failed'));
      const pending = message.requestId === undefined ? undefined : this.#pending.get(message.requestId);
      if (pending && (message.type === pending.expected || message.type === 'control-rejected')) {
        this.#pending.delete(message.requestId!); clearTimeout(pending.timer);
        if (message.type === 'control-rejected') pending.reject(message.reason === 'START_CANCELLED'
          ? new DOMException('Scheduled audio start was cancelled', 'AbortError') : new Error(`Audio control rejected: ${message.reason}`));
        else pending.resolve(message);
      }
      for (const listener of this.#listeners) listener(message);
    };
    node.onprocessorerror = () => this.#rejectAll(new Error('AudioWorklet processor failed'));
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
    if (this.#disposed) throw new Error('PCM output is disposed');
    const first = checkedSample(firstSample);
    if (first !== this.#nextWritten || !Number.isSafeInteger(frames) || frames < 1 || frames > this.config.blockFrames
      || interleaved.length !== frames * this.config.channels) throw new Error('Invalid or noncontiguous PCM block');
    for (const value of interleaved) if (!Number.isFinite(value)) throw new Error('Nonfinite PCM sample');
    const slot = this.#free.pop();
    if (!slot) return false;
    new Float32Array(slot.buffer).set(interleaved);
    try {
      this.#producer.postMessage({ type: 'block', id: slot.id, epoch: this.#epoch,
        startMediaSample: first, frames, channels: this.config.channels, buffer: slot.buffer }, [slot.buffer]);
      this.#nextWritten += frames;
    } catch (error) { this.#free.push(slot); throw error; }
    return true;
  }

  async waitForCapacity(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) throw new Error('PCM output is disposed');
    if (signal?.aborted) throw new Error('PCM write cancelled');
    if (this.#free.length) return;
    await new Promise<void>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#capacityWaiters.delete(done); resolve(); };
      const abort = (): void => { clearTimeout(timer); this.#capacityWaiters.delete(done); reject(new Error('PCM write cancelled')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); this.#capacityWaiters.delete(done); reject(new Error('PCM capacity deadline exceeded')); }, 5_000);
      this.#capacityWaiters.add(done); signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async start(): Promise<PcmEvent> {
    if (this.#disposed) throw new Error('PCM output is disposed');
    await finite(this.context.resume(), 5_000, 'AudioContext resume (user gesture may be required)');
    // Queue messages and the start control use different ports. A snapshot
    // handshake alone cannot order those ports; await a concrete primed snapshot.
    await this.#waitPrimed();
    const frame = Math.ceil((this.context.currentTime + 0.05) * this.config.sampleRate);
    return this.#control('start', 'started', { epoch: this.#epoch, startGraphFrame: frame });
  }

  async pause(): Promise<bigint> {
    const event = await this.#control('pause', 'paused', { epoch: this.#epoch });
    return BigInt(event.nextMediaSample);
  }

  async reset(firstSample: bigint): Promise<void> {
    const first = checkedSample(firstSample);
    if (this.#disposed) throw new Error('PCM output is disposed');
    const next = this.#epoch + 1;
    await this.#control('reset', 'reset', { epoch: next, firstMediaSample: first });
    this.#epoch = next; this.#nextWritten = first;
  }

  async end(finalSample = this.nextWrittenSample): Promise<void> {
    await this.#control('eos', 'eos', { epoch: this.#epoch, finalMediaSample: checkedSample(finalSample) });
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Volume must be between zero and one');
    this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try { await this.#control('dispose', 'disposed', {}, [], 1_000); }
    finally {
      this.#disposed = true; this.#rejectAll(new Error('PCM output disposed'));
      this.node.disconnect(); this.gain.disconnect(); this.node.port.close(); this.#producer.close();
      this.#free.length = 0; this.#listeners.clear();
      for (const notify of this.#capacityWaiters) notify();
      this.#capacityWaiters.clear();
      await finite(this.context.close(), 1_000, 'AudioContext close').catch(() => undefined);
    }
  }

  #waitPrimed(): Promise<void> {
    const enough = (): boolean => this.#snapshot?.epoch === this.#epoch
      && (this.#snapshot.queuedFrames >= this.config.primeFrames
        || (this.#snapshot.queuedFrames > 0 && this.#snapshot.finalMediaSample !== null
          && this.#snapshot.nextMediaSample + this.#snapshot.queuedFrames === this.#snapshot.finalMediaSample));
    // The processor itself enforces short-tail EOS and rejects unprimed starts.
    if (enough()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const listener = (): void => { if (enough()) { clearTimeout(timer); this.#listeners.delete(listener); resolve(); } };
      const timer = setTimeout(() => { this.#listeners.delete(listener); reject(new Error('PCM priming deadline exceeded')); }, 5_000);
      this.#listeners.add(listener);
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
}

export async function finite<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
