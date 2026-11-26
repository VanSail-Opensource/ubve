import type { OperationContext } from '@ubve/core';
import type { SourceCache } from './source.js';

const ascii = (bytes: Uint8Array, at: number, value: string) => Array.from(value).every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** A complete, single logical Ogg stream may end with a short decoded frame.
 * The terminal granule, not the last Opus/Vorbis packet size, owns that trim. */
export async function oggAudioEnd(cache: SourceCache, codec: string, description: Uint8Array, operation: OperationContext): Promise<bigint | null> {
  const size = cache.source.size;
  if (size < 27) return null;
  const serial = await cache.readValue(0, 27, operation, bytes => ascii(bytes, 0, 'OggS') && bytes[4] === 0 && (bytes[5]! & 2)
    ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(14, true) : null);
  if (serial === null) return null;
  const preSkip = codec === 'opus' && description.length >= 19 && ascii(description, 0, 'OpusHead')
    ? new DataView(description.buffer, description.byteOffset).getUint16(10, true) : 0;
  return cache.readValue(Math.max(0, size - 65307), size, operation, bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = bytes.length - 27; i >= 0; i--) {
      if (!ascii(bytes, i, 'OggS') || bytes[i + 4] !== 0 || !(bytes[i + 5]! & 4) || view.getUint32(i + 14, true) !== serial) continue;
      const count = bytes[i + 26]!, body = i + 27 + count;
      if (body > bytes.length) continue;
      let end = body;
      for (let j = i + 27; j < body; j++) end += bytes[j]!;
      if (end !== bytes.length) continue;
      let crc = 0;
      for (let j = i; j < end; j++) {
        crc ^= (j >= i + 22 && j < i + 26 ? 0 : bytes[j]!) << 24;
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
      }
      if ((crc >>> 0) !== view.getUint32(i + 22, true)) continue;
      const position = view.getBigInt64(i + 6, true) - BigInt(preSkip);
      if (position > 0n && position <= BigInt(Number.MAX_SAFE_INTEGER)) return position;
    }
    return null;
  });
}

/** LAME/Xing frames carry original encoder delay and end padding. Do not
 * generalize guessed bit-rate durations into codec trim evidence. */
export async function mp3AudioEnd(cache: SourceCache, operation: OperationContext): Promise<bigint | null> {
  const size = cache.source.size;
  if (size < 10) return null;
  const start = await cache.readValue(0, 10, operation, bytes => {
    if (!ascii(bytes, 0, 'ID3')) return 0;
    const digits = bytes.subarray(6, 10);
    if (digits.some(n => n > 127)) return size;
    return 10 + digits.reduce((sum, n) => sum * 128 + n, 0) + ((bytes[5]! & 16) !== 0 ? 10 : 0);
  });
  if (start + 36 > size) return null;
  return cache.readValue(start, Math.min(start + 4096, size), operation, bytes => {
    if (bytes[0] !== 255 || (bytes[1]! & 0xe0) !== 0xe0 || (bytes[1]! & 6) !== 2) return null;
    const version = (bytes[1]! >> 3) & 3, mono = (bytes[3]! >> 6) === 3;
    if (version === 1) return null;
    const crc = (bytes[1]! & 1) === 0 ? 2 : 0;
    const xing = 4 + crc + (version === 3 ? mono ? 17 : 32 : mono ? 9 : 17);
    if ((!ascii(bytes, xing, 'Xing') && !ascii(bytes, xing, 'Info')) || xing + 12 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), flags = view.getUint32(xing + 4);
    if (!(flags & 1)) return null;
    const at = xing + 12 + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0);
    if (at + 24 > bytes.length || !['LAME', 'Lavf', 'Lavc'].some(name => ascii(bytes, at, name))) return null;
    const delay = bytes[at + 21]! * 16 + (bytes[at + 22]! >> 4);
    const padding = (bytes[at + 22]! & 15) * 256 + bytes[at + 23]!;
    const count = BigInt(view.getUint32(xing + 8)) * BigInt(version === 3 ? 1152 : 576) - BigInt(delay + padding);
    return count > 0n ? count : null;
  });
}
