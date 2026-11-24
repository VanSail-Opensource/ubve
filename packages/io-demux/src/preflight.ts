import { EngineError, type OperationContext } from '@ubve/core';
import type { SourceCache } from './source.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'udta']);
const COUNT_OFFSET = new Map([['stts', 4], ['ctts', 4], ['stsc', 4], ['stco', 4], ['co64', 4], ['stss', 4], ['stsd', 4], ['elst', 4], ['sbgp', 8], ['sgpd', 8]]);
export interface MetadataPreflight { format: 'isobmff' | 'matroska' | 'other'; boxes: number; entries: number; tracks: number; moovBytes: number; }

/** Runs before upstream parsers can expand declared tables. */
export async function preflightMetadata(cache: SourceCache, operation: OperationContext): Promise<MetadataPreflight> {
  const size = cache.source.size;
  const result: MetadataPreflight = { format: 'other', boxes: 0, entries: 0, tracks: 0, moovBytes: 0 };
  if (size < 8) return result;
  const first = await cache.read(0, Math.min(size, 16), operation);
  if (new DataView(first.buffer).getUint32(0) === 0x1a45dfa3) return { ...result, format: 'matroska' };
  const initialType = new TextDecoder().decode(first.subarray(4, 8));
  if (!['ftyp', 'moov', 'free', 'wide', 'mdat', 'skip', 'styp'].includes(initialType)) return result;
  result.format = 'isobmff';
  const scan = async (start: number, end: number, depth: number): Promise<void> => {
    if (depth > 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 metadata nesting exceeds 32');
    for (let position = start; position < end;) {
      if (end - position < 8) throw new EngineError('INVALID_PACKET', 'Truncated MP4 box header');
      const head = await cache.read(position, Math.min(end, position + 32), operation);
      const view = new DataView(head.buffer); const type = new TextDecoder().decode(head.subarray(4, 8));
      let length = BigInt(view.getUint32(0)), header = 8;
      if (length === 1n) { if (head.length < 16) throw new EngineError('INVALID_PACKET', 'Truncated MP4 extended size'); length = view.getBigUint64(8); header = 16; }
      if (length === 0n) length = BigInt(end - position);
      if (length < BigInt(header) || length > BigInt(end - position)) throw new EngineError('INVALID_PACKET', 'MP4 box escapes its parent');
      const boxEnd = position + Number(length), body = position + header;
      if (++result.boxes > 262144) throw new EngineError('ITEM_TOO_LARGE', 'MP4 box count exceeds admission');
      if (type === 'moov') { result.moovBytes += Number(length); if (result.moovBytes > 16 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'MP4 moov exceeds 16 MiB preflight limit'); }
      if (type === 'trak' && ++result.tracks > 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 has more than 32 tracks');
      if (['encv', 'enca', 'pssh', 'senc'].includes(type)) throw new EngineError('UNSUPPORTED_CODEC', 'Encrypted media is outside the clear-file profile');
      const countAt = COUNT_OFFSET.get(type);
      if (type === 'stsz' || type === 'stz2') {
        if (boxEnd - body < 12) throw new EngineError('INVALID_PACKET', 'Truncated sample-size table');
        const bytes = await cache.read(body, body + 12, operation);
        result.entries += new DataView(bytes.buffer).getUint32(8);
      } else if (countAt !== undefined) {
        if (boxEnd - body < countAt + 4) throw new EngineError('INVALID_PACKET', 'Truncated MP4 table count');
        const bytes = await cache.read(body + countAt, body + countAt + 4, operation);
        result.entries += new DataView(bytes.buffer).getUint32(0);
      }
      if (result.entries > 262144) throw new EngineError('ITEM_TOO_LARGE', 'Expanded MP4 tables exceed 262144 entries; paged profile required');
      if (CONTAINERS.has(type)) await scan(body, boxEnd, depth + 1);
      position = boxEnd;
    }
  };
  await scan(0, size, 0); return Object.freeze(result);
}
