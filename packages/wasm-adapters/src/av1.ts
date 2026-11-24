import { EngineError, byteLength, mediaTime, timeBase, validateVideoPixels, type EffectiveDecoderConfiguration, type EncodedPacket, type SessionStamp, type VideoPixels } from '@ubve/core';
import { packetSeconds } from '@ubve/io-demux';
import { PacketDecoder } from './decoder.js';
import { CodecWorkerClient } from './worker-client.js';

export interface Av1DecoderOptions { readonly width: number; readonly height: number; readonly description?: Uint8Array; readonly stamp: SessionStamp; readonly threads?: 1 | 2 | 4; readonly assetBaseUrl?: string; readonly outputFrames?: number; }
export class Av1Decoder extends PacketDecoder<VideoPixels> {
  readonly effective: EffectiveDecoderConfiguration;
  readonly options: Av1DecoderOptions;
  #worker!: CodecWorkerClient;
  #pending = new Map<string, { packetId: string; durationUs: bigint | null; codecConfigEpoch: number }>();
  readonly #maximumFrameBytes: number;
  #environment: unknown = null; #shutdownEvidence: unknown = null;
  private constructor(options: Av1DecoderOptions) {
    const maximumFrameBytes = options.width * options.height * 2 + Math.ceil(options.width / 2) * Math.ceil(options.height / 2) * 4;
    super(options.stamp, maximumFrameBytes * (options.outputFrames ?? 4), options.outputFrames ?? 4);
    this.#maximumFrameBytes = maximumFrameBytes;
    this.options = options;
    this.effective = { codecId: 'av1', workers: (options.threads ?? 4) + 1, sharedMemory: true, outputLayout: 'I420P10-or-I420P8', resources: { explicitInputBudgetEnforced: true, explicitOutputBudgetEnforced: true, internalHeap: 'opaque', internalHeapLimitBytes: null, internalHeapEstimateBytes: byteLength(256 * 1024 * 1024), runtimeLifetime: 'session', completeShutdown: 'not-established' } };
  }
  static async create(options: Av1DecoderOptions): Promise<Av1Decoder> { const decoder = new Av1Decoder(options); try { await decoder.reopen(); return decoder; } catch (error) { await decoder.dispose(); throw error; } }
  protected async reopen(): Promise<void> {
    const base = new URL(this.options.assetBaseUrl ?? '/vendor/', globalThis.location?.href ?? 'http://localhost/');
    this.#worker = new CodecWorkerClient(new URL('av1/dav1d.worker.js', base), 'module');
    this.#environment = await this.#worker.call('init', { width: this.options.width, height: this.options.height, description: this.options.description ?? new Uint8Array(), threads: this.options.threads ?? 4, wasmUrl: new URL('av1/av1-atomic.wasm', base).href }, [], 10000);
    this.#pending.clear();
  }
  protected async decode(packet: EncodedPacket, consumed: () => void): Promise<void> {
    const time = packetSeconds(packet), data = packet.bytes.borrow(), ptsUs = Math.round(time.timestamp * 1e6), durationUs = Math.round(time.duration * 1e6);
    if (!Number.isSafeInteger(ptsUs) || !Number.isSafeInteger(durationUs)) throw new EngineError('UNSUPPORTED_PROFILE', 'AV1 timestamp exceeds admitted microsecond precision');
    const key = String(ptsUs);
    if (this.#pending.has(key) || this.#pending.size >= 128) throw new EngineError('UNSUPPORTED_PROFILE', 'AV1 timestamp collision or reorder depth exceeds admission');
    this.#pending.set(key, { packetId: packet.id, durationUs: packet.durationTicks === null ? null : BigInt(durationUs), codecConfigEpoch: packet.codecConfigEpoch });
    let result = await this.#worker.call<{ accepted: boolean }>('send', { data, ptsUs, durationUs, key: packet.recovery === 'key' }, [data.buffer as ArrayBuffer]);
    for (let retries = 0; !result.accepted; retries++) {
      if (retries >= 4 || await this.#receive() === 0) throw new EngineError('INVALID_PACKET', 'AV1 send/receive made no progress while retaining the same packet');
      result = await this.#worker.call('send', {});
    }
    consumed(); await this.#receive();
  }
  async #receive(): Promise<number> {
    let frames = 0;
    for (;;) {
      // Credit is acquired before the worker allocates or transfers a decoded plane copy.
      const credit = await this.reserveOutput(this.#maximumFrameBytes);
      try {
        const result = await this.#worker.call<{ frame: VideoPixels | null; ptsUs: string }>('receive');
        if (!result.frame) return frames;
        validateVideoPixels(result.frame);
        const origin = this.#pending.get(result.ptsUs);
        if (!origin) throw new EngineError('INVALID_PACKET', 'AV1 output has no matching accepted packet timestamp');
        this.#pending.delete(result.ptsUs);
        await this.emit({ stamp: this.stamp, operationId: 'dav1d-output', sourcePacketId: origin.packetId, pts: mediaTime(BigInt(result.ptsUs), timeBase(1n, 1000000n)), durationTicks: origin.durationUs, codecConfigEpoch: origin.codecConfigEpoch }, result.frame, result.frame.data.buffer.byteLength, credit);
        frames++;
      } finally { credit.release(); }
    }
  }
  protected async flush(): Promise<void> { await this.#worker.call('flush'); await this.#receive(); }
  protected async shutdown(): Promise<void> {
    if (!this.#worker) return;
    try { this.#shutdownEvidence = await this.#worker.call('close', {}, [], 1000); }
    finally { this.#worker.terminate(); }
  }
  diagnostics() { return { ...this.snapshot(), environment: this.#environment, shutdown: this.#shutdownEvidence, worker: this.#worker?.snapshot(), codecEofObservation: 'upstream receive merges EAGAIN/EOF; EOS is accepted flush followed by drain-to-empty' }; }
}
