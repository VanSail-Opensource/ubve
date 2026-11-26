import { EngineError, type OperationContext } from '@ubve/core';
import type { SourceCache } from './source.js';

export type FilePcmCodec = 'pcm-s16' | 'pcm-s16be' | 'pcm-s24' | 'pcm-s24be' | 'pcm-f32' | 'pcm-f32be';
export interface PcmFile {
  readonly container: 'aiff' | 'caf';
  readonly mime: string;
  readonly codec: FilePcmCodec;
  readonly channels: number;
  readonly rate: number;
  readonly frameBytes: number;
  readonly frames: number;
  readonly start: number;
}

type Samples = Pick<PcmFile, 'rate' | 'channels' | 'codec' | 'frameBytes'>;
const text = new TextDecoder('latin1');
const code = (bytes: Uint8Array, start = 0) => text.decode(bytes.subarray(start, start + 4));
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const invalid = (message: string): never => { throw new EngineError('INVALID_MEDIA', message); };
const unsupported = (message: string): never => { throw new EngineError('UNSUPPORTED_PROFILE', message, 'caller-fix'); };
const MAX_CHUNKS = 4096;

function samples(rate: number, channels: number, bits: number, floating: boolean, littleEndian: boolean): Samples {
  if (!Number.isSafeInteger(rate) || rate < 8000 || rate > 192000 || channels < 1 || channels > 8) {
    return unsupported('PCM container requires 1–8 channels at an integral 8–192 kHz sample rate');
  }
  if (floating ? bits !== 32 : bits !== 16 && bits !== 24) return unsupported('PCM container admits signed 16/24-bit or float32 samples');
  const codec: FilePcmCodec = floating ? (littleEndian ? 'pcm-f32' : 'pcm-f32be') : bits === 16 ?
    (littleEndian ? 'pcm-s16' : 'pcm-s16be') : (littleEndian ? 'pcm-s24' : 'pcm-s24be');
  return { codec, rate, channels, frameBytes: channels * (bits / 8) };
}

function extendedRate(bytes: DataView, at: number): number {
  const exponent = bytes.getUint16(at);
  const shift = exponent - 16383 - 63, significand = bytes.getBigUint64(at + 2);
  if (exponent >= 0x7fff || shift < -64 || shift > 0 || significand < 2n ** 63n) return unsupported('Unsupported AIFF extended sample rate');
  const divisor = 2n ** BigInt(-shift);
  if (significand % divisor) return unsupported('Fractional AIFF sample rate');
  return Number(significand / divisor);
}

async function aiff(cache: SourceCache, operation: OperationContext, end: number, compressed: boolean): Promise<PcmFile> {
  const { size } = cache.source;
  if (end !== size || end < 12) return invalid('AIFF FORM length does not match its source');
  let format: Samples | null = null, data: { start: number; bytes: number } | null = null, frames = 0, version = false;
  let chunks = 0;
  for (let at = 12; at < end;) {
    if (++chunks > MAX_CHUNKS) throw new EngineError('ITEM_TOO_LARGE', 'AIFF chunk count exceeds the admitted limit');
    if (end - at < 8) return invalid('Truncated AIFF chunk');
    const { kind, length } = await cache.readValue(at, at + 8, operation, bytes => ({ kind: code(bytes), length: view(bytes).getUint32(4) }));
    const start = at + 8, padded = length + length % 2;
    if (padded > end - start) return invalid('AIFF chunk escapes its FORM');
    if (kind === 'COMM') {
      if (format || length < (compressed ? 23 : 18)) return invalid('Invalid or duplicate AIFF common chunk');
      const common = await cache.readValue(start, start + (compressed ? 23 : 18), operation, bytes => {
        const v = view(bytes), channels = v.getUint16(0), bits = v.getUint16(6), rate = extendedRate(v, 8);
        const compression = compressed ? code(bytes, 18) : 'NONE';
        if (compressed && 23 + bytes[22]! > length) return invalid('Truncated AIFC compression name');
        if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32'].includes(compression)) return unsupported('Compressed AIFC codec is not admitted');
        return { format: samples(rate, channels, bits, compression.toLowerCase() === 'fl32', compression === 'sowt'), frames: v.getUint32(2) };
      });
      format = common.format; frames = common.frames;
    } else if (kind === 'FVER' && compressed) {
      if (version || length !== 4) return invalid('Invalid or duplicate AIFC version chunk');
      version = await cache.readValue(start, start + 4, operation, bytes => view(bytes).getUint32(0) === 0xa2805140);
      if (!version) return unsupported('Unsupported AIFC version');
    } else if (kind === 'SSND') {
      if (data || length < 8) return invalid('Invalid or duplicate AIFF sound chunk');
      data = await cache.readValue(start, start + 8, operation, bytes => {
        const v = view(bytes), offset = v.getUint32(0);
        if (offset > length - 8) return invalid('AIFF sound-data offset escapes its chunk');
        return { start: start + 8 + offset, bytes: length - 8 - offset };
      });
    }
    at = start + padded;
  }
  if (!format || !data || (compressed && !version) || frames < 1 || frames * format.frameBytes !== data.bytes) {
    return invalid('AIFF common and sound chunks do not describe the same exact PCM payload');
  }
  return { container: 'aiff', mime: 'audio/aiff', ...format, frames, start: data.start };
}

async function caf(cache: SourceCache, operation: OperationContext, version: number, flags: number): Promise<PcmFile> {
  const { size } = cache.source;
  if (version !== 1 || flags !== 0) return unsupported('Unsupported CAF header version or flags');
  let format: (Samples & { packetBytes: number }) | null = null, data: { start: number; bytes: number } | null = null, chunks = 0;
  for (let at = 8; at < size;) {
    if (++chunks > MAX_CHUNKS) throw new EngineError('ITEM_TOO_LARGE', 'CAF chunk count exceeds the admitted limit');
    if (size - at < 12) return invalid('Truncated CAF chunk');
    const { kind, declared } = await cache.readValue(at, at + 12, operation, bytes => ({ kind: code(bytes), declared: view(bytes).getBigInt64(4) }));
    const start = at + 12, available = size - start;
    if ((declared < 0n && !(declared === -1n && kind === 'data')) || declared > BigInt(available)) return invalid('CAF chunk escapes its source');
    const length = declared === -1n ? available : Number(declared);
    if (at === 8 && kind !== 'desc') return invalid('The first CAF chunk must describe the audio');
    if (kind === 'desc') {
      if (format || length !== 32) return invalid('Invalid or duplicate CAF audio description');
      format = await cache.readValue(start, start + 32, operation, bytes => {
        const v = view(bytes), packing = v.getUint32(12), packetBytes = v.getUint32(16), framesPerPacket = v.getUint32(20);
        if (code(bytes, 8) !== 'lpcm' || packing > 3) return unsupported('CAF admits only interleaved linear PCM');
        const sample = samples(v.getFloat64(0), v.getUint32(24), v.getUint32(28), packing % 2 !== 0, packing >= 2);
        if (framesPerPacket !== 1 || sample.frameBytes !== packetBytes) return unsupported('CAF PCM packets are not tightly packed');
        return { ...sample, packetBytes };
      });
    } else if (kind === 'data') {
      if (data || length < 4) return invalid('Invalid or duplicate CAF data chunk');
      // This word versions dependent metadata. It is not a playback edit list.
      data = { start: start + 4, bytes: length - 4 };
    }
    at = start + length;
  }
  if (!format || !data || data.bytes < 1 || data.bytes % format.packetBytes) return invalid('CAF does not contain complete PCM packets');
  const { packetBytes: _packetBytes, ...sample } = format;
  return { container: 'caf', mime: 'audio/x-caf', ...sample, frames: data.bytes / sample.frameBytes, start: data.start };
}

/** Recognize by bytes, not filename. Chunk headers are bounded reads and audio is not materialized here. */
export async function openPcmFile(cache: SourceCache, operation: OperationContext): Promise<PcmFile | null> {
  if (cache.source.size < 12) return null;
  const header = await cache.readValue(0, 12, operation, bytes => ({ kind: code(bytes), form: code(bytes, 8), v32: view(bytes).getUint32(4) }));
  if (header.kind === 'FORM' && (header.form === 'AIFF' || header.form === 'AIFC')) return aiff(cache, operation, header.v32 + 8, header.form === 'AIFC');
  if (header.kind === 'caff') return caf(cache, operation, Math.floor(header.v32 / 65536), header.v32 % 65536);
  return null;
}
