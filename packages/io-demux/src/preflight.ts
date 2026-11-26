import { EngineError, type OperationContext } from '@ubve/core';
import { readDolbyVisionConfig, type DolbyVisionConfig } from './dolby-vision.js';
import type { SourceCache } from './source.js';

// Include the pinned MP4 detector's direct matches and bounded skipped
// boxes, so files it recognizes do not bypass our table inspection.
const ISO_LEADING_BOXES = new Set(['ftyp', 'styp', 'moov', 'mdat', 'sidx', 'moof', 'emsg', 'prft', 'free', 'skip', 'wide', 'uuid']);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'mfra', 'udta']);
const COUNT_OFFSET = new Map([['stts', 4], ['ctts', 4], ['stsc', 4], ['stco', 4], ['co64', 4], ['stss', 4], ['stsd', 4], ['elst', 4], ['sdtp', null]]);
const PROTECTED = new Set(['encv', 'enca', 'encs', 'enct', 'drms', 'drmi', 'pssh', 'senc', 'sinf', 'tenc']);
const DOLBY_VISION_VISUAL_ENTRIES = new Set(['dvav', 'dva1', 'dvhe', 'dvh1', 'dav1']);
const VISUAL_ENTRIES = new Set([...DOLBY_VISION_VISUAL_ENTRIES, 'avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'av01', 'vp09']);
const LIMIT = 262144;
const INDEX_WINDOW_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENT_TRACKS = 65536;
const text = new TextDecoder();
export type IsoDolbyVisionConfig = DolbyVisionConfig;
export interface MetadataPreflight { format: 'isobmff' | 'matroska' | 'other'; boxes: number; entries: number; tracks: number; moovBytes: number;
  /** The upstream provider must not receive the original sample tables. */
  readonly requiresPaged?: boolean;
  readonly fragments?: { readonly count: number; readonly peakSamples: number; readonly lookupRows: number };
  /** ISO VisualSampleEntry declaration only. Empty does not prove the absence of in-band DV metadata. */
  readonly dolbyVision: readonly IsoDolbyVisionConfig[];
}

function enforceClear(type: string): void {
  if (PROTECTED.has(type)) throw new EngineError('UNSUPPORTED_CODEC', 'Encrypted media is outside the clear-file profile');
}
async function boxHeader(cache: SourceCache, position: number, end: number, operation: OperationContext): Promise<{ type: string; body: number; end: number }> {
  if (end - position < 8) throw new EngineError('INVALID_PACKET', 'Truncated MP4 box header');
  return cache.readLocalProbe(position, Math.min(end, position + 16), operation, head => {
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
export function preflightMetadata(cache: SourceCache, operation: OperationContext, reuseLocalMoov = false): Promise<MetadataPreflight> {
  return inspectMetadata(cache, operation, reuseLocalMoov, false);
}

export function preflightForPlayback(cache: SourceCache, operation: OperationContext): Promise<MetadataPreflight> {
  return inspectMetadata(cache, operation, true, true);
}

async function inspectMetadata(cache: SourceCache, operation: OperationContext, reuseLocalMoov: boolean, allowPaged: boolean): Promise<MetadataPreflight> {
  const size = cache.source.size;
  const dolbyVision: IsoDolbyVisionConfig[] = [];
  const result: MetadataPreflight = { format: 'other', boxes: 0, entries: 0, tracks: 0, moovBytes: 0, dolbyVision };
  let requiresPaged = false, classicEntries = 0, fragments = 0, fragmentTracks = 0, peakSamples = 0, lookupRows = 0;
  const requestPaged = (message: string) => {
    if (!allowPaged) throw new EngineError('ITEM_TOO_LARGE', message);
    requiresPaged = true;
  };
  const finish = () => {
    Object.freeze(dolbyVision);
    return Object.freeze({ ...result, ...(requiresPaged ? { requiresPaged: true } : {}),
      ...(fragments ? { fragments: Object.freeze({ count: fragments, peakSamples, lookupRows }) } : {}) });
  };
  if (size < 8) return finish();
  const format = await cache.readLocalProbe(0, 8, operation, first => new DataView(first.buffer, first.byteOffset).getUint32(0) === 0x1a45dfa3 ? 'matroska' : text.decode(first.subarray(4, 8)));
  if (format === 'matroska') { result.format = 'matroska'; return finish(); }
  if (!ISO_LEADING_BOXES.has(format)) return finish();
  result.format = 'isobmff';
  const countBox = () => { if (++result.boxes > LIMIT) throw new EngineError('ITEM_TOO_LARGE', 'MP4 box count exceeds admission'); };
  const readVisualEntry = async (sampleEntry: string, body: number, end: number) => {
    if (!VISUAL_ENTRIES.has(sampleEntry)) return;
    let config: IsoDolbyVisionConfig | null = null;
    // The fixed ISO VisualSampleEntry fields occupy 78 bytes after the box
    // header. Search only its framed direct children, never encoded payload.
    for (let childStart = body + 78; childStart < end;) {
      const child = await boxHeader(cache, childStart, end, operation);
      countBox(); enforceClear(child.type); childStart = child.end;
      if (child.type !== 'dvcC' && child.type !== 'dvvC' && child.type !== 'dvwC') continue;
      if (config) throw new EngineError('INVALID_PACKET', 'MP4 Dolby Vision sample entry declares multiple configurations');
      config = await cache.readLocalProbe(child.body, Math.min(child.end, child.body + 5), operation, bytes => readDolbyVisionConfig(sampleEntry, bytes));
    }
    if (!config && DOLBY_VISION_VISUAL_ENTRIES.has(sampleEntry)) config = readDolbyVisionConfig(sampleEntry, new Uint8Array());
    if (config) {
      if (dolbyVision.length >= 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 Dolby Vision configuration count exceeds 32');
      dolbyVision.push(Object.freeze(config));
    }
  };
  const scan = async (start: number, end: number, depth: number, fragment: { samples: number } | null = null): Promise<void> => {
    if (depth > 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 metadata nesting exceeds 32');
    for (let position = start; position < end;) {
      const { type, body, end: boxEnd } = await boxHeader(cache, position, end, operation);
      countBox(); enforceClear(type);
      if (type === 'moof') {
        if (depth !== 0) throw new EngineError('INVALID_PACKET', 'Unexpected nested MP4 fragment');
        if (boxEnd - position > INDEX_WINDOW_BYTES) throw new EngineError('ITEM_TOO_LARGE', 'MP4 fragment metadata exceeds 16 MiB');
        const counter = { samples: 0 };
        await scan(body, boxEnd, depth + 1, counter);
        fragments++; peakSamples = Math.max(peakSamples, counter.samples);
        position = boxEnd; continue;
      }
      if (type === 'traf' && ++fragmentTracks > MAX_FRAGMENT_TRACKS) throw new EngineError('ITEM_TOO_LARGE', 'MP4 fragment track index exceeds its row bound');
      if (type === 'trun') {
        if (!fragment || boxEnd - body < 8) throw new EngineError('INVALID_PACKET', 'Unexpected or truncated MP4 fragment run');
        const { word, count } = await cache.readLocalProbe(body, body + 8, operation, bytes => {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          return { word: view.getUint32(0), count: view.getUint32(4) };
        });
        result.entries += count;
        fragment.samples += count;
        // The pinned parser holds one expanded fragment, not an expanded
        // record for every sample in the film. Apply the cap per fragment.
        if (fragment.samples > LIMIT) throw new EngineError('ITEM_TOO_LARGE', 'Expanded MP4 fragment exceeds 262144 samples');
        const version = Math.floor(word / 0x1000000), flags = word % 0x1000000;
        if (version > 1 || (flags & ~0xf05) !== 0) throw new EngineError('UNSUPPORTED_PROFILE', 'Unknown MP4 fragment run version or flags');
        const extra = Number(Boolean(flags & 1)) + Number(Boolean(flags & 4));
        const fields = [0x100, 0x200, 0x400, 0x800].filter(flag => Boolean(flags & flag)).length;
        if (boxEnd - body !== 8 + 4 * (extra + count * fields)) throw new EngineError('INVALID_PACKET', 'MP4 fragment run count does not match its extent');
      }
      if (type === 'mfra' && boxEnd - position > INDEX_WINDOW_BYTES) throw new EngineError('ITEM_TOO_LARGE', 'MP4 fragment lookup index exceeds 16 MiB');
      if (type === 'tfra') {
        if (boxEnd - body < 16) throw new EngineError('INVALID_PACKET', 'Truncated MP4 fragment lookup table');
        const { version, sizes, count } = await cache.readLocalProbe(body, body + 16, operation, bytes => {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          return { version: view.getUint32(0), sizes: view.getUint32(8), count: view.getUint32(12) };
        });
        lookupRows += count;
        if (lookupRows > LIMIT) throw new EngineError('ITEM_TOO_LARGE', 'MP4 fragment lookup row count exceeds its admitted bound');
        if ((version !== 0 && version !== 0x01000000) || sizes > 63) throw new EngineError('INVALID_PACKET', 'Invalid MP4 fragment lookup schema');
        const stride = (version ? 16 : 8) + 3 + (sizes % 4) + (Math.floor(sizes / 4) % 4) + Math.floor(sizes / 16);
        if (boxEnd - body !== 16 + count * stride) throw new EngineError('INVALID_PACKET', 'MP4 fragment lookup count does not match its extent');
      }
      if (type === 'moov') {
        result.moovBytes += boxEnd - position;
        if (!Number.isSafeInteger(result.moovBytes)) throw new EngineError('INVALID_PACKET', 'MP4 metadata exceeds the exact addressing domain');
        if (result.moovBytes > INDEX_WINDOW_BYTES) requestPaged('MP4 moov exceeds 16 MiB preflight limit');
        if (depth === 0 && reuseLocalMoov && !requiresPaged) await cache.preloadLocalMetadata(body, boxEnd, operation);
      }
      if (type === 'trak' && ++result.tracks > 32) throw new EngineError('ITEM_TOO_LARGE', 'MP4 has more than 32 tracks');
      let countAt = COUNT_OFFSET.get(type);
      if (type === 'stsz' || type === 'stz2') countAt = 8;
      if (type === 'sbgp' || type === 'sgpd') {
        if (boxEnd - body < 1) throw new EngineError('INVALID_PACKET', 'Truncated MP4 group table');
        const version = await cache.readLocalProbe(body, body + 1, operation, bytes => bytes[0]!);
        if (version > (type === 'sbgp' ? 1 : 2)) throw new EngineError('INVALID_PACKET', 'Unknown MP4 group table version');
        countAt = 8 + version * 4;
      }
      if (countAt !== undefined) {
        const minimum = (countAt ?? 0) + 4;
        if (boxEnd - body < minimum) throw new EngineError('INVALID_PACKET', 'Truncated MP4 table count');
        const count = countAt === null ? boxEnd - body - 4 : await cache.readLocalProbe(body + countAt, body + countAt + 4, operation, bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
        result.entries += count;
        if (fragment) throw new EngineError('INVALID_PACKET', 'MP4 fragment contains an unexpected classic sample table');
        classicEntries += count;
        if (classicEntries > LIMIT) requestPaged('Expanded MP4 tables exceed 262144 entries; paged profile required');
        if (type === 'stsd') {
          // Sample entries are boxes inside a FullBox/count prefix. In particular,
          // encv/enca are here, not direct stbl children.
          let entryStart = body + 8;
          for (let i = 0; i < count; i++) {
            const entry = await boxHeader(cache, entryStart, boxEnd, operation);
            countBox(); enforceClear(entry.type);
            await readVisualEntry(entry.type, entry.body, entry.end);
            entryStart = entry.end;
          }
          if (entryStart !== boxEnd) throw new EngineError('INVALID_PACKET', 'MP4 sample descriptions do not fill the declared table');
        }
      }
      if (CONTAINERS.has(type)) await scan(body, boxEnd, depth + 1, fragment);
      position = boxEnd;
    }
  };
  await scan(0, size, 0); return finish();
}
