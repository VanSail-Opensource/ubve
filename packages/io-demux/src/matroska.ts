import { EngineError, type OperationContext } from '@ubve/core';
import type { SourceCache } from './source.js';

interface Element { id: number; start: number; data: number; end: number; unknown: boolean; }
export interface MatroskaTrack {
  number: number; uid: string; type: 'video' | 'audio' | 'subtitle'; codecId: string; codecPrivate: Uint8Array;
  language: string; name: string | null; default: boolean; forced: boolean; defaultDurationNs: bigint | null;
  codecDelayNs: bigint; seekPreRollNs: bigint; video: Record<string, number>; audio: Record<string, number>;
  color: Readonly<Record<string, number>>; mastering: Readonly<Record<string, number>>;
}
export interface MediaAttachment { id: string; name: string; mimeType: string; data: Uint8Array; }
export interface MatroskaMetadata { timecodeScaleNs: bigint; duration: number | null; tracks: MatroskaTrack[]; attachments: MediaAttachment[]; segmentStart: number; segmentEnd: number; firstCluster: number; cues: { timeNs: bigint; position: number; track: number }[]; }
export interface MatroskaPacket { trackNumber: number; data: Uint8Array; ptsNs: bigint; durationNs: bigint | null; key: boolean; sourceStart: number; discardPaddingNs: bigint; }
const text = new TextDecoder();
const bad = (message: string): never => { throw new EngineError('INVALID_PACKET', message); };

/** EBML VINT arithmetic never truncates a 64-bit source field. */
export function readVint(bytes: Uint8Array, offset = 0, keepMarker = false): { value: bigint; length: number; unknown: boolean } {
  const first = bytes[offset]; if (!first) return bad('Invalid/truncated EBML integer');
  let length = 1, marker = 128;
  while (!(first & marker)) { length++; marker /= 2; }
  if (length > 8 || offset + length > bytes.length || (keepMarker && length > 4)) return bad('EBML integer exceeds bounds');
  let value = BigInt(keepMarker ? first : first & (marker - 1));
  for (let i = 1; i < length; i++) value = value * 256n + BigInt(bytes[offset + i]!);
  return { value, length, unknown: !keepMarker && value === (1n << BigInt(length * 7)) - 1n };
}
function integer(bytes: Uint8Array, signed = false): bigint {
  if (bytes.length < 1 || bytes.length > 8) return bad('EBML integer has invalid width');
  let value = 0n; for (const byte of bytes) value = value * 256n + BigInt(byte);
  return signed && bytes[0]! >= 128 ? value - (1n << BigInt(bytes.length * 8)) : value;
}
function safe(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return bad('EBML value exceeds exact address space'); return Number(value); }
function float(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = bytes.length === 4 ? view.getFloat32(0) : bytes.length === 8 ? view.getFloat64(0) : NaN;
  if (!Number.isFinite(value)) return bad('Invalid EBML floating value'); return value;
}
function children(bytes: Uint8Array): { id: number; data: Uint8Array; offset: number }[] {
  const result = []; let offset = 0;
  while (offset < bytes.length) {
    const id = readVint(bytes, offset, true), size = readVint(bytes, offset + id.length);
    const start = offset + id.length + size.length, end = start + safe(size.value);
    if (size.unknown || end > bytes.length) return bad('Nested EBML element exceeds parent');
    result.push({ id: Number(id.value), data: bytes.subarray(start, end), offset: start }); offset = end;
    if (result.length > 262144) throw new EngineError('ITEM_TOO_LARGE', 'EBML metadata entry count exceeded');
  }
  return result;
}
async function element(cache: SourceCache, position: number, parentEnd: number, operation: OperationContext): Promise<Element> {
  return cache.readValue(position, Math.min(parentEnd, position + 12), operation, bytes => {
  const id = readVint(bytes, 0, true), size = readVint(bytes, id.length);
  const data = position + id.length + size.length;
  const end = size.unknown ? parentEnd : safe(BigInt(data) + size.value);
  if (end > parentEnd || end < data) return bad('EBML element escapes parent');
  return { id: Number(id.value), start: position, data, end, unknown: size.unknown };
  });
}
async function payload(cache: SourceCache, entry: Element, operation: OperationContext, limit = 16 * 1024 * 1024): Promise<Uint8Array> {
  if (entry.end - entry.data > limit) throw new EngineError('ITEM_TOO_LARGE', 'Matroska metadata exceeds its byte limit');
  return cache.read(entry.data, entry.end, operation);
}

function parseTrack(bytes: Uint8Array): MatroskaTrack {
  const result: MatroskaTrack = { number: 0, uid: '', type: 'subtitle', codecId: '', codecPrivate: new Uint8Array(), language: 'und', name: null, default: true, forced: false, defaultDurationNs: null, codecDelayNs: 0n, seekPreRollNs: 0n, video: {}, audio: {}, color: {}, mastering: {} };
  for (const entry of children(bytes)) {
    switch (entry.id) {
      case 0xd7: result.number = safe(integer(entry.data)); break;
      case 0x73c5: result.uid = integer(entry.data).toString(); break;
      case 0x83: { const type = safe(integer(entry.data)); if (![1, 2, 17].includes(type)) return bad('Unsupported Matroska track kind'); result.type = type === 1 ? 'video' : type === 2 ? 'audio' : 'subtitle'; break; }
      case 0x86: result.codecId = text.decode(entry.data); break;
      case 0x63a2: if (entry.data.length > 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'Codec private exceeds 1 MiB'); result.codecPrivate = entry.data; break;
      case 0x22b59c: case 0x22b59d: result.language = text.decode(entry.data); break;
      case 0x536e: result.name = text.decode(entry.data); break;
      case 0x88: result.default = integer(entry.data) !== 0n; break;
      case 0x55aa: result.forced = integer(entry.data) !== 0n; break;
      case 0x23e383: result.defaultDurationNs = integer(entry.data); break;
      case 0x56aa: result.codecDelayNs = integer(entry.data); break;
      case 0x56bb: result.seekPreRollNs = integer(entry.data); break;
      case 0x6d80: throw new EngineError('UNSUPPORTED_CODEC', 'Matroska content encoding/encryption is outside this profile');
      case 0xe0: for (const video of children(entry.data)) {
        const names: Record<number, string> = { 0xb0: 'width', 0xba: 'height', 0x54b0: 'displayWidth', 0x54ba: 'displayHeight', 0x9a: 'interlaced', 0x53b8: 'stereoMode' };
        if (names[video.id]) result.video[names[video.id]!] = safe(integer(video.data));
        if (video.id === 0x55b0) {
          const color: Record<string, number> = {}, mastering: Record<string, number> = {};
          const colorNames: Record<number, string> = { 0x55b1: 'matrix', 0x55b2: 'bitsPerChannel', 0x55b3: 'chromaSubsamplingHorz', 0x55b4: 'chromaSubsamplingVert', 0x55b7: 'chromaSitingHorz', 0x55b8: 'chromaSitingVert', 0x55b9: 'range', 0x55ba: 'transfer', 0x55bb: 'primaries', 0x55bc: 'maxCLL', 0x55bd: 'maxFALL' };
          for (const field of children(video.data)) {
            if (colorNames[field.id]) color[colorNames[field.id]!] = safe(integer(field.data));
            if (field.id === 0x55d0) for (const master of children(field.data)) {
              const names = ['redX', 'redY', 'greenX', 'greenY', 'blueX', 'blueY', 'whiteX', 'whiteY', 'maxLuminance', 'minLuminance'];
              const name = names[master.id - 0x55d1]; if (name) mastering[name] = float(master.data);
            }
          }
          result.color = Object.freeze(color); result.mastering = Object.freeze(mastering);
        }
      } break;
      case 0xe1: for (const audio of children(entry.data)) {
        if (audio.id === 0xb5) result.audio['sampleRate'] = float(audio.data);
        if (audio.id === 0x78b5) result.audio['outputSampleRate'] = float(audio.data);
        if (audio.id === 0x9f) result.audio['channels'] = safe(integer(audio.data));
        if (audio.id === 0x6264) result.audio['bitDepth'] = safe(integer(audio.data));
      } break;
    }
  }
  if (!result.number || !result.codecId) return bad('Incomplete Matroska track'); return result;
}

export async function readMatroskaMetadata(cache: SourceCache, operation: OperationContext): Promise<MatroskaMetadata> {
  let offset = 0, segment: Element | null = null;
  while (offset < cache.source.size) { const entry = await element(cache, offset, cache.source.size, operation); if (entry.id === 0x18538067) { segment = entry; break; } offset = entry.end; }
  if (!segment) return bad('Matroska Segment missing');
  const result: MatroskaMetadata = { timecodeScaleNs: 1000000n, duration: null, tracks: [], attachments: [], segmentStart: segment.data, segmentEnd: segment.end, firstCluster: segment.end, cues: [] };
  const queued: number[] = [], visited = new Set<number>(); let durationTicks: number | null = null;
  const parse = async (entry: Element): Promise<void> => {
    if (visited.has(entry.start)) return; visited.add(entry.start);
    if (visited.size > 4096) throw new EngineError('ITEM_TOO_LARGE', 'Matroska metadata navigation exceeded limit');
    if (entry.id === 0x1f43b675) { result.firstCluster = Math.min(result.firstCluster, entry.start); return; }
    if (![0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1941a469, 0x1c53bb6b].includes(entry.id)) return;
    const bytes = await payload(cache, entry, operation);
    if (entry.id === 0x114d9b74) for (const seek of children(bytes).filter(x => x.id === 0x4dbb)) {
      const parts = children(seek.data), id = parts.find(x => x.id === 0x53ab), position = parts.find(x => x.id === 0x53ac);
      if (id && position && [0x1549a966, 0x1654ae6b, 0x1941a469, 0x1c53bb6b].includes(safe(integer(id.data)))) queued.push(safe(BigInt(segment.data) + integer(position.data)));
    }
    if (entry.id === 0x1549a966) for (const field of children(bytes)) {
      if (field.id === 0x2ad7b1) result.timecodeScaleNs = integer(field.data);
      if (field.id === 0x4489) durationTicks = float(field.data);
    }
    if (entry.id === 0x1654ae6b) for (const track of children(bytes).filter(x => x.id === 0xae)) {
      if (result.tracks.length >= 32) throw new EngineError('ITEM_TOO_LARGE', 'Matroska track count exceeds 32'); result.tracks.push(parseTrack(track.data));
    }
    if (entry.id === 0x1941a469) for (const attached of children(bytes).filter(x => x.id === 0x61a7)) {
      const fields = children(attached.data), get = (id: number) => fields.find(x => x.id === id)?.data;
      const data = get(0x465c), name = get(0x466e), mime = get(0x4660), uid = get(0x46ae);
      if (!data || !name || !mime) return bad('Incomplete Matroska attachment');
      if (data.length > 8 * 1024 * 1024 || result.attachments.length >= 32) throw new EngineError('ITEM_TOO_LARGE', 'Attachment limit exceeded');
      result.attachments.push({ id: uid ? integer(uid).toString() : String(result.attachments.length), name: text.decode(name), mimeType: text.decode(mime), data });
    }
    if (entry.id === 0x1c53bb6b) for (const cue of children(bytes).filter(x => x.id === 0xbb)) {
      let time = 0n;
      for (const field of children(cue.data)) {
        if (field.id === 0xb3) time = integer(field.data);
        if (field.id === 0xb7) { let position: number | null = null, track = 0;
          for (const value of children(field.data)) { if (value.id === 0xf1) position = safe(BigInt(segment.data) + integer(value.data)); if (value.id === 0xf7) track = safe(integer(value.data)); }
          if (position !== null) result.cues.push({ timeNs: time * result.timecodeScaleNs, position, track });
        }
      }
    }
  };
  for (let position = segment.data; position < segment.end;) {
    const entry = await element(cache, position, segment.end, operation); await parse(entry);
    if (entry.id === 0x1f43b675) break; position = entry.end;
  }
  for (const position of queued) { if (position < segment.data || position >= segment.end) return bad('SeekHead points outside Segment'); await parse(await element(cache, position, segment.end, operation)); }
  result.duration = durationTicks === null ? null : durationTicks * Number(result.timecodeScaleNs) / 1e9;
  if (result.timecodeScaleNs <= 0n || !result.tracks.length) return bad('Invalid Matroska timing or tracks');
  return result;
}

export function decodeLacing(bytes: Uint8Array, offset: number, mode: number): { offset: number; sizes: number[] } {
  if (mode === 0) return { offset, sizes: [bytes.length - offset] };
  const count = (bytes[offset++] ?? -1) + 1; if (count < 1 || count > 256) return bad('Invalid lace count');
  const sizes: number[] = [];
  if (mode === 2) { const size = (bytes.length - offset) / count; if (!Number.isInteger(size)) return bad('Fixed lacing is not divisible'); return { offset, sizes: Array<number>(count).fill(size) }; }
  let total = 0;
  for (let i = 0; i < count - 1; i++) {
    let size = 0;
    if (mode === 1) { let value: number; do { value = bytes[offset++] ?? -1; if (value < 0) return bad('Truncated Xiph lacing'); size += value; } while (value === 255); }
    else { const value = readVint(bytes, offset); offset += value.length; const signed = i === 0 ? value.value : value.value - ((1n << BigInt(value.length * 7 - 1)) - 1n); size = i === 0 ? safe(signed) : (sizes[i - 1] ?? 0) + Number(signed); }
    if (size < 0 || !Number.isSafeInteger(size)) return bad('Invalid lace length'); sizes.push(size); total += size;
  }
  const last = bytes.length - offset - total; if (last < 0) return bad('Lacing exceeds block'); sizes.push(last); return { offset, sizes };
}

export async function* matroskaPackets(cache: SourceCache, metadata: MatroskaMetadata, selected: ReadonlySet<number>, operation: () => OperationContext, start = metadata.firstCluster): AsyncGenerator<MatroskaPacket> {
  const tracks = new Map(metadata.tracks.map(track => [track.number, track]));
  for (let position = start; position < metadata.segmentEnd;) {
    const cluster = await element(cache, position, metadata.segmentEnd, operation());
    if (cluster.id !== 0x1f43b675) { position = cluster.end; continue; }
    let timecode = 0n, nextCluster: number | null = null;
    for (let inside = cluster.data; inside < cluster.end;) {
      const entry = await element(cache, inside, cluster.end, operation());
      if (cluster.unknown && entry.id === 0x1f43b675) { nextCluster = inside; break; }
      if (entry.id === 0xe7) { if (entry.end - entry.data > 8) return bad('Cluster timecode exceeds eight bytes'); timecode = await cache.readValue(entry.data, entry.end, operation(), bytes => integer(bytes)); }
      if (entry.id === 0xa3 || entry.id === 0xa0) {
        const owner = await cache.readOwned(entry.data, entry.end, operation());
        try {
        const bytes = owner.borrow();
        let block = bytes, blockStart = entry.data, duration: bigint | null = null, discard = 0n, key = entry.id === 0xa3;
        if (entry.id === 0xa0) { const group = children(bytes), found = group.find(x => x.id === 0xa1); if (!found) return bad('BlockGroup missing Block');
          block = found.data; blockStart += found.offset; key = !group.some(x => x.id === 0xfb);
          const durationEntry = group.find(x => x.id === 0x9b), padding = group.find(x => x.id === 0x75a2);
          if (durationEntry) duration = integer(durationEntry.data) * metadata.timecodeScaleNs;
          if (padding) discard = integer(padding.data, true);
        }
        const number = readVint(block), trackNumber = safe(number.value);
        if (selected.has(trackNumber)) {
          if (block.length < number.length + 3) return bad('Truncated Matroska block');
          const relative = new DataView(block.buffer, block.byteOffset, block.byteLength).getInt16(number.length), flags = block[number.length + 2]!;
          if (entry.id === 0xa3) key = Boolean(flags & 128);
          const lace = decodeLacing(block, number.length + 3, (flags >> 1) & 3), track = tracks.get(trackNumber);
          if (!track) return bad('Block references unknown track');
          const frameDuration = duration !== null ? duration / BigInt(lace.sizes.length) : track.defaultDurationNs;
          if (lace.sizes.length > 1 && frameDuration === null) throw new EngineError('UNSUPPORTED_CODEC', 'Laced track lacks exact frame durations');
          if (track.type === 'subtitle' && duration === null) throw new EngineError('UNSUPPORTED_CODEC', 'Required subtitle block lacks display duration');
          let dataOffset = lace.offset;
          for (let i = 0; i < lace.sizes.length; i++) {
            const size = lace.sizes[i]!;
            // Borrowed only until this generator advances; the central provider reserves before its exact owned copy.
            yield { trackNumber, data: block.subarray(dataOffset, dataOffset + size), ptsNs: (timecode + BigInt(relative)) * metadata.timecodeScaleNs - track.codecDelayNs + BigInt(i) * (frameDuration ?? 0n), durationNs: frameDuration, key, sourceStart: blockStart + dataOffset, discardPaddingNs: discard };
            dataOffset += size;
          }
        }
        } finally { owner.release(); }
      }
      inside = entry.end;
    }
    position = nextCluster ?? cluster.end;
  }
}
