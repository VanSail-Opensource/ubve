import { EngineError, type OperationContext } from '@ubve/core';
import type { SourceCache } from './source.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'udta']);
const COUNT_OFFSET = new Map([['stts', 4], ['ctts', 4], ['stsc', 4], ['stco', 4], ['co64', 4], ['stss', 4], ['stsd', 4], ['elst', 4], ['trun', 4], ['sdtp', null]]);
const PROTECTED = new Set(['encv', 'enca', 'encs', 'enct', 'drms', 'drmi', 'pssh', 'senc']);
const LIMIT = 262144;
const text = new TextDecoder();
export interface MetadataPreflight { format: 'isobmff' | 'matroska' | 'other'; boxes: number; entries: number; tracks: number; moovBytes: number; }

function enforceClear(type: string): void {
  if (PROTECTED.has(type)) throw new EngineError('UNSUPPORTED_CODEC', 'Encrypted media is outside the clear-file profile');
}
async function boxHeader(cache: SourceCache, position: number, end: number, operation: OperationContext): Promise<{ type: string; body: number; end: number }> {
  if (end - position < 8) throw new EngineError('INVALID_PACKET', 'Truncated MP4 box header');
  return cache.readValue(position, Math.min(end, position + 16), operation, head => {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const type = text.decode(head.subarray(4, 8));
    let length = BigInt(view.getUint32(0)), header = 8;
    if (length === 1n) { if (head.length < 16) throw new EngineError('INVALID_PACKET', 'Truncated MP4 extended size'); length = view.getBigUint64(8); header = 16; }
    if (length === 0n) length = BigInt(end - position);
    if (length < BigInt(header) || length > BigInt(end - position)) throw new EngineError('INVALID_PACKET', 'MP4 box escapes its parent');
    return { type, body: position + header, end: position + Number(length) };
  });
}

/** Runs before upstream MP4 parsers can expand table counts. */
export async function preflightMetadata(cache: SourceCache, operation: OperationContext): Promise<MetadataPreflight> {
  const size = cache.source.size;
  const result: MetadataPreflight = { format: 'other', boxes: 0, entries: 0, tracks: 0, moovBytes: 0 };
  if (size < 8) return result;
  const format = await cache.readValue(0, 8, operation, first => new DataView(first.buffer, first.byteOffset).getUint32(0) === 0x1a45dfa3 ? 'matroska' : text.decode(first.subarray(4, 8)));
  if (format === 'matroska') return { ...result, format: 'matroska' };
  if (!['ftyp', 'moov', 'free', 'wide', 'mdat', 'skip', 'styp', 'uuid'].includes(format)) return result;
  result.format = 'isobmff';
  const countBox = () => { if (++result.boxes > LIMIT) throw new EngineError('ITEM_TOO_LARGE', 'MP4 box count exceeds admission'); };
  const scan = async (start: number, end: number, depth: number): Promise<void> => {
    if (depth > 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 metadata nesting exceeds 32');
    for (let position = start; position < end;) {
      const { type, body, end: boxEnd } = await boxHeader(cache, position, end, operation);
      countBox(); enforceClear(type);
      if (type === 'moov') { result.moovBytes += boxEnd - position; if (result.moovBytes > 16 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'MP4 moov exceeds 16 MiB preflight limit'); }
      if (type === 'trak' && ++result.tracks > 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 has more than 32 tracks');
      let countAt = COUNT_OFFSET.get(type);
      if (type === 'stsz' || type === 'stz2') countAt = 8;
      if (type === 'sbgp' || type === 'sgpd') {
        if (boxEnd - body < 1) throw new EngineError('INVALID_PACKET', 'Truncated MP4 group table');
        const version = await cache.readValue(body, body + 1, operation, bytes => bytes[0]!);
        if (version > (type === 'sbgp' ? 1 : 2)) throw new EngineError('INVALID_PACKET', 'Unknown MP4 group table version');
        countAt = 8 + version * 4;
      }
      if (countAt !== undefined) {
        const minimum = (countAt ?? 0) + 4;
        if (boxEnd - body < minimum) throw new EngineError('INVALID_PACKET', 'Truncated MP4 table count');
        const count = countAt === null ? boxEnd - body - 4 : await cache.readValue(body + countAt, body + countAt + 4, operation, bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
        result.entries += count;
        if (result.entries > LIMIT) throw new EngineError('ITEM_TOO_LARGE', 'Expanded MP4 tables exceed 262144 entries; paged profile required');
        if (type === 'stsd') {
          // Sample entries are boxes inside a FullBox/count prefix. In particular,
          // encv/enca are here, not direct stbl children.
          let entryStart = body + 8;
          for (let i = 0; i < count; i++) {
            const entry = await boxHeader(cache, entryStart, boxEnd, operation);
            countBox(); enforceClear(entry.type); entryStart = entry.end;
          }
          if (entryStart !== boxEnd) throw new EngineError('INVALID_PACKET', 'MP4 sample descriptions do not fill the declared table');
        }
      }
      if (CONTAINERS.has(type)) await scan(body, boxEnd, depth + 1);
      position = boxEnd;
    }
  };
  await scan(0, size, 0); return Object.freeze(result);
}
