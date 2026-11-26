import { EngineError, byteLength, mediaTime, validateVideoPixels, type EffectiveDecoderConfiguration, type EncodedPacket, type MediaTime, type SessionStamp, type VideoPixels } from '@ubve/core';
import { PacketDecoder } from './decoder.js';
import { CodecWorkerClient } from './worker-client.js';

export interface Av1DecoderOptions { readonly width: number; readonly height: number; readonly description?: Uint8Array; readonly stamp: SessionStamp; readonly threads?: 1 | 2 | 4; readonly assetBaseUrl?: string; readonly outputFrames?: number; }
interface DecodedFrame { readonly frame: VideoPixels; readonly token: string; readonly outputReady: boolean; }
export class Av1Decoder extends PacketDecoder<VideoPixels> {
  readonly effective: EffectiveDecoderConfiguration;
  readonly options: Av1DecoderOptions;
  #worker!: CodecWorkerClient;
  #pending = new Map<string, { packetId: string; pts: MediaTime; durationTicks: bigint | null; codecConfigEpoch: number }>();
  #nextToken = 0;
  readonly #maximumFrameBytes: number;
  #environment: unknown = null; #shutdownEvidence: unknown = null;
  private constructor(options: Av1DecoderOptions) {
    const maximumFrameBytes = options.width * options.height * 2 + Math.ceil(options.width / 2) * Math.ceil(options.height / 2) * 4;
    super(options.stamp, maximumFrameBytes * (options.outputFrames ?? 4), options.outputFrames ?? 4);
    this.#maximumFrameBytes = maximumFrameBytes;
    this.options = options;
    this.effective = { codecId: 'av1', workers: (options.threads ?? 1) + 1, sharedMemory: true, outputLayout: 'I420P10-or-I420P8', resources: { explicitInputBudgetEnforced: true, explicitOutputBudgetEnforced: true, internalHeap: 'opaque', internalHeapLimitBytes: null, internalHeapEstimateBytes: byteLength(256 * 1024 * 1024), runtimeLifetime: 'session', completeShutdown: 'not-established' } };
  }
  static async create(options: Av1DecoderOptions): Promise<Av1Decoder> {
    const decoder = new Av1Decoder(options);
    try { await decoder.reopen(); return decoder; }
    catch (error) { try { await decoder.dispose(); } catch { /* Preserve the original initialization failure. */ } throw error; }
  }
  protected async reopen(): Promise<void> {
    const base = new URL(this.options.assetBaseUrl ?? '/vendor/', globalThis.location?.href ?? 'http://localhost/');
    this.#worker = new CodecWorkerClient(new URL('av1/dav1d.worker.js', base), 'module');
    this.#environment = await this.#worker.call('init', { width: this.options.width, height: this.options.height, description: this.options.description ?? new Uint8Array(), threads: this.options.threads ?? 1, wasmUrl: new URL('av1/av1-atomic.wasm', base).href }, [], 10000);
    this.#pending.clear(); this.#nextToken = 0;
  }
  protected async decode(packet: EncodedPacket, consumed: () => void): Promise<void> {
    const source = packet.bytes.borrow();
    // A view may share a source cache's backing store. Only a full, ordinarily
    // transferable ArrayBuffer can move with the input lease. Copy other views.
    const data = source.buffer instanceof ArrayBuffer && source.byteOffset === 0 && source.byteLength === source.buffer.byteLength ? source : source.slice();
    if (this.#pending.size >= 128) throw new EngineError('UNSUPPORTED_PROFILE', 'AV1 unmatched packet association depth exceeds admission');
    const token = ++this.#nextToken;
    if (!Number.isSafeInteger(token)) throw new EngineError('UNSUPPORTED_PROFILE', 'AV1 packet association token exhausted');
    // The decoder echoes the opaque token through AVFrame.pts. Public output
    // retains the original rational timeline rather than rounding to µs.
    this.#pending.set(String(token), { packetId: packet.id, pts: mediaTime(packet.ptsTicks, packet.timeBase), durationTicks: packet.durationTicks, codecConfigEpoch: packet.codecConfigEpoch });
    let result = await this.#worker.call<{ accepted: boolean; outputReady: boolean }>('submit', { data, token, key: packet.recovery === 'key' }, [data.buffer as ArrayBuffer]);
    for (let retries = 0; !result.accepted; retries++) {
      if (retries >= 4 || !result.outputReady) throw new EngineError('INVALID_PACKET', 'AV1 send/receive made no progress while retaining the same packet');
      await this.#receive(result.outputReady);
      this.ensureActive();
      result = await this.#worker.call('submit');
    }
    this.ensureActive(); consumed(); await this.#receive(result.outputReady);
  }
  async #receive(ready: boolean): Promise<void> {
    while (ready) {
      // Credit is acquired before the worker allocates or transfers a decoded plane copy.
      const credit = await this.reserveOutput(this.#maximumFrameBytes);
      try {
        const result = await this.#worker.call<DecodedFrame>('take');
        validateVideoPixels(result.frame);
        const origin = this.#pending.get(result.token);
        if (!origin) throw new EngineError('UNSUPPORTED_PROFILE', 'AV1 output has no unique matching accepted packet association');
        this.#pending.delete(result.token);
        const frame = result.frame.signalMetadata ? { ...result.frame, signalMetadata: { ...result.frame.signalMetadata, epoch: origin.codecConfigEpoch } } : result.frame;
        await this.emit({ stamp: this.stamp, operationId: 'dav1d-output', sourcePacketId: origin.packetId, pts: origin.pts, durationTicks: origin.durationTicks, codecConfigEpoch: origin.codecConfigEpoch }, frame, frame.data.buffer.byteLength, credit);
        ready = result.outputReady;
      } finally { credit.release(); }
    }
  }
  protected async flush(): Promise<void> {
    const result = await this.#worker.call<{ outputReady: boolean }>('flush');
    await this.#receive(result.outputReady);
  }
  protected async shutdown(): Promise<void> {
    if (!this.#worker) return;
    try {
      const result = await this.#worker.call<{ failures: readonly { stage: string; message: string }[] }>('close', {}, [], 1000);
      this.#shutdownEvidence = result;
      if (result.failures.length) throw new EngineError('INTERNAL', `AV1 runtime close failed in ${result.failures.map(failure => failure.stage).join(', ')}`);
    }
    finally { this.#worker.terminate(); }
  }
  diagnostics() { return { ...this.snapshot(), environment: this.#environment, shutdown: this.#shutdownEvidence, worker: this.#worker?.snapshot(), unmatchedPacketAssociations: this.#pending.size, codecEofObservation: 'upstream receive merges EAGAIN/EOF; EOS is accepted flush followed by drain-to-empty' }; }
}
