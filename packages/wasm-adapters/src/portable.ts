import {
  EngineError, byteLength, knownMetadata, mediaTime, timeBase, unknownMetadata, validateAudioPCM,
  validateMasteringDisplay, validateVideoPixels,
  type AudioPCM, type EffectiveDecoderConfiguration, type EncodedPacket, type ExactRational,
  type MetadataValue, type SessionStamp, type TimeBase, type VideoPixels,
} from '@ubve/core';
import type { MediaPacket } from '@ubve/io-demux';
import { PacketDecoder } from './decoder.js';
import { NO_TIMESTAMP } from './portable-protocol.js';
import type { PortableHeader, PortableKind, PortableOpen, PortablePacket, PortableStep, PortableTaken } from './portable-protocol.js';
import { CodecWorkerClient } from './worker-client.js';

const videoDecoders: Readonly<Record<string, string>> = Object.freeze({ avc: 'h264', hevc: 'hevc', av1: 'libaom-av1', vp8: 'vp8', vp9: 'vp9' });
const audioDecoders: Readonly<Record<string, string>> = Object.freeze({
  aac: 'aac', opus: 'opus', vorbis: 'vorbis', mp3: 'mp3float', flac: 'flac', alac: 'alac',
  'pcm-s16': 'pcm_s16le', 'pcm-s16be': 'pcm_s16be', 'pcm-s24': 'pcm_s24le', 'pcm-s24be': 'pcm_s24be',
  'pcm-f32': 'pcm_f32le', 'pcm-f32be': 'pcm_f32be', ac3: 'ac3', eac3: 'eac3', dts: 'dca',
});
export function supportsPortableCodec(kind: PortableKind, codec: string): boolean {
  return Object.hasOwn(kind === 'video' ? videoDecoders : audioDecoders, codec);
}

interface SharedOptions { readonly codec: string; readonly stamp: SessionStamp; readonly description: Uint8Array; readonly assetBaseUrl: string; }
export interface PortableVideoOptions extends SharedOptions {
  readonly kind: 'video';
  readonly width: number;
  readonly height: number;
  readonly color: VideoColorSpaceInit | null;
}
export interface PortableAudioOptions extends SharedOptions {
  readonly kind: 'audio';
  readonly sampleRate: number;
  readonly channels: number;
  readonly timestampToleranceSamples: number;
  /** Exact audible end when the admitted container exposes it. */
  readonly endSample: bigint | null;
}
type Options = PortableVideoOptions | PortableAudioOptions;
type Origin = Pick<EncodedPacket, 'id' | 'ptsTicks' | 'durationTicks' | 'codecConfigEpoch'> & {
  readonly discardPaddingNs: bigint;
};
const maxAudioFrameBytes = 65536 * 8 * 4;
const maxAssociations = 128;
const signed64 = (n: bigint): boolean => n > NO_TIMESTAMP && n < 2n ** 63n;
const maxI32 = 2147483647n;

function roundedSamples(ticks: bigint, tb: TimeBase, rate: number): bigint {
  const n = ticks * tb.numerator * BigInt(rate) * 2n + tb.denominator;
  const d = 2n * tb.denominator;
  return n / d - (n < 0n && n % d !== 0n ? 1n : 0n);
}

function videoPixels(o: PortableVideoOptions, h: PortableHeader, epoch: number, data: ArrayBuffer): VideoPixels {
  const s = h.shape, w = s[3]!, height = s[4]!, bps = s[2] === 10 ? 2 : 1;
  const row = w * bps, chromaRow = Math.ceil(w / 2) * bps, chromaHeight = Math.ceil(height / 2);
  const lumaBytes = row * height, chromaBytes = chromaRow * chromaHeight;
  const ranges = [null, 'limited', 'full'] as const;
  const primaries = ({ 1: 'bt709', 4: 'bt470m', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020' } as Record<number, string>)[s[9]!];
  const transfer = ({ 1: 'bt709', 6: 'smpte170m', 13: 'iec61966-2-1', 16: 'smpte2084', 18: 'arib-std-b67' } as Record<number, string>)[s[10]!];
  const matrix = ({ 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl', 10: 'bt2020-cl' } as Record<number, string>)[s[11]!];
  const range = ranges[s[12]!];
  const chroma = ['unspecified', 'left', 'center', 'top-left', 'top', 'bottom-left', 'bottom'][s[40]!];
  const observe = <T>(decoder: T | null | undefined, container: T | null | undefined = null): MetadataValue<T> => decoder != null ? knownMetadata(decoder, 'decoder') : container != null ? knownMetadata(container, 'browser-api') : unknownMetadata('Not signaled by this decoder or source');
  const rational = (i: number): ExactRational => ({ numerator: BigInt(s[17 + 2 * i]!), denominator: BigInt(s[18 + 2 * i]!) });
  const mastering = s[16] === 3 ? {
    red: { x: rational(0), y: rational(1) }, green: { x: rational(2), y: rational(3) },
    blue: { x: rational(4), y: rational(5) }, white: { x: rational(6), y: rational(7) },
    minimumLuminance: rational(8), maximumLuminance: rational(9),
  } : null;
  if (mastering) validateMasteringDisplay(mastering);
  const light = s[37] ? { maximumContentLightLevel: s[38] || null, maximumFrameAverageLightLevel: s[39] || null } : null;
  if (light && [s[38]!, s[39]!].some(n => n < 0 || n > 65535)) throw new EngineError('INVALID_PACKET', 'Invalid content-light data');
  const color = {
    primaries: primaries ?? o.color?.primaries ?? null, transfer: transfer ?? o.color?.transfer ?? null, matrix: matrix ?? o.color?.matrix ?? null,
    range: range ?? (o.color?.fullRange == null ? null : o.color.fullRange ? 'full' : 'limited') as 'full' | 'limited' | null,
  };
  const pixels: VideoPixels = {
    kind: 'video', format: bps === 2 ? 'I420P10' : 'I420P8', codedWidth: w, codedHeight: height,
    visibleRect: { x: s[5]!, y: s[6]!, width: w - s[5]! - s[7]!, height: height - s[6]! - s[8]! },
    planes: [{ offsetBytes: 0, strideBytes: row, rows: height }, { offsetBytes: lumaBytes, strideBytes: chromaRow, rows: chromaHeight },
      { offsetBytes: lumaBytes + chromaBytes, strideBytes: chromaRow, rows: chromaHeight }],
    color, data: new Uint8Array(data),
    signalMetadata: { epoch, bitDepth: knownMetadata(s[2]!, 'decoder'), chromaSubsampling: knownMetadata('420', 'decoder'),
      primaries: observe(primaries, color.primaries), transfer: observe(transfer, color.transfer), matrix: observe(matrix, color.matrix),
      range: observe(range, color.range), chromaLocation: observe(chroma === 'unspecified' ? null : chroma),
      masteringDisplay: observe(mastering), contentLightLevel: observe(light) },
  };
  validateVideoPixels(pixels);
  return pixels;
}

const labels = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR', 'TC', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR'] as const;

/** No file or browser-native decoder enters the worker. The source retains
 * the rational clock and gives this adapter one owned selected packet at a time. */
export class PortableDecoder<Payload extends AudioPCM | VideoPixels> extends PacketDecoder<Payload> {
  readonly effective: EffectiveDecoderConfiguration;
  readonly #options: Options;
  readonly #decoder: string;
  #worker: CodecWorkerClient | null = null;
  #runtime: unknown = null;
  #timeBase: TimeBase | null = null;
  #token = 0;
  #origins = new Map<number, Origin>();
  #eof = false;
  #nextAudio: bigint | null = null;
  #layout: readonly string[] | null = null;
  #received = 0;

  private constructor(options: Options) {
    const maxFrame = options.kind === 'video'
      ? (options.width * options.height + 2 * Math.ceil(options.width / 2) * Math.ceil(options.height / 2)) * 2
      : maxAudioFrameBytes;
    super(options.stamp, maxFrame * 4, 4);
    this.#options = options;
    if (!supportsPortableCodec(options.kind, options.codec)) throw new EngineError('UNSUPPORTED_CODEC', `No software decoder for ${options.codec}`);
    this.#decoder = (options.kind === 'video' ? videoDecoders : audioDecoders)[options.codec]!;
    if (options.kind === 'video' && (![options.width, options.height].every(Number.isSafeInteger) ||
        options.width < 1 || options.width > 4096 || options.height < 1 || options.height > 2160)) throw new EngineError('UNSUPPORTED_PROFILE', 'Software video geometry exceeds 4096×2160');
    this.effective = { codecId: options.codec, workers: 1, sharedMemory: false,
      outputLayout: options.kind === 'video' ? 'I420P8-or-I420P10' : 'interleaved-integer-or-float-pcm',
      resources: { explicitInputBudgetEnforced: true, explicitOutputBudgetEnforced: true, internalHeap: 'hard-cap',
        internalHeapLimitBytes: byteLength(options.kind === 'video' ? 512 * 1024 ** 2 : 64 * 1024 ** 2), internalHeapEstimateBytes: null,
        runtimeLifetime: 'session', completeShutdown: 'not-established' } };
  }

  static create(options: PortableVideoOptions): Promise<PortableDecoder<VideoPixels>>;
  static create(options: PortableAudioOptions): Promise<PortableDecoder<AudioPCM>>;
  static async create(options: Options): Promise<PortableDecoder<VideoPixels> | PortableDecoder<AudioPCM>> {
    const decoder = options.kind === 'video' ? new PortableDecoder<VideoPixels>(options) : new PortableDecoder<AudioPCM>(options);
    try { await decoder.#openRuntime(); return decoder; }
    catch (error) { await decoder.dispose().catch(() => undefined); throw error; }
  }

  protected async reopen(): Promise<void> { await this.#openRuntime(); }

  async #openRuntime(): Promise<void> {
    const base = new URL(this.#options.assetBaseUrl, globalThis.location?.href ?? 'http://localhost/');
    this.#worker = new CodecWorkerClient(new URL('portable/portable.worker.js', base), 'module');
    this.#runtime = await this.#worker.call('init', this.#options.kind, [], 10000);
    this.#timeBase = null; this.#token = 0; this.#origins.clear(); this.#eof = false; this.#nextAudio = null; this.#layout = null; this.#received = 0;
  }

  protected async decode(packet: EncodedPacket, consumed: () => void): Promise<void> {
    const worker = this.#worker!, o = this.#options, tb = packet.timeBase;
    if (tb.numerator > maxI32 || tb.denominator > maxI32 ||
        ![packet.ptsTicks, packet.dtsTicks, packet.durationTicks].every(n => n === null || signed64(n))) throw new EngineError('UNSUPPORTED_PROFILE', 'Software decoder timing exceeds its exact FFmpeg ABI');
    if (!this.#timeBase) {
      const config: PortableOpen = { kind: o.kind, decoder: this.#decoder, description: o.description,
        width: o.kind === 'video' ? o.width : 0, height: o.kind === 'video' ? o.height : 0,
        channels: o.kind === 'audio' ? o.channels : 0, sampleRate: o.kind === 'audio' ? o.sampleRate : 0,
        tb: [Number(tb.numerator), Number(tb.denominator)] };
      await worker.call('open', config);
      this.#timeBase = tb;
    } else if (tb.numerator !== this.#timeBase.numerator || tb.denominator !== this.#timeBase.denominator) {
      throw new EngineError('UNSUPPORTED_PROFILE', 'Software decoder time base changed within an epoch');
    }
    this.ensureActive();
    const token = ++this.#token;
    if (token > Number(maxI32)) throw new EngineError('UNSUPPORTED_PROFILE', 'Software packet token space exceeded');
    this.#origins.set(token, { id: packet.id, ptsTicks: packet.ptsTicks, durationTicks: packet.durationTicks,
      codecConfigEpoch: packet.codecConfigEpoch, discardPaddingNs: (packet as Partial<MediaPacket>).discardPaddingNs ?? 0n });
    this.#origins.delete(token - maxAssociations);
    const bytes = packet.bytes.borrow();
    const data = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    const command: PortablePacket = { data, token, pts: packet.ptsTicks, dts: packet.dtsTicks ?? NO_TIMESTAMP,
      duration: packet.durationTicks ?? 0n, key: packet.recovery === 'key' };
    let step = await worker.call<PortableStep>('submit', command, [data.buffer as ArrayBuffer]);
    while (!step.accepted) {
      if (!step.output) throw new EngineError('INVALID_PACKET', 'Software decoder could not progress with its retained input');
      await this.#receive(step);
      this.ensureActive();
      step = await worker.call<PortableStep>('retry');
    }
    this.ensureActive(); consumed();
    await this.#receive(step);
  }

  async #receive(step: Pick<PortableStep, 'output' | 'eof'>): Promise<void> {
    while (step.output) {
      const h = step.output, origin = this.#origins.get(h.shape[1]!);
      if (!origin) throw new EngineError('UNSUPPORTED_PROFILE', 'Software output has no known source packet association');
      const credit = await this.reserveOutput(h.bytes);
      try {
        const taken = await this.#worker!.call<PortableTaken>('take', h.bytes);
        if (!(taken.data instanceof ArrayBuffer) || taken.data.byteLength !== credit.bytes) throw new EngineError('INVALID_PACKET', 'Software output did not match its reserved shape');
        const stamp = { stamp: this.stamp, operationId: 'software-output', sourcePacketId: origin.id, codecConfigEpoch: origin.codecConfigEpoch };
        if (this.#options.kind === 'video') {
          const pixels = videoPixels(this.#options, h, origin.codecConfigEpoch, taken.data);
          const pts = mediaTime(h.pts === NO_TIMESTAMP ? origin.ptsTicks : h.pts, this.#timeBase!);
          const durationTicks = h.duration > 0n ? h.duration : origin.durationTicks;
          await this.emit({ ...stamp, pts, durationTicks }, pixels as Payload, h.bytes, credit);
        } else {
          const block = this.#audio(this.#options, h, origin, taken.data);
          if (block) await this.emit({ ...stamp, pts: mediaTime(block.start, timeBase(1n, BigInt(block.pcm.sampleRate))),
            durationTicks: BigInt(block.pcm.frames) }, block.pcm as Payload, h.bytes, credit);
        }
        this.#received++;
        step = taken;
      } finally { credit.release(); }
    }
    this.#eof = step.eof;
  }

  #audio(o: PortableAudioOptions, h: PortableHeader, origin: Origin, data: ArrayBuffer): { start: bigint; pcm: AudioPCM } | null {
    const s = h.shape, channels = o.channels, frames = s[5]!, kind = s[2]!, rate = o.sampleRate;
    const channelLabels = Array.from({ length: channels }, (_, i) => labels[s[9 + i]!] ?? `channel-${i + 1}`);
    if (this.#layout && channelLabels.some((name, i) => name !== this.#layout![i])) throw new EngineError('UNSUPPORTED_PROFILE', 'Software audio channel order changed within an epoch');
    this.#layout = channelLabels;
    const observed = roundedSamples(h.pts === NO_TIMESTAMP ? origin.ptsTicks : h.pts, this.#timeBase!, rate);
    let start = observed;
    if (this.#nextAudio !== null) {
      const delta = observed - this.#nextAudio, tolerance = BigInt(o.timestampToleranceSamples);
      if (delta < -tolerance || delta > tolerance) throw new EngineError('UNSUPPORTED_PROFILE', 'Software audio timeline discontinuity', 'caller-fix',
        { observed: String(observed), expected: String(this.#nextAudio) });
      start = this.#nextAudio;
    }
    this.#nextAudio = start + BigInt(frames);
    // Matroska timestamps already include CodecDelay. Trim explicit discard
    // padding and provider skip side-data here, but never apply delay twice.
    const pad = roundedSamples(origin.discardPaddingNs, timeBase(1n, 1000000000n), rate);
    const head = Math.max(s[17]!, Number(pad < 0n ? -pad : 0n));
    let tail = Math.max(s[18]!, Number(pad > 0n ? pad : 0n));
    if (o.endSample !== null && this.#nextAudio > o.endSample) tail = Math.max(tail, Number(this.#nextAudio - o.endSample));
    if (!Number.isSafeInteger(head) || !Number.isSafeInteger(tail) || head < 0 || tail < 0 ||
        Math.abs(Number(pad)) > frames) throw new EngineError('UNSUPPORTED_PROFILE', 'Audio trim exceeds its decoded frame');
    const count = frames - head - tail;
    if (count <= 0) return null;
    const from = head * channels, to = (head + count) * channels;
    const scalar = kind <= 2 ? new Int32Array(data) : null;
    const lossless = o.codec === 'flac' || o.codec === 'alac' || o.codec.startsWith('pcm-s');
    let pcm: AudioPCM;
    if (scalar && lossless) {
      const validBits = kind === 1 ? 16 : o.codec.startsWith('pcm-s24') ? 24 : s[7];
      if (validBits !== 16 && validBits !== 24) throw new EngineError('UNSUPPORTED_PROFILE', 'Lossless track precision is outside the admitted 16/24-bit profiles');
      const slice = scalar.subarray(from, to);
      if (slice.some(value => (value & (validBits === 16 ? 65535 : 255)) !== 0)) throw new EngineError('INVALID_PACKET', 'Lossless software audio returned invalid precision');
      pcm = { kind: 'audio', format: 's32-interleaved', alignment: 'most-significant', provenance: 'exact-decoder-pcm',
        frames: count, sampleRate: rate, channelLabels, validBits, planes: [slice] };
    } else {
      const floats = new Float32Array(data);
      if (scalar) for (let i = from; i < to; i++) floats[i] = scalar[i]! / 2147483648;
      const slice = floats.subarray(from, to);
      if (slice.some(value => !Number.isFinite(value))) throw new EngineError('INVALID_PACKET', 'Non-finite software PCM');
      pcm = { kind: 'audio', format: 'f32-interleaved', frames: count, sampleRate: rate, channelLabels, planes: [slice] };
    }
    validateAudioPCM(pcm);
    return { start: start + BigInt(head), pcm };
  }

  protected async flush(): Promise<void> {
    if (!this.#timeBase) return;
    let step = await this.#worker!.call<PortableStep>('flush');
    while (!step.accepted) {
      if (!step.output) throw new EngineError('INVALID_PACKET', 'Software EOF send made no progress');
      await this.#receive(step);
      this.ensureActive();
      step = await this.#worker!.call<PortableStep>('flush');
    }
    await this.#receive(step);
    if (!this.#eof) throw new EngineError('INVALID_PACKET', 'Software decoder did not acknowledge codec EOF');
  }

  protected async shutdown(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    this.#worker = null;
    try { await worker.call('close', {}, [], 1000); }
    finally { this.#origins.clear(); worker.terminate(); }
  }
  diagnostics() { return { ...this.snapshot(), decoder: this.#decoder, environment: this.#runtime,
    worker: this.#worker?.snapshot() ?? null, decoded: this.#received, codecEofObserved: this.#eof, channelLabels: this.#layout }; }
}
