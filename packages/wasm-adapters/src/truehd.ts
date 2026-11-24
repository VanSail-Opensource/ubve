import { EngineError, byteLength, mediaTime, timeBase, validateAudioPCM, type EffectiveDecoderConfiguration, type EncodedPacket, type IntegerAudioPCM, type SessionStamp } from '@ubve/core';
import { packetSeconds } from '@ubve/io-demux';
import { PacketDecoder } from './decoder.js';
import { CodecWorkerClient } from './worker-client.js';

export interface TrueHdPacket { readonly data: Uint8Array; readonly timestampSamples: number; }
interface DecodedChunk { pcmData: ArrayBuffer; format: string; channels: number; sampleRate: number; sampleCount: number; pts: number | null; }
export interface IntegerPcmBlock { readonly data: Int32Array; readonly firstSample: number; readonly frames: number; readonly sampleRate: number; readonly channels: number; }
export interface TrueHdOptions { readonly sampleRate: number; readonly channelLabels: readonly string[]; readonly assetBaseUrl?: string; readonly timestampResolutionSeconds?: number; }

/** Owns the exact pinned FFmpeg TrueHD worker directly, including awaited close. */
export class TrueHdPacketCodec {
  readonly options: TrueHdOptions;
  #worker: CodecWorkerClient; #context = 0; #nextSample: number | null = null; #closed = false;
  private constructor(options: TrueHdOptions) {
    if (![44100, 48000, 88200, 96000, 176400, 192000].includes(options.sampleRate) || options.channelLabels.length < 1 || options.channelLabels.length > 8) throw new EngineError('UNSUPPORTED_CODEC', 'TrueHD sample rate/channel profile is unavailable');
    this.options = options;
    this.#worker = new CodecWorkerClient(new URL('truehd.worker.js', new URL(options.assetBaseUrl ?? '/vendor/', globalThis.location?.href ?? 'http://localhost/')));
  }
  static async create(options: TrueHdOptions): Promise<TrueHdPacketCodec> {
    const codec = new TrueHdPacketCodec(options);
    try { const result = await codec.#worker.call<{ ctx: number }>('init-decoder', {}, [], 10000); if (!Number.isSafeInteger(result.ctx) || result.ctx <= 0) throw new EngineError('INVALID_PACKET', 'TrueHD decoder returned an invalid context'); codec.#context = result.ctx; return codec; }
    catch (error) { codec.#worker.terminate(); throw error; }
  }
  async decode(packets: readonly TrueHdPacket[]): Promise<IntegerPcmBlock[]> {
    if (this.#closed) throw new EngineError('DISPOSED', 'TrueHD codec closed');
    if (packets.length < 1 || packets.length > 64 || packets.reduce((sum, p) => sum + p.data.length, 0) > 4 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'TrueHD batch exceeds its command bounds');
    const inputs = packets.map(packet => { if (!Number.isSafeInteger(packet.timestampSamples)) throw new EngineError('INVALID_ARGUMENT', 'Audio timestamp is outside exact sample range'); return { encodedData: packet.data.slice().buffer, timestamp: packet.timestampSamples }; });
    const result = await this.#worker.call<{ chunks: DecodedChunk[] }>('decode', { ctx: this.#context, packets: inputs }, inputs.map(packet => packet.encodedData));
    if (!Array.isArray(result.chunks) || result.chunks.length > 4096) throw new EngineError('ITEM_TOO_LARGE', 'TrueHD output count exceeds one bounded command');
    const blocks: IntegerPcmBlock[] = []; let outputBytes = 0;
    for (const chunk of result.chunks) {
      if (chunk.sampleRate !== this.options.sampleRate || chunk.channels !== this.options.channelLabels.length || !Number.isSafeInteger(chunk.sampleCount) || chunk.sampleCount < 1 || chunk.sampleCount > 16384) throw new EngineError('UNSUPPORTED_PROFILE', 'TrueHD output configuration changed or exceeds admission');
      const scalars = chunk.sampleCount * chunk.channels, planar = chunk.format.endsWith('-planar');
      const width = chunk.format.startsWith('s32') ? 4 : chunk.format.startsWith('s16') ? 2 : 0;
      if (!width || chunk.pcmData.byteLength !== scalars * width) throw new EngineError('UNSUPPORTED_PROFILE', 'Exact integer TrueHD output is unavailable');
      outputBytes += scalars * 4; if (outputBytes > 4 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'TrueHD decoded output exceeds 4 MiB command bound');
      const data = new Int32Array(scalars), source = width === 4 ? new Int32Array(chunk.pcmData) : new Int16Array(chunk.pcmData);
      for (let frame = 0; frame < chunk.sampleCount; frame++) for (let channel = 0; channel < chunk.channels; channel++) {
        const value = source[planar ? channel * chunk.sampleCount + frame : frame * chunk.channels + channel]!;
        data[frame * chunk.channels + channel] = width === 4 ? value : value * 65536;
      }
      // Timestamp quantization is explicit. A gap outside one source clock tick is never flattened.
      const observed = chunk.pts ?? this.#nextSample;
      if (observed === null || !Number.isSafeInteger(observed)) throw new EngineError('INVALID_PACKET', 'TrueHD output lacks an exact starting sample');
      const tolerance = Math.ceil((this.options.timestampResolutionSeconds ?? 0) * chunk.sampleRate);
      if (this.#nextSample !== null && Math.abs(observed - this.#nextSample) > tolerance) throw new EngineError('UNSUPPORTED_PROFILE', 'TrueHD timeline discontinuity requires an explicit new audio epoch');
      const firstSample = this.#nextSample ?? observed; this.#nextSample = firstSample + chunk.sampleCount;
      blocks.push({ data, firstSample, frames: chunk.sampleCount, sampleRate: chunk.sampleRate, channels: chunk.channels });
    }
    return blocks;
  }
  async flush(): Promise<void> { if (!this.#closed) await this.#worker.call('flush-decoder', { ctx: this.#context }); }
  async dispose(): Promise<void> { if (this.#closed) return; this.#closed = true; try { if (this.#context) await this.#worker.call('close-decoder', { ctx: this.#context }, [], 1000); } finally { this.#worker.terminate(); } }
  diagnostics() { return { candidate: '@mediabunny/truehd@1.66.4-owned-worker-protocol', exactFormat: 's32-interleaved-msb', channelIdentity: 'caller-supplied; physical-output-unverified', sourceTimestampResolutionSeconds: this.options.timestampResolutionSeconds ?? 0, nextSample: this.#nextSample, worker: this.#worker.snapshot() }; }
}

export interface TrueHdDecoderOptions extends TrueHdOptions { readonly stamp: SessionStamp; readonly outputFrames?: number; }
export class TrueHdDecoder extends PacketDecoder<IntegerAudioPCM> {
  readonly effective: EffectiveDecoderConfiguration;
  readonly options: TrueHdDecoderOptions;
  #codec!: TrueHdPacketCodec; #pending: TrueHdPacket[] = []; #pendingBytes = 0; #lastPacket: EncodedPacket | null = null;
  #aggregate: Int32Array; #aggregateFrames = 0; #firstSample = 0;
  private constructor(options: TrueHdDecoderOptions) {
    super(options.stamp, 4 * 1024 * 1024, options.outputFrames ?? 16, 4 * 1024 * 1024); this.options = options;
    this.#aggregate = new Int32Array(1024 * options.channelLabels.length);
    this.effective = { codecId: 'truehd', workers: 1, sharedMemory: false, outputLayout: 's32-interleaved', resources: { explicitInputBudgetEnforced: true, explicitOutputBudgetEnforced: true, internalHeap: 'opaque', internalHeapLimitBytes: null, internalHeapEstimateBytes: byteLength(32 * 1024 * 1024), runtimeLifetime: 'session', completeShutdown: 'not-established' } };
  }
  static async create(options: TrueHdDecoderOptions): Promise<TrueHdDecoder> { const decoder = new TrueHdDecoder(options); try { await decoder.reopen(); return decoder; } catch (error) { await decoder.dispose(); throw error; } }
  protected async reopen(): Promise<void> { this.#codec = await TrueHdPacketCodec.create(this.options); this.#pending = []; this.#pendingBytes = 0; this.#aggregateFrames = 0; this.#lastPacket = null; }
  protected async decode(packet: EncodedPacket, consumed: () => void): Promise<void> {
    const source = packet.bytes.borrow(), time = packetSeconds(packet);
    if (source.length > 4 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'TrueHD packet exceeds batch limit');
    if (this.#pendingBytes + source.length > 4 * 1024 * 1024) await this.#decodePending();
    this.#pending.push({ data: source.slice(), timestampSamples: Math.round(time.timestamp * this.options.sampleRate) }); this.#pendingBytes += source.length; this.#lastPacket = packet; consumed();
    const accessUnitFrames = 40 * this.options.sampleRate / (this.options.sampleRate % 44100 === 0 ? 44100 : 48000);
    if (this.#pending.length * accessUnitFrames >= 1024 || this.#pending.length >= 64) await this.#decodePending();
  }
  async #decodePending(): Promise<void> {
    if (!this.#pending.length) return; const packets = this.#pending; this.#pending = []; this.#pendingBytes = 0;
    const blocks = await this.#codec.decode(packets);
    for (const block of blocks) {
      let offset = 0;
      while (offset < block.frames) {
        if (this.#aggregateFrames === 0) this.#firstSample = block.firstSample + offset;
        else if (this.#firstSample + this.#aggregateFrames !== block.firstSample + offset) throw new EngineError('UNSUPPORTED_PROFILE', 'PCM aggregation cannot cross a timeline gap');
        const count = Math.min(1024 - this.#aggregateFrames, block.frames - offset), channels = block.channels;
        this.#aggregate.set(block.data.subarray(offset * channels, (offset + count) * channels), this.#aggregateFrames * channels); this.#aggregateFrames += count; offset += count;
        if (this.#aggregateFrames === 1024) await this.#emitAggregate();
      }
    }
  }
  async #emitAggregate(): Promise<void> {
    if (!this.#aggregateFrames || !this.#lastPacket) return;
    const data = this.#aggregate.slice(0, this.#aggregateFrames * this.options.channelLabels.length);
    const pcm: IntegerAudioPCM = { kind: 'audio', format: 's32-interleaved', sampleRate: this.options.sampleRate, frames: this.#aggregateFrames, channelLabels: this.options.channelLabels, planes: [data], validBits: 24, alignment: 'most-significant', provenance: 'exact-decoder-pcm' };
    validateAudioPCM(pcm);
    await this.emit({ stamp: this.stamp, operationId: 'truehd-output', sourcePacketId: this.#lastPacket.id, pts: mediaTime(BigInt(this.#firstSample), timeBase(1n, BigInt(this.options.sampleRate))), durationTicks: BigInt(this.#aggregateFrames), codecConfigEpoch: this.#lastPacket.codecConfigEpoch }, pcm, data.byteLength);
    this.#aggregateFrames = 0;
  }
  protected async flush(): Promise<void> { await this.#decodePending(); await this.#codec.flush(); await this.#emitAggregate(); }
  protected async shutdown(): Promise<void> { this.#pending = []; this.#pendingBytes = 0; this.#aggregateFrames = 0; if (this.#codec) await this.#codec.dispose(); }
  diagnostics() { return { ...this.snapshot(), bufferedInputBytes: this.#pendingBytes, aggregateFrames: this.#aggregateFrames, codec: this.#codec?.diagnostics() }; }
}

/** This power-of-two conversion preserves normalized 24-bit PCM exactly. */
export function integerPcmToFloat(pcm: IntegerAudioPCM): Float32Array {
  if (pcm.format !== 's32-interleaved' || pcm.alignment !== 'most-significant' || pcm.validBits > 24) throw new EngineError('UNSUPPORTED_PROFILE', 'Float conversion requires admitted interleaved 24-bit-or-less MSB PCM');
  const source = pcm.planes[0]!, output = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) output[i] = source[i]! / 2147483648;
  return output;
}
