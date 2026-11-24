import { validatePcmConfiguration } from '../src/audio-protocol.js';
import type { PcmBlock, PcmConfiguration, PcmSnapshot, PcmState } from '../src/audio-protocol.js';

type Queued = PcmBlock & { data: Float32Array; offset: number };
type Control = {
  type: string; requestId?: number; port?: WorkletPort;
  epoch?: number; firstMediaSample?: number; startGraphFrame?: number; finalMediaSample?: number;
};

/** No decode, fetch, timers, or sample-sized allocation occurs in process().
 * Buffers travel producer -> worklet -> producer and the ring has a fixed cap. */
class UbvePcmProcessor extends AudioWorkletProcessor {
  readonly config: PcmConfiguration;
  readonly ring: (Queued | null)[];
  producer: WorkletPort | null = null;
  state: PcmState = 'ready';
  epoch: number;
  nextSample: number;
  nextQueued: number;
  finalSample: number | null = null;
  anchor: number | null = null;
  head = 0;
  count = 0;
  queued = 0;
  accepted = 0;
  returned = 0;
  consumed = 0;
  underruns = 0;
  rejected = 0;
  lastProgress = 0;
  pendingStartId: number | undefined;

  constructor(options?: unknown) {
    super();
    const config = (options as { processorOptions: PcmConfiguration }).processorOptions;
    validatePcmConfiguration(config);
    if (sampleRate !== config.sampleRate) throw new Error('E_RATE_UNQUALIFIED: graph sample rate differs from decoded PCM');
    this.config = config;
    this.epoch = config.epoch;
    this.nextSample = this.nextQueued = config.firstMediaSample;
    this.ring = Array.from({ length: config.poolBlocks }, () => null);
    this.port.onmessage = event => {
      try { this.control(event.data as Control); }
      catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    };
  }

  snapshot(): PcmSnapshot {
    return {
      state: this.state, epoch: this.epoch, graphFrame: currentFrame,
      nextMediaSample: this.nextSample, finalMediaSample: this.finalSample, queuedFrames: this.queued,
      acceptedBlocks: this.accepted, returnedBlocks: this.returned,
      consumedFrames: this.consumed, underruns: this.underruns, rejectedBlocks: this.rejected,
      capacityFrames: this.config.poolBlocks * this.config.blockFrames,
      transportBytes: this.config.poolBlocks * this.config.blockFrames * this.config.channels * 4,
    };
  }

  emit(type: string, requestId?: number, reason?: string, graphFrame = currentFrame): void {
    this.port.postMessage({ type, requestId, reason, epoch: this.epoch, graphFrame,
      nextMediaSample: this.nextSample, snapshot: this.snapshot() });
  }

  release(block: PcmBlock, reason: string): void {
    this.producer?.postMessage({ type: 'release', id: block.id, epoch: block.epoch, reason, buffer: block.buffer }, [block.buffer]);
    this.returned++;
  }

  clear(reason: string): void {
    while (this.count) {
      const block = this.ring[this.head];
      this.ring[this.head] = null;
      this.head = (this.head + 1) % this.ring.length;
      this.count--;
      if (block) this.release(block, reason);
    }
    this.queued = 0;
  }

  fail(reason: string): void {
    if (this.state === 'disposed' || this.state === 'failed') return;
    this.state = 'failed';
    this.anchor = null;
    this.cancelScheduledStart();
    this.clear('FAILED');
    this.emit('error', undefined, reason);
  }

  cancelScheduledStart(): void {
    if (this.pendingStartId !== undefined) this.emit('control-rejected', this.pendingStartId, 'START_CANCELLED');
    this.pendingStartId = undefined;
  }

  receive(value: unknown): void {
    const block = value as PcmBlock;
    if (block.type !== 'block') return;
    let reason = '';
    if (!(block.buffer instanceof ArrayBuffer)) { this.fail('Invalid PCM transferable'); return; }
    if (block.epoch !== this.epoch) reason = 'STALE_EPOCH';
    else if (!['ready', 'scheduled', 'playing', 'paused'].includes(this.state)) reason = 'NOT_ACCEPTING';
    else if (!Number.isSafeInteger(block.frames) || block.frames < 1 || block.frames > this.config.blockFrames
      || block.channels !== this.config.channels || block.buffer.byteLength !== this.config.blockFrames * this.config.channels * 4
      || !Number.isSafeInteger(block.startMediaSample)) reason = 'INVALID_BLOCK';
    else if (block.startMediaSample !== this.nextQueued) reason = 'NONCONTIGUOUS';
    else if (this.count === this.ring.length) reason = 'CAPACITY';
    else if (!Number.isSafeInteger(this.nextQueued + block.frames)
      || (this.finalSample !== null && this.nextQueued + block.frames > this.finalSample)) reason = 'PAST_END';
    if (reason) {
      this.rejected++;
      this.release(block, reason);
      this.emit('rejected', undefined, reason);
      return;
    }
    const data = new Float32Array(block.buffer);
    for (let i = 0; i < block.frames * this.config.channels; i++) {
      if (!Number.isFinite(data[i])) { this.release(block, 'NONFINITE'); this.fail('Nonfinite PCM sample'); return; }
    }
    this.ring[(this.head + this.count) % this.ring.length] = { ...block, data, offset: 0 };
    this.count++;
    this.queued += block.frames;
    this.nextQueued += block.frames;
    this.accepted++;
    this.emit('queued');
  }

  control(message: Control): void {
    if (message.type === 'bind') {
      if (this.producer || !message.port || this.state === 'disposed') throw new Error('PCM producer already bound or invalid');
      this.producer = message.port;
      this.producer.onmessage = event => {
        try { this.receive(event.data); }
        catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
      };
      this.producer.start();
      this.emit('bound', message.requestId);
      return;
    }
    if (message.type === 'dispose') {
      this.cancelScheduledStart();
      this.state = 'disposed'; this.clear('DISPOSED'); this.anchor = null;
      this.emit('disposed', message.requestId);
      return;
    }
    if (this.state === 'disposed' || this.state === 'failed') {
      this.emit('control-rejected', message.requestId, 'TERMINAL'); return;
    }
    if (message.type === 'reset') {
      if (!Number.isSafeInteger(message.epoch) || message.epoch! <= this.epoch
        || !Number.isSafeInteger(message.firstMediaSample) || message.firstMediaSample! < 0) throw new Error('Invalid new PCM epoch');
      this.cancelScheduledStart(); this.clear('RESET'); this.epoch = message.epoch!;
      this.nextSample = this.nextQueued = message.firstMediaSample!;
      this.state = 'ready'; this.anchor = null; this.finalSample = null;
      this.pendingStartId = undefined;
      this.emit('reset', message.requestId); return;
    }
    if (message.epoch !== this.epoch) { this.emit('control-rejected', message.requestId, 'STALE_EPOCH'); return; }
    if (message.type === 'pause') {
      this.cancelScheduledStart();
      if (this.state === 'playing' || this.state === 'scheduled' || this.state === 'ready') this.state = 'paused';
      this.anchor = null; this.pendingStartId = undefined;
      this.emit('paused', message.requestId); return;
    }
    if (message.type === 'eos') {
      const end = message.finalMediaSample;
      if (!Number.isSafeInteger(end) || end! < this.nextQueued || (this.finalSample !== null && this.finalSample !== end)) throw new Error('Invalid PCM EOS boundary');
      this.finalSample = end!;
      this.emit('eos', message.requestId); return;
    }
    if (message.type === 'start') {
      const shortCompleteTail = this.finalSample !== null && this.nextQueued === this.finalSample && this.queued > 0;
      if (!this.producer || !['ready', 'paused'].includes(this.state) || (this.queued < this.config.primeFrames && !shortCompleteTail)) {
        this.emit('control-rejected', message.requestId, 'NOT_PRIMED'); return;
      }
      if (!Number.isSafeInteger(message.startGraphFrame) || message.startGraphFrame! <= currentFrame) {
        this.emit('control-rejected', message.requestId, 'LATE_ANCHOR'); return;
      }
      this.anchor = message.startGraphFrame!; this.state = 'scheduled'; this.pendingStartId = message.requestId;
      this.emit('scheduled', message.requestId); return;
    }
    if (message.type === 'snapshot') { this.emit('snapshot', message.requestId); return; }
    throw new Error('Unknown PCM control');
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output?.length) return this.state !== 'disposed';
    const quantum = output[0]!.length;
    for (const channel of output) channel.fill(0);
    if (output.length !== this.config.channels || output.some(channel => channel.length !== quantum)) {
      this.fail('Audio graph channel count changed'); return true;
    }
    if (this.state !== 'scheduled' && this.state !== 'playing') return this.state !== 'disposed';
    for (let index = 0; index < quantum; index++) {
      const graphFrame = currentFrame + index;
      if (this.anchor === null || graphFrame < this.anchor) continue;
      if (this.finalSample !== null && this.nextSample === this.finalSample) {
        this.state = 'ended'; this.clear('EOS'); this.emit('ended', undefined, undefined, graphFrame); break;
      }
      const block = this.ring[this.head];
      if (!block) {
        this.state = 'starved'; this.underruns++;
        this.emit('underrun', undefined, 'MISSING_MEDIA_SAMPLE', graphFrame); break;
      }
      if (block.startMediaSample + block.offset !== this.nextSample) { this.fail('PCM consumption discontinuity'); break; }
      if (this.state === 'scheduled') {
        this.state = 'playing'; this.emit('started', this.pendingStartId, undefined, graphFrame); this.pendingStartId = undefined;
      }
      for (let channel = 0; channel < output.length; channel++) {
        output[channel]![index] = block.data[block.offset * this.config.channels + channel]!;
      }
      this.nextSample++; this.consumed++; this.queued--; block.offset++;
      if (block.offset === block.frames) {
        this.ring[this.head] = null; this.head = (this.head + 1) % this.ring.length; this.count--;
        this.release(block, 'CONSUMED');
      }
      if (this.finalSample !== null && this.nextSample === this.finalSample) {
        this.state = 'ended'; this.clear('EOS'); this.emit('ended', undefined, undefined, graphFrame + 1); break;
      }
    }
    if (currentFrame - this.lastProgress >= sampleRate / 4) { this.lastProgress = currentFrame; this.emit('progress'); }
    return true;
  }
}

registerProcessor('ubve-pcm-v1', UbvePcmProcessor);
