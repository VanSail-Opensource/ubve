import { EngineError, byteRange, checkOperation, type ByteRange, type OperationContext } from '@ubve/core';
import { browserScheduler } from './operations.js';
import type { SourceCache } from './source.js';

const MAX_ENTRIES = 8_000_000;
const MAX_BOXES = 65_536;
const PAGE_ROWS = 4096;
const MAX_SAMPLES_PER_CHUNK = 65_536;
const MAX_SAMPLE_BYTES = 32 * 1024 * 1024;
const MAX_DESCRIPTIONS = 256;
const MAX_EDIT_ENTRIES = 4096;
const MAX_RESIDENT_CHECKPOINTS = 24_576;
const MAX_CLOCK = 2n ** 64n - 1n;

type Box = { readonly type: string; readonly body: number; readonly end: number };
type Table = { readonly start: number; readonly count: number; readonly stride: number };
type Interval = { readonly start: number; readonly end: number };
type RunPage = { readonly row: number; readonly sample: number; readonly clock: bigint };
type ChunkPage = { readonly row: number; readonly sample: number; readonly chunk: number };
type ChunkRow = { readonly first: number; readonly count: number; readonly description: number };
type RunTable = { readonly table: Table; readonly pages: readonly RunPage[]; readonly signed: boolean };
type ChunkTable = { readonly table: Table; readonly pages: readonly ChunkPage[] };
type SampleSizes = { readonly packing: 4 | 8 | 16 | 32; readonly count: number; readonly fixed: number; readonly start: number };
type IndexTables = { readonly sizes: SampleSizes; readonly time: RunTable; readonly composition: RunTable | null; readonly chunk: ChunkTable; readonly offsets: Table; readonly sync: Table | null };

const fail = (message: string): never => { throw new EngineError('INVALID_PACKET', message); };
const refuse = (message: string): never => { throw new EngineError('UNSUPPORTED_PROFILE', message); };
const tooLarge = (message: string): never => { throw new EngineError('ITEM_TOO_LARGE', message); };
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const fourCC = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

class Scanner {
  readonly cache: SourceCache;
  #boxes = 0;
  constructor(cache: SourceCache) { this.cache = cache; }
  async boxes(start: number, end: number, operation: OperationContext): Promise<readonly Box[]> {
    const boxes: Box[] = [];
    for (let at = start; at < end;) {
      if (++this.#boxes > MAX_BOXES) tooLarge('MP4 box-count limit exceeded');
      if (end - at < 8) fail('Truncated MP4 box header');
      const box = await this.cache.readValue(at, at + Math.min(16, end - at), operation, bytes => {
        const data = view(bytes), type = fourCC(bytes, 4); let size = BigInt(data.getUint32(0)), header = 8;
        if (size === 1n) { if (bytes.length < 16) fail('Truncated extended MP4 box header'); size = data.getBigUint64(8); header = 16; }
        if (size === 0n) size = BigInt(end - at);
        if (size < BigInt(header) || size > BigInt(end - at)) fail('MP4 box escapes its parent');
        return { type, body: at + header, end: at + Number(size) };
      });
      boxes.push(box); at = box.end;
    }
    return boxes;
  }
  children(box: Box, operation: OperationContext) { return this.boxes(box.body, box.end, operation); }
}
function one(boxes: readonly Box[], type: string): Box | undefined {
  const items = boxes.filter(box => box.type === type);
  if (items.length > 1) fail(`Duplicate MP4 ${type} box`);
  return items[0];
}
function required(boxes: readonly Box[], type: string): Box {
  return one(boxes, type) ?? fail(`Missing MP4 ${type} box`);
}
function boundedCount(count: number, name: string): number {
  if (count > MAX_ENTRIES) tooLarge(`MP4 ${name} exceeds the ${MAX_ENTRIES}-entry paged profile`);
  return count;
}
function verifyFullBox(data: DataView, name: string, maximumVersion = 0): number {
  const word = data.getUint32(0), version = data.getUint8(0);
  if (version > maximumVersion || word % 0x1000000 !== 0) refuse(`Unsupported ${name} version or flags`);
  return version;
}
async function header(cache: SourceCache, box: Box, size: number, operation: OperationContext): Promise<DataView> {
  if (size > box.end - box.body) fail(`Truncated MP4 ${box.type} fields`);
  return cache.readValue(box.body, box.body + size, operation, bytes => {
    // This copy is at most a fixed header, never a table or a source page.
    return view(bytes.slice());
  });
}
async function fixedTable(cache: SourceCache, box: Box, stride: number, operation: OperationContext, maximumVersion = 0): Promise<{ table: Table; version: number }> {
  const data = await header(cache, box, 8, operation), version = verifyFullBox(data, box.type, maximumVersion);
  const count = boundedCount(data.getUint32(4), box.type), start = box.body + 8;
  if (BigInt(box.end - start) !== BigInt(count) * BigInt(stride)) fail(`MP4 ${box.type} entry count does not match its extent`);
  return { table: { start, count, stride }, version };
}
async function sizes(cache: SourceCache, box: Box, operation: OperationContext): Promise<SampleSizes> {
  const data = await header(cache, box, 12, operation); verifyFullBox(data, box.type);
  const count = boundedCount(data.getUint32(8), box.type), start = box.body + 12;
  let fixed = 0, packing: SampleSizes['packing'] = 32;
  if (box.type === 'stsz') fixed = data.getUint32(4);
  else {
    const word = data.getUint32(4);
    if (word !== 4 && word !== 8 && word !== 16) fail('Invalid stz2 reserved bytes or field width');
    packing = word as typeof packing;
  }
  if (fixed > MAX_SAMPLE_BYTES) tooLarge('Fixed MP4 sample exceeds the admitted single-sample bytes');
  if (BigInt(box.end - start) !== (fixed === 0 ? (BigInt(packing) * BigInt(count) + 7n) / 8n : 0n)) fail('MP4 sample-size count does not match its extent');
  return { fixed, packing, count, start };
}
async function rows<T>(cache: SourceCache, table: Table, start: number, end: number, operation: OperationContext, read: (data: DataView) => T): Promise<T> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > table.count || end - start > PAGE_ROWS) fail('Invalid MP4 index page request');
  return cache.readValue(table.start + start * table.stride, table.start + end * table.stride, operation, bytes => read(view(bytes)));
}
async function buildRuns(cache: SourceCache, table: Table, signed: boolean, isTime: boolean, sampleCount: number, operation: OperationContext): Promise<RunTable & { readonly duration: bigint }> {
  const pages: RunPage[] = []; let sample = 0, clock = 0n;
  for (let row = 0; row < table.count; row += PAGE_ROWS) {
    pages.push({ row, sample, clock });
    const end = Math.min(table.count, row + PAGE_ROWS);
    await rows(cache, table, row, end, operation, data => {
      for (let at = 0; at < data.byteLength; at += 8) {
        const count = data.getUint32(at), value = data.getUint32(at + 4);
        if (count === 0 || sample + count > sampleCount) fail('MP4 time-run count is inconsistent with sample sizes');
        sample += count;
        if (isTime) { clock += BigInt(value) * BigInt(count); if (clock > MAX_CLOCK) fail('MP4 decode clock exceeds uint64'); }
      }
    });
  }
  if (sample !== sampleCount) fail('MP4 time runs do not cover every sample');
  return { table, pages, signed, duration: clock };
}
function chunkRow(data: DataView, at: number): ChunkRow {
  return { first: data.getUint32(at), count: data.getUint32(at + 4), description: data.getUint32(at + 8) };
}
async function buildChunks(cache: SourceCache, table: Table, chunkCount: number, sampleCount: number, descriptionCount: number, operation: OperationContext): Promise<ChunkTable> {
  const pages: ChunkPage[] = []; let samples = 0, previous: ChunkRow | null = null;
  const add = (length: number, count: number) => {
    const next = BigInt(samples) + BigInt(length) * BigInt(count);
    if (next > BigInt(sampleCount)) fail('MP4 chunk runs exceed the declared sample count');
    samples = Number(next);
  };
  for (let row = 0; row < table.count; row += PAGE_ROWS) {
    const end = Math.min(table.count, row + PAGE_ROWS);
    await rows(cache, table, row, end, operation, data => {
      for (let at = 0; at < data.byteLength; at += 12) {
        const item = chunkRow(data, at);
        if (item.first < 1 || item.first > chunkCount || item.count < 1 || item.description < 1 || item.description > descriptionCount) fail('Invalid MP4 chunk run');
        if (item.count > MAX_SAMPLES_PER_CHUNK) tooLarge('Samples per MP4 chunk exceed paged profile');
        if (!previous && item.first !== 1) fail('MP4 chunk runs do not start at chunk one');
        if (previous) { if (item.first <= previous.first) fail('Unordered MP4 chunk runs'); add(item.first - previous.first, previous.count); }
        if (at === 0) pages.push({ row, sample: samples, chunk: item.first });
        previous = item;
      }
    });
  }
  const tail = previous as ChunkRow | null;
  if (tail) add(chunkCount + 1 - tail.first, tail.count);
  if (samples !== sampleCount || (!tail && chunkCount !== 0)) fail('MP4 chunks do not cover every sample');
  return { table, pages };
}
async function validateSync(cache: SourceCache, table: Table, count: number, operation: OperationContext): Promise<void> {
  let previous = 0;
  for (let row = 0; row < table.count; row += PAGE_ROWS) {
    await rows(cache, table, row, Math.min(table.count, row + PAGE_ROWS), operation, data => {
      for (let at = 0; at < data.byteLength; at += 4) {
        const sample = data.getUint32(at);
        if (sample <= previous || sample > count) fail('Invalid or unordered MP4 sync sample');
        previous = sample;
      }
    });
  }
}
function floorIndex<T>(values: readonly T[], present: (value: T) => boolean): number {
  let start = 0, end = values.length;
  while (start < end) { const mid = start + Math.floor((end - start) / 2); if (present(values[mid]!)) start = mid + 1; else end = mid; }
  return start - 1;
}

export interface Mp4EditSegment {
  readonly movieStart: bigint;
  readonly movieEnd: bigint;
  /** Negative one on disk denotes an empty movie segment, represented here as null. */
  readonly mediaStart: bigint | null;
}
export type Mp4MoviePosition = { readonly kind: 'outside' | 'gap' } |
  { readonly kind: 'media'; readonly mediaTicksNumerator: bigint; readonly mediaTicksDenominator: bigint };
export interface Mp4EditMap {
  readonly movieTimescale: number;
  readonly duration: bigint;
  readonly segments: readonly Mp4EditSegment[];
  mapMovieTick(tick: bigint): Mp4MoviePosition;
}
async function editMap(scanner: Scanner, editsBox: Box, movieTimescale: number, mediaTimescale: number, operation: OperationContext): Promise<Mp4EditMap> {
  const children = await scanner.children(editsBox, operation), elst = required(children, 'elst');
  const view = await header(scanner.cache, elst, 8, operation), version = verifyFullBox(view, 'elst', 1);
  const count = view.getUint32(4), start = elst.body + 8, stride = version === 1 ? 20 : 12;
  if (count === 0) fail('MP4 edit list has no segments');
  if (count > MAX_EDIT_ENTRIES) tooLarge('MP4 edit list exceeds its segment bound');
  if (BigInt(elst.end - start) !== BigInt(count) * BigInt(stride)) fail('MP4 edit count does not match its extent');
  const mediaScale = BigInt(mediaTimescale), movieScale = BigInt(movieTimescale);
  let duration = 0n;
  const segments = await rows(scanner.cache, { start, count, stride }, 0, count, operation, bytes => {
    const result: Mp4EditSegment[] = [];
    for (let at = 0; at < bytes.byteLength; at += stride) {
      const length = version === 1 ? bytes.getBigUint64(at) : BigInt(bytes.getUint32(at));
      const mediaStart = version === 1 ? bytes.getBigInt64(at + 8) : BigInt(bytes.getInt32(at + 4));
      const rate = bytes.getInt32(at + stride - 4);
      if (length === 0n || mediaStart < -1n || duration + length > MAX_CLOCK) fail('Invalid MP4 edit timing');
      if (rate !== 65536) refuse('MP4 non-unit-rate or dwell edits are outside the paged mapping');
      result.push(Object.freeze({ movieStart: duration, movieEnd: duration + length, mediaStart: mediaStart === -1n ? null : mediaStart }));
      duration += length;
    }
    return Object.freeze(result);
  });
  return Object.freeze({ movieTimescale, duration, segments, mapMovieTick(tick: bigint): Mp4MoviePosition {
    if (typeof tick !== 'bigint') throw new EngineError('INVALID_ARGUMENT', 'MP4 edit mapping requires exact movie ticks');
    if (tick < 0n || tick >= duration) return { kind: 'outside' };
    const segment = segments[floorIndex(segments, entry => entry.movieStart <= tick)]!;
    if (segment.mediaStart === null) return { kind: 'gap' };
    return { kind: 'media', mediaTicksNumerator: segment.mediaStart * movieScale + (tick - segment.movieStart) * mediaScale, mediaTicksDenominator: movieScale };
  } });
}
async function parseTimescale(cache: SourceCache, box: Box, operation: OperationContext): Promise<number> {
  const version = verifyFullBox(await header(cache, box, 4, operation), box.type, 1), at = version === 1 ? 20 : 12;
  const timescale = (await header(cache, box, at + 4, operation)).getUint32(at);
  if (timescale === 0) fail(`Zero MP4 ${box.type} timescale`);
  return timescale;
}

export interface Mp4IndexedSample {
  /** Decode-order index, zero-based. Description indices use MP4's one-based encoding. */
  readonly index: number; readonly descriptionIndex: number;
  readonly dts: bigint; readonly pts: bigint; readonly duration: bigint;
  readonly sync: boolean; readonly range: ByteRange;
}
export interface Mp4PagedTrack {
  readonly id: number; readonly timescale: number; readonly sampleCount: number; readonly decodeDuration: bigint;
  readonly descriptions: readonly string[];
  readonly edits: Mp4EditMap | null;
  readonly checkpointCount: number;
  sample(index: number, operation: OperationContext): Promise<Mp4IndexedSample>;
  /** Greatest decode-order sample with DTS <= target, clamped at both ends. Not a PTS seek. */
  locateDts(target: bigint, operation: OperationContext): Promise<number | null>;
  /** Greatest declared sync index <= index. Returns null before the first sync sample. */
  precedingSync(index: number, operation: OperationContext): Promise<number | null>;
}

class TrackIndex implements Mp4PagedTrack {
  readonly id: number; readonly timescale: number; readonly sampleCount: number; readonly decodeDuration: bigint;
  readonly descriptions: readonly string[]; readonly checkpointCount: number; readonly edits: Mp4EditMap | null;
  readonly #cache: SourceCache; readonly #tables: IndexTables; readonly #payloads: readonly Interval[];
  constructor(cache: SourceCache, tables: IndexTables, payloads: readonly Interval[], id: number, timescale: number, decodeDuration: bigint, descriptions: readonly string[], edits: Mp4EditMap | null) {
    this.#cache = cache; this.#tables = tables; this.#payloads = payloads; this.id = id; this.timescale = timescale;
    this.decodeDuration = decodeDuration; this.edits = edits; this.descriptions = Object.freeze([...descriptions]); this.sampleCount = tables.sizes.count;
    this.checkpointCount = tables.time.pages.length + (tables.composition?.pages.length ?? 0) + tables.chunk.pages.length;
  }
  #check(index: number, operation: OperationContext) {
    checkOperation(operation, browserScheduler);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.sampleCount) throw new EngineError('INVALID_ARGUMENT', 'MP4 sample index is outside the track');
  }
  #run(runs: RunTable, index: number, operation: OperationContext): Promise<{ clock: bigint; value: number }> {
    const { pages, table, signed } = runs, page = pages[floorIndex(pages, item => item.sample <= index)]!;
    return rows(this.#cache, table, page.row, Math.min(table.count, page.row + PAGE_ROWS), operation, data => {
      let { sample, clock } = page;
      for (let at = 0; at < data.byteLength; at += 8) {
        const count = data.getUint32(at), value = signed ? data.getInt32(at + 4) : data.getUint32(at + 4);
        if (index < sample + count) return { clock: clock + BigInt(index - sample) * BigInt(value), value };
        sample += count; clock += BigInt(count) * BigInt(value);
      }
      return fail('MP4 sample has no covering time run');
    });
  }
  #chunk(index: number, operation: OperationContext): Promise<{ chunk: number; firstSample: number; description: number }> {
    const { chunk: { pages, table }, offsets } = this.#tables;
    const pageIndex = floorIndex(pages, it => it.sample <= index), page = pages[pageIndex]!;
    return rows(this.#cache, table, page.row, Math.min(table.count, page.row + PAGE_ROWS), operation, data => {
      let { sample } = page;
      for (let at = 0; at < data.byteLength; at += 12) {
        const row = chunkRow(data, at);
        const next = at + 12 < data.byteLength ? data.getUint32(at + 12) : pages[pageIndex + 1]?.chunk ?? offsets.count + 1;
        const count = (next - row.first) * row.count;
        if (index < sample + count) {
          const skip = Math.floor((index - sample) / row.count);
          return { chunk: row.first - 1 + skip, firstSample: sample + skip * row.count, description: row.description };
        }
        sample += count;
      }
      return fail('MP4 sample has no covering chunk run');
    });
  }
  async #sampleSizes(start: number, index: number, operation: OperationContext): Promise<{ offset: number; length: number }> {
    const table = this.#tables.sizes;
    if (table.fixed !== 0) return { offset: (index - start) * table.fixed, length: table.fixed };
    const from = Math.floor(start * table.packing / 8), to = Math.ceil((index + 1) * table.packing / 8);
    return this.#cache.readValue(table.start + from, table.start + to, operation, bytes => {
      const data = view(bytes); let offset = 0, length = 0;
      for (let i = start; i <= index; i++) {
        const at = Math.floor(i * table.packing / 8) - from;
        switch (table.packing) {
          case 4: { const packed = data.getUint8(at); length = i % 2 === 0 ? Math.floor(packed / 16) : packed % 16; break; }
          case 8: length = data.getUint8(at); break;
          case 16: length = data.getUint16(at); break;
          case 32: length = data.getUint32(at); break;
        }
        if (length > MAX_SAMPLE_BYTES) tooLarge('MP4 sample exceeds the admitted single-sample bytes');
        if (i !== index) offset += length;
      }
      return { offset, length };
    });
  }
  precedingSync(index: number, operation: OperationContext): Promise<number | null> {
    this.#check(index, operation);
    return this.#sync(index, operation);
  }
  async #sync(index: number, operation: OperationContext): Promise<number | null> {
    const table = this.#tables.sync;
    if (!table) return index;
    let start = 0, end = table.count, result: number | null = null;
    while (start < end) {
      const mid = start + Math.floor((end - start) / 2);
      const number = await rows(this.#cache, table, mid, mid + 1, operation, data => data.getUint32(0) - 1);
      if (number <= index) { start = mid + 1; result = number; } else end = mid;
    }
    return result;
  }
  async sample(index: number, operation: OperationContext): Promise<Mp4IndexedSample> {
    this.#check(index, operation);
    const dts = await this.#run(this.#tables.time, index, operation);
    const composition = this.#tables.composition ? (await this.#run(this.#tables.composition, index, operation)).value : 0;
    const chunk = await this.#chunk(index, operation), offsets = this.#tables.offsets;
    const base = await rows(this.#cache, offsets, chunk.chunk, chunk.chunk + 1, operation, data => offsets.stride === 8 ? data.getBigUint64(0) : BigInt(data.getUint32(0)));
    const sizes = await this.#sampleSizes(chunk.firstSample, index, operation);
    const start = base + BigInt(sizes.offset), end = start + BigInt(sizes.length);
    if (end > BigInt(this.#cache.source.size)) fail('MP4 sample span escapes the source');
    const j = floorIndex(this.#payloads, item => BigInt(item.start) <= base), payload = this.#payloads[j];
    if (!payload || base >= BigInt(payload.end) || end > BigInt(payload.end)) fail('MP4 sample span is not contained in its chunk mdat payload');
    const sync = (await this.#sync(index, operation)) === index;
    checkOperation(operation, browserScheduler);
    return { index, descriptionIndex: chunk.description, dts: dts.clock, pts: dts.clock + BigInt(composition), duration: BigInt(dts.value), sync, range: byteRange(Number(start), Number(end)) };
  }
  async locateDts(target: bigint, operation: OperationContext): Promise<number | null> {
    checkOperation(operation, browserScheduler);
    if (typeof target !== 'bigint') throw new EngineError('INVALID_ARGUMENT', 'MP4 decode seek requires exact bigint ticks');
    if (this.sampleCount === 0) return null;
    if (target < 0n) return 0;
    const { pages, table } = this.#tables.time;
    const page = pages[floorIndex(pages, item => item.clock <= target)]!;
    return rows(this.#cache, table, page.row, Math.min(table.count, page.row + PAGE_ROWS), operation, data => {
      let { sample, clock } = page;
      for (let at = 0; at < data.byteLength; at += 8) {
        const count = data.getUint32(at), duration = BigInt(data.getUint32(at + 4)), next = clock + duration * BigInt(count);
        if (duration !== 0n && target < next) return sample + Number((target - clock) / duration);
        sample += count; clock = next;
      }
      return sample - 1;
    });
  }
}

/** Classic, clear indexed ISO BMFF. One shared raw-page LRU; no expanded sample array.
 * Unimplemented timelines/protection are refused here and retain the upstream preflight cap.
 * The caller owns the cache and decides whether a separate playback adapter can admit this track. */
export async function openMp4PagedIndex(cache: SourceCache, operation: OperationContext): Promise<readonly Mp4PagedTrack[]> {
  const scanner = new Scanner(cache), top = await scanner.boxes(0, cache.source.size, operation);
  if (top.some(box => box.type === 'moof' || box.type === 'pssh')) refuse('Fragmented or protected MP4 is outside the classic paged index');
  const moov = await scanner.children(required(top, 'moov'), operation);
  if (moov.some(box => ['mvex', 'pssh', 'cmov'].includes(box.type))) refuse('Fragmented, protected or compressed MP4 metadata is not admitted');
  const payloads = top.filter(box => box.type === 'mdat').map(box => ({ start: box.body, end: box.end }));
  const tracks = moov.filter(box => box.type === 'trak');
  if (tracks.length === 0 || tracks.length > 32) refuse('Classic MP4 paged index requires 1..32 tracks');
  const mvhd = one(moov, 'mvhd');
  let movieTimescale: number | null = null, checkpoints = 0;
  const indices: Mp4PagedTrack[] = [], ids = new Set<number>();
  for (const trak of tracks) {
    const children = await scanner.children(trak, operation);
    const editsBox = one(children, 'edts');
    const trackHeader = required(children, 'tkhd'), tkhd = await header(cache, trackHeader, 4, operation);
    const version = tkhd.getUint8(0);
    if (version !== 0 && version !== 1) refuse('Unsupported MP4 track-header version');
    const idAt = version === 1 ? 20 : 12, id = (await header(cache, trackHeader, idAt + 4, operation)).getUint32(idAt);
    if (id === 0 || ids.has(id)) fail('Invalid or duplicate MP4 track ID');
    ids.add(id);
    const mdia = await scanner.children(required(children, 'mdia'), operation);
    const timescale = await parseTimescale(cache, required(mdia, 'mdhd'), operation);
    let edits: Mp4EditMap | null = null;
    if (editsBox) {
      movieTimescale ??= await parseTimescale(cache, mvhd ?? fail('MP4 edit list is missing its movie timescale'), operation);
      edits = await editMap(scanner, editsBox, movieTimescale, timescale, operation);
    }
    const mediaInfo = await scanner.children(required(mdia, 'minf'), operation), stbl = await scanner.children(required(mediaInfo, 'stbl'), operation);
    if (stbl.some(box => ['sbgp', 'sgpd', 'senc', 'saiz', 'saio', 'sdtp', 'stps', 'subs', 'cslg'].includes(box.type))) refuse('MP4 sample groups, dependencies, subsamples or protection require a separate mapped profile');
    const dref = one(mediaInfo, 'dinf');
    if (dref) {
      const box = required(await scanner.children(dref, operation), 'dref');
      const data = await header(cache, box, 8, operation); verifyFullBox(data, 'dref');
      const refs = await scanner.boxes(box.body + 8, box.end, operation);
      const ref = refs[0];
      if (data.getUint32(4) !== 1 || refs.length !== 1 || !ref || ref.type !== 'url ' || ref.end - ref.body !== 4 || (await header(cache, ref, 4, operation)).getUint32(0) !== 1) refuse('External or noncanonical MP4 data references are not admitted');
    }
    const stsd = required(stbl, 'stsd'), descriptionHeader = await header(cache, stsd, 8, operation); verifyFullBox(descriptionHeader, 'stsd');
    const descriptionCount = descriptionHeader.getUint32(4);
    if (descriptionCount < 1 || descriptionCount > MAX_DESCRIPTIONS) tooLarge('MP4 sample descriptions outside the paged profile');
    const descriptions = await scanner.boxes(stsd.body + 8, stsd.end, operation);
    if (descriptions.length !== descriptionCount) fail('MP4 sample description count does not match extent');
    for (const description of descriptions) {
      if (['encv', 'enca', 'encs', 'enct', 'drms', 'drmi'].includes(description.type)) refuse('Encrypted MP4 sample description');
      if ((await header(cache, description, 8, operation)).getUint16(6) !== 1) refuse('MP4 sample data reference is not local reference one');
    }
    const stsz = one(stbl, 'stsz'), stz2 = one(stbl, 'stz2'), stco = one(stbl, 'stco'), co64 = one(stbl, 'co64');
    if ((!stsz && !stz2) || (stsz && stz2) || (!stco && !co64) || (stco && co64)) fail('MP4 requires exactly one size and chunk-offset table');
    const sampleSizes = await sizes(cache, (stsz ?? stz2)!, operation);
    const offsets = (await fixedTable(cache, (stco ?? co64)!, stco ? 4 : 8, operation)).table;
    const decoding = await fixedTable(cache, required(stbl, 'stts'), 8, operation);
    const time = await buildRuns(cache, decoding.table, false, true, sampleSizes.count, operation);
    const ctts = one(stbl, 'ctts'), compositionInfo = ctts ? await fixedTable(cache, ctts, 8, operation, 1) : null;
    const composition = compositionInfo ? await buildRuns(cache, compositionInfo.table, compositionInfo.version === 1, false, sampleSizes.count, operation) : null;
    const chunk = await buildChunks(cache, (await fixedTable(cache, required(stbl, 'stsc'), 12, operation)).table, offsets.count, sampleSizes.count, descriptions.length, operation);
    const stss = one(stbl, 'stss'), sync = stss ? (await fixedTable(cache, stss, 4, operation)).table : null;
    if (sync) await validateSync(cache, sync, sampleSizes.count, operation);
    const track = new TrackIndex(cache, { sizes: sampleSizes, offsets, time, composition, chunk, sync }, payloads, id, timescale, time.duration, descriptions.map(item => item.type), edits);
    checkpoints += track.checkpointCount + (edits?.segments.length ?? 0);
    if (checkpoints > MAX_RESIDENT_CHECKPOINTS) tooLarge('MP4 total index checkpoints and edit segments exceed the resident limit');
    indices.push(track);
  }
  checkOperation(operation, browserScheduler);
  return Object.freeze(indices);
}
