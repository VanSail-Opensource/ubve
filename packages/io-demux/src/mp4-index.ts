import { EngineError, byteRange, checkOperation, mediaTime, timeBase, type ByteRange, type MediaTime, type OperationContext } from '@ubve/core';
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
const CONFIG_CHILDREN = new Set(['avcC', 'hvcC', 'vpcC', 'av1C', 'esds', 'dOps', 'dfLa', 'dac3', 'dec3', 'ddts', 'dmlp',
  'colr', 'pasp', 'btrt', 'clap', 'fiel', 'gama', 'mdcv', 'clli', 'dvcC', 'dvvC', 'dvwC', 'hvcE', 'ccst',
  'alac', 'enda', 'pcmC', 'srat', 'chan', 'chnl', 'frma', 'free', 'skip', '\0\0\0\0']);

type Box = { readonly type: string; readonly body: number; readonly end: number };
type Table = { readonly start: number; readonly count: number; readonly stride: number };
type Interval = { readonly start: number; readonly end: number };
type RunPage = { readonly row: number; readonly sample: number; readonly clock: bigint };
type Run = { readonly row: number; readonly first: number; readonly end: number; readonly clock: bigint; readonly value: number };
type ChunkPage = { readonly row: number; readonly sample: number; readonly chunk: number };
type ChunkRow = { readonly first: number; readonly count: number; readonly description: number };
type ChunkRun = { readonly rowIndex: number; readonly firstSample: number; readonly endSample: number; readonly row: ChunkRow };
type RunTable = { readonly table: Table; readonly pages: readonly RunPage[]; readonly signed: boolean };
type ChunkTable = { readonly table: Table; readonly pages: readonly ChunkPage[] };
type SampleSizes = { readonly packing: 4 | 8 | 16 | 32; readonly count: number; readonly fixed: number; readonly start: number };
type DecodeRuns = RunTable & { readonly duration: bigint; readonly minDelta: number; readonly maxDelta: number };
type IndexTables = { readonly sizes: SampleSizes; readonly time: DecodeRuns; readonly composition: RunTable | null; readonly chunk: ChunkTable; readonly offsets: Table;
  readonly sync: Table | null; readonly dependencies: Table | null };

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
async function verifyPlaybackEntry(scanner: Scanner, entry: Box, kind: 'video' | 'audio', operation: OperationContext): Promise<void> {
  let fixed = 78;
  if (kind === 'audio') {
    const version = (await header(scanner.cache, entry, 10, operation)).getUint16(8);
    if (version > 2) refuse('Unsupported MP4 audio sample-entry version');
    fixed = version === 0 ? 28 : version === 1 ? 44 : 64;
  }
  if (entry.end - entry.body < fixed) fail('Truncated MP4 audio or visual sample entry');
  const visit = async (boxes: readonly Box[], insideWave: boolean): Promise<void> => {
    for (const child of boxes) {
      if (['sinf', 'schi', 'schm', 'tenc', 'pssh'].includes(child.type)) refuse('Encrypted MP4 sample entry is outside the clear paged profile');
      if (child.type === 'wave' && kind === 'audio' && !insideWave) await visit(await scanner.children(child, operation), true);
      else if (!CONFIG_CHILDREN.has(child.type)) refuse(`MP4 sample-entry child ${JSON.stringify(child.type)} is outside the paged codec metadata profile`);
    }
  };
  await visit(await scanner.boxes(entry.body + fixed, entry.end, operation), false);
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
  const count = data.getUint32(8), start = box.body + 12;
  let fixed = 0, packing: SampleSizes['packing'] = 32;
  if (box.type === 'stsz') fixed = data.getUint32(4);
  else {
    const word = data.getUint32(4);
    if (word !== 4 && word !== 8 && word !== 16) fail('Invalid stz2 reserved bytes or field width');
    packing = word as typeof packing;
  }
  if (fixed > MAX_SAMPLE_BYTES) tooLarge('Fixed MP4 sample exceeds the admitted single-sample bytes');
  // A constant-size track (including MOV PCM) has no per-sample size rows.
  // Its logical count can use the full u32 field without allocating them.
  if (!fixed) boundedCount(count, box.type);
  if (BigInt(box.end - start) !== (fixed === 0 ? (BigInt(packing) * BigInt(count) + 7n) / 8n : 0n)) fail('MP4 sample-size count does not match its extent');
  return { fixed, packing, count, start };
}
async function rows<T>(cache: SourceCache, table: Table, start: number, end: number, operation: OperationContext, read: (data: DataView) => T): Promise<T> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > table.count || end - start > PAGE_ROWS) fail('Invalid MP4 index page request');
  return cache.readValue(table.start + start * table.stride, table.start + end * table.stride, operation, bytes => read(view(bytes)));
}
async function buildRuns(cache: SourceCache, table: Table, signed: boolean, isTime: boolean, sampleCount: number, operation: OperationContext): Promise<DecodeRuns> {
  const pages: RunPage[] = []; let sample = 0, clock = 0n, minDelta = Infinity, maxDelta = 0;
  for (let row = 0; row < table.count; row += PAGE_ROWS) {
    pages.push({ row, sample, clock });
    const end = Math.min(table.count, row + PAGE_ROWS);
    await rows(cache, table, row, end, operation, data => {
      for (let at = 0; at < data.byteLength; at += 8) {
        const count = data.getUint32(at), value = data.getUint32(at + 4);
        if (count === 0 || sample + count > sampleCount) fail('MP4 time-run count is inconsistent with sample sizes');
        sample += count;
        if (isTime) {
          minDelta = Math.min(minDelta, value); maxDelta = Math.max(maxDelta, value);
          clock += BigInt(value) * BigInt(count);
          if (clock > MAX_CLOCK) fail('MP4 decode clock exceeds uint64');
        }
      }
    });
  }
  if (sample !== sampleCount) fail('MP4 time runs do not cover every sample');
  return { table, pages, signed, duration: clock, minDelta, maxDelta };
}
function chunkRow(data: DataView, at: number): ChunkRow {
  return { first: data.getUint32(at), count: data.getUint32(at + 4), description: data.getUint32(at + 8) };
}
async function buildChunks(cache: SourceCache, table: Table, chunkCount: number, sizes: SampleSizes, descriptionCount: number, operation: OperationContext): Promise<ChunkTable> {
  const sampleCount = sizes.count;
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
        if (!sizes.fixed && item.count > MAX_SAMPLES_PER_CHUNK) tooLarge('Variable-size samples per MP4 chunk exceed the paged profile');
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
async function dependencyTable(cache: SourceCache, box: Box, sampleCount: number, operation: OperationContext): Promise<Table> {
  verifyFullBox(await header(cache, box, 4, operation), 'sdtp');
  const count = boundedCount(box.end - box.body - 4, 'sdtp');
  if (count !== sampleCount) return fail('MP4 sample dependency count does not match its sample sizes');
  return { start: box.body + 4, count, stride: 1 };
}

// Admit the fixed-width audio roll mapping used by e.g. classic AAC MP4s.
// Using the maximum referenced negative distance is conservative across runs.
async function audioRoll(cache: SourceCache, stbl: readonly Box[], audio: boolean, count: number, operation: OperationContext): Promise<number> {
  const descriptions = one(stbl, 'sgpd'), groups = one(stbl, 'sbgp');
  if (!descriptions && !groups) return 0;
  if (!audio || !descriptions || !groups) return refuse('MP4 sample groups require a separate mapped profile');
  const d = await header(cache, descriptions, 16, operation), g = await header(cache, groups, 12, operation);
  const roll = 0x726f6c6c, width = d.getUint32(8), descriptionsCount = d.getUint32(12), runs = boundedCount(g.getUint32(8), 'audio roll runs');
  if (d.getUint32(0) !== 0x01000000 || g.getUint32(0) !== 0 ||
      d.getUint32(4) !== roll || g.getUint32(4) !== roll || width !== 2 ||
      descriptionsCount < 1 || descriptionsCount > MAX_DESCRIPTIONS) return refuse('MP4 sample groups are not an admitted audio roll mapping');
  const start = groups.body + 12;
  if (descriptions.end - descriptions.body !== 16 + descriptionsCount * width || groups.end - start !== runs * 8) fail('MP4 audio roll table count does not match its extent');
  const distances = await cache.readValue(descriptions.body + 16, descriptions.end, operation, bytes => {
    const data = view(bytes);
    return Array.from({ length: descriptionsCount }, (_, i) => {
      const distance = data.getInt16(i * width);
      if (distance >= 0 || distance < -64) return refuse('MP4 audio roll distance is outside the bounded preroll profile');
      return -distance;
    });
  });
  let covered = 0, max = 0;
  const table = { start, count: runs, stride: 8 };
  for (let row = 0; row < runs; row += PAGE_ROWS) {
    await rows(cache, table, row, Math.min(runs, row + PAGE_ROWS), operation, data => {
      for (let at = 0; at < data.byteLength; at += 8) {
        const samples = data.getUint32(at), description = data.getUint32(at + 4);
        if (samples === 0 || covered + samples > count || description > descriptionsCount) fail('Invalid MP4 audio roll group');
        covered += samples;
        if (description !== 0) max = Math.max(max, distances[description - 1]!);
      }
    });
  }
  if (covered !== count) fail('MP4 audio roll groups do not cover the declared samples');
  return max;
}
function floorIndex<T>(values: readonly T[], present: (value: T) => boolean): number {
  let start = 0, end = values.length;
  while (start < end) { const mid = start + Math.floor((end - start) / 2); if (present(values[mid]!)) start = mid + 1; else end = mid; }
  return start - 1;
}

/** Visit time-run rows without retaining an expanded timeline. Both cursors
 * borrow at most one bounded page. Iterator close returns a page on failure. */
async function* timeRows(cache: SourceCache, runs: RunTable, operation: OperationContext) {
  const { table, signed } = runs;
  for (let row = 0; row < table.count; row += PAGE_ROWS) {
    const end = Math.min(table.count, row + PAGE_ROWS);
    const lease = await cache.readOwned(table.start + row * 8, table.start + end * 8, operation);
    try {
      const data = view(lease.borrow());
      for (let at = 0; at < data.byteLength; at += 8) {
        yield { count: data.getUint32(at), value: signed ? data.getInt32(at + 4) : data.getUint32(at + 4) };
      }
    } finally { lease.release(); }
  }
}

type PlaybackEnvelope = { readonly firstPts: bigint; readonly lastPts: bigint; readonly end: bigint; readonly minimumOffset: number; readonly maximumOffset: number };
async function playbackEnvelope(cache: SourceCache, time: RunTable & { duration: bigint }, composition: RunTable | null, operation: OperationContext): Promise<PlaybackEnvelope> {
  if (!composition) {
    // With no composition offsets, only the last decode delta is needed.
    const { table } = time;
    const lastDelta = await rows(cache, table, table.count - 1, table.count, operation, data => data.getUint32(4));
    return { firstPts: 0n, lastPts: time.duration - BigInt(lastDelta), end: time.duration, minimumOffset: 0, maximumOffset: 0 };
  }
  const compositionRows = timeRows(cache, composition, operation);
  let cto = await compositionRows.next(), remaining = cto.done ? 0 : cto.value.count;
  let clock = 0n, firstPts: bigint | null = null, lastPts: bigint | null = null, end: bigint | null = null;
  let minimumOffset = Infinity, maximumOffset = -Infinity;
  try {
    for await (const { count, value } of timeRows(cache, time, operation)) {
      let left = count;
      const step = BigInt(value);
      while (left > 0) {
        if (remaining === 0) { cto = await compositionRows.next(); remaining = cto.done ? 0 : cto.value.count; }
        if (cto.done || remaining === 0) return fail('MP4 composition and decode runs disagree');
        const used = Math.min(left, remaining), offset = cto.value.value;
        const first = clock + BigInt(offset); clock += BigInt(used) * step;
        const last = clock + BigInt(offset) - step, after = last + step;
        firstPts = firstPts === null || first < firstPts ? first : firstPts;
        lastPts = lastPts === null || last > lastPts ? last : lastPts;
        end = end === null || after > end ? after : end;
        minimumOffset = Math.min(minimumOffset, offset); maximumOffset = Math.max(maximumOffset, offset);
        left -= used; remaining -= used;
      }
    }
    if (firstPts === null || lastPts === null || end === null || clock !== time.duration) return fail('Missing MP4 presentation intervals');
    return { firstPts, lastPts, end, minimumOffset, maximumOffset };
  } finally { await compositionRows.return(undefined); }
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
  readonly #runs = new Map<RunTable, Run>();
  #chunkRun: ChunkRun | null = null;
  #offset: { chunk: number; base: bigint } | null = null;
  #sizeCursor: { chunk: number; index: number; after: bigint } | null = null;
  #syncInterval: { previous: number; next: number } | null = null;
  constructor(cache: SourceCache, tables: IndexTables, payloads: readonly Interval[], id: number, timescale: number, decodeDuration: bigint, descriptions: readonly string[], edits: Mp4EditMap | null) {
    this.#cache = cache; this.#tables = tables; this.#payloads = payloads; this.id = id; this.timescale = timescale;
    this.decodeDuration = decodeDuration; this.edits = edits; this.descriptions = Object.freeze([...descriptions]); this.sampleCount = tables.sizes.count;
    this.checkpointCount = tables.time.pages.length + (tables.composition?.pages.length ?? 0) + tables.chunk.pages.length;
  }
  #check(index: number, operation: OperationContext) {
    checkOperation(operation, browserScheduler);
    this.#cache.assertReadable();
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.sampleCount) throw new EngineError('INVALID_ARGUMENT', 'MP4 sample index is outside the track');
  }
  async #run(runs: RunTable, index: number, operation: OperationContext): Promise<{ clock: bigint; value: number }> {
    const { pages, table, signed } = runs, page = pages[floorIndex(pages, item => item.sample <= index)]!;
    let run = this.#runs.get(runs);
    if (!run || index < run.first || index >= run.end) {
      const resume = run && index >= run.end && run.row >= page.row ? run : null;
      const firstRow = resume ? resume.row + 1 : page.row;
      run = await rows(this.#cache, table, firstRow, Math.min(table.count, page.row + PAGE_ROWS), operation, data => {
        let sample = resume?.end ?? page.sample;
        let clock = resume ? resume.clock + BigInt(resume.end - resume.first) * BigInt(resume.value) : page.clock;
        for (let at = 0; at < data.byteLength; at += 8) {
          const count = data.getUint32(at), value = signed ? data.getInt32(at + 4) : data.getUint32(at + 4);
          if (index < sample + count) return { row: firstRow + at / 8, first: sample, end: sample + count, clock, value };
          sample += count; clock += BigInt(count) * BigInt(value);
        }
        return fail('MP4 sample has no covering time run');
      });
      this.#runs.set(runs, run);
    }
    return { clock: run.clock + BigInt(index - run.first) * BigInt(run.value), value: run.value };
  }
  async #chunk(index: number, operation: OperationContext): Promise<{ chunk: number; firstSample: number; count: number; description: number }> {
    const { chunk: { pages, table }, offsets } = this.#tables;
    const pageIndex = floorIndex(pages, it => it.sample <= index), page = pages[pageIndex]!;
    let item = this.#chunkRun;
    if (!item || index < item.firstSample || index >= item.endSample) {
      const resume = item && index >= item.endSample && item.rowIndex >= page.row ? item : null;
      const firstRow = resume ? resume.rowIndex + 1 : page.row;
      item = await rows(this.#cache, table, firstRow, Math.min(table.count, page.row + PAGE_ROWS), operation, data => {
        let sample = resume?.endSample ?? page.sample;
        for (let at = 0; at < data.byteLength; at += 12) {
          const row = chunkRow(data, at);
          const next = at + 12 < data.byteLength ? data.getUint32(at + 12) : pages[pageIndex + 1]?.chunk ?? offsets.count + 1;
          const count = (next - row.first) * row.count;
          if (index < sample + count) return { rowIndex: firstRow + at / 12, firstSample: sample, endSample: sample + count, row };
          sample += count;
        }
        return fail('MP4 sample has no covering chunk run');
      });
      this.#chunkRun = item;
    }
    const skip = Math.floor((index - item.firstSample) / item.row.count);
    return { chunk: item.row.first - 1 + skip, firstSample: item.firstSample + skip * item.row.count, count: item.row.count, description: item.row.description };
  }
  async #sampleSizes(start: number, index: number, operation: OperationContext): Promise<{ offset: bigint; length: number }> {
    const table = this.#tables.sizes;
    if (table.fixed !== 0) return { offset: BigInt(index - start) * BigInt(table.fixed), length: table.fixed };
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
      return { offset: BigInt(offset), length };
    });
  }
  precedingSync(index: number, operation: OperationContext): Promise<number | null> {
    this.#check(index, operation);
    return this.#sync(index, operation);
  }
  async #sync(index: number, operation: OperationContext): Promise<number | null> {
    const table = this.#tables.sync;
    if (!table) return index;
    const interval = this.#syncInterval;
    if (interval && interval.previous <= index && index < interval.next) return interval.previous === -1 ? null : interval.previous;
    let start = 0, end = table.count, previous = -1, next = this.sampleCount;
    while (start < end) {
      const mid = start + Math.floor((end - start) / 2);
      const number = await rows(this.#cache, table, mid, mid + 1, operation, data => data.getUint32(0) - 1);
      if (number <= index) { start = mid + 1; previous = number; } else { end = mid; next = number; }
    }
    this.#syncInterval = { previous, next };
    return previous === -1 ? null : previous;
  }
  async sample(index: number, operation: OperationContext): Promise<Mp4IndexedSample> {
    this.#check(index, operation);
    const dts = await this.#run(this.#tables.time, index, operation);
    const composition = this.#tables.composition ? (await this.#run(this.#tables.composition, index, operation)).value : 0;
    const chunk = await this.#chunk(index, operation), offsets = this.#tables.offsets;
    const lastOffset = this.#offset;
    const base = lastOffset?.chunk === chunk.chunk ? lastOffset.base :
      await rows(this.#cache, offsets, chunk.chunk, chunk.chunk + 1, operation, data => offsets.stride === 8 ? data.getBigUint64(0) : BigInt(data.getUint32(0)));
    const cursor = this.#sizeCursor;
    const sizes = cursor?.chunk === chunk.chunk && cursor.index + 1 === index
      ? { offset: cursor.after, length: (await this.#sampleSizes(index, index, operation)).length }
      : await this.#sampleSizes(chunk.firstSample, index, operation);
    const start = base + sizes.offset, end = start + BigInt(sizes.length);
    if (end > BigInt(this.#cache.source.size)) fail('MP4 sample span escapes the source');
    const j = floorIndex(this.#payloads, item => BigInt(item.start) <= base), payload = this.#payloads[j];
    if (!payload || base >= BigInt(payload.end) || end > BigInt(payload.end)) fail('MP4 sample span is not contained in its chunk mdat payload');
    const sync = (await this.#sync(index, operation)) === index;
    const dependencies = this.#tables.dependencies;
    if (dependencies) await rows(this.#cache, dependencies, index, index + 1, operation, data => {
      const flags = data.getUint8(0), leading = flags >>> 6, dependsOn = (flags >>> 4) & 3;
      if (leading === 1 || leading === 3) refuse('MP4 leading samples need a separate recovery profile');
      if (dependsOn === 3 || ((flags >>> 2) & 3) === 3 || (flags & 3) === 3) fail('Invalid MP4 sample dependency flags');
      if (sync && dependsOn === 1) fail('MP4 sync sample contradicts its dependency flags');
    });
    checkOperation(operation, browserScheduler);
    this.#cache.assertReadable();
    this.#offset = { chunk: chunk.chunk, base };
    this.#sizeCursor = { chunk: chunk.chunk, index, after: sizes.offset + BigInt(sizes.length) };
    return { index, descriptionIndex: chunk.description, dts: dts.clock, pts: dts.clock + BigInt(composition), duration: BigInt(dts.value), sync, range: byteRange(Number(start), Number(end)) };
  }
  packedPcm(bytesPerFrame: number): (sample: Mp4IndexedSample, mediaEnd: bigint, operation: OperationContext) => Promise<Mp4IndexedSample & { readonly count: number }> {
    const { sizes, time, sync } = this.#tables, fixedFrames = sizes.fixed / bytesPerFrame;
    if (sync || (sizes.fixed !== 0 && (!Number.isInteger(fixedFrames) || fixedFrames !== time.minDelta || fixedFrames !== time.maxDelta))) {
      return refuse('MP4 PCM size, duration or recovery does not match exact PCM frames');
    }
    return async (sample, mediaEnd, operation) => {
      const size = sample.range.end - sample.range.start, frames = Number(sample.duration);
      if (frames * bytesPerFrame !== size) return fail('MP4 PCM sample is not aligned to its exact frame duration');
      const limit = fixedFrames ? Math.floor(8192 / fixedFrames) : 1;
      if (limit <= 1) return { ...sample, count: 1 };
      const { firstSample, count: chunkCount } = await this.#chunk(sample.index, operation);
      const remaining = (mediaEnd - sample.pts + sample.duration - 1n) / sample.duration;
      const count = Math.min(limit, firstSample + chunkCount - sample.index, Number(remaining));
      const span = size * count, start = sample.range.start;
      const payload = this.#payloads[floorIndex(this.#payloads, part => part.start <= start)];
      if (!payload || span > payload.end - start) return fail('MP4 PCM block escapes its mdat payload');
      checkOperation(operation, browserScheduler);
      this.#cache.assertReadable();
      return { ...sample, duration: sample.duration * BigInt(count), range: byteRange(start, start + span), count };
    };
  }
  async locateDts(target: bigint, operation: OperationContext): Promise<number | null> {
    checkOperation(operation, browserScheduler);
    this.#cache.assertReadable();
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

type PlaybackKind = 'video' | 'audio';
type PlaybackTrack = { readonly index: TrackIndex; readonly kind: PlaybackKind; readonly metadata: readonly [Box, Box, Box, Box];
  readonly envelope: PlaybackEnvelope; readonly rollSamples: number };

/** Classic, clear indexed ISO BMFF. One shared raw-page LRU and sparse
 * checkpoints. The caller owns the shared cache. */
export async function openMp4PagedIndex(cache: SourceCache, operation: OperationContext): Promise<readonly Mp4PagedTrack[]> {
  return (await readClassicIndex(cache, operation, false)).indices;
}

// Only the paged playback path requests descriptors and a presentation
// envelope. The standalone index can still interpret wider timing mappings.
async function readClassicIndex(cache: SourceCache, operation: OperationContext, playback: boolean) {
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
  const playbackTracks: PlaybackTrack[] = [];
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
    const mediaHeader = required(mdia, 'mdhd');
    const timescale = await parseTimescale(cache, mediaHeader, operation);
    const handler = playback ? required(mdia, 'hdlr') : one(mdia, 'hdlr');
    const handlerType = handler ? (await header(cache, handler, 12, operation)).getUint32(8) : 0;
    const kind = handlerType === 0x76696465 ? 'video' : handlerType === 0x736f756e ? 'audio' : null;
    if (playback && !kind) refuse('Paged MP4 playback requires audio or video tracks with an admitted handler');
    let edits: Mp4EditMap | null = null;
    if (editsBox) {
      movieTimescale ??= await parseTimescale(cache, mvhd ?? fail('MP4 edit list is missing its movie timescale'), operation);
      edits = await editMap(scanner, editsBox, movieTimescale, timescale, operation);
    }
    const mediaInfo = await scanner.children(required(mdia, 'minf'), operation), stbl = await scanner.children(required(mediaInfo, 'stbl'), operation);
    if (stbl.some(box => ['senc', 'saiz', 'saio', 'stps', 'subs', 'cslg'].includes(box.type))) refuse('MP4 partial sync, subsamples or protection require a separate mapped profile');
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
    if (playback && descriptionCount !== 1) refuse('Paged MP4 playback requires one static sample description per track');
    const descriptions = await scanner.boxes(stsd.body + 8, stsd.end, operation);
    if (descriptions.length !== descriptionCount) fail('MP4 sample description count does not match extent');
    for (const description of descriptions) {
      if (['encv', 'enca', 'encs', 'enct', 'drms', 'drmi'].includes(description.type)) refuse('Encrypted MP4 sample description');
      if ((await header(cache, description, 8, operation)).getUint16(6) !== 1) refuse('MP4 sample data reference is not local reference one');
      if (playback && kind) await verifyPlaybackEntry(scanner, description, kind, operation);
    }
    const stsz = one(stbl, 'stsz'), stz2 = one(stbl, 'stz2'), stco = one(stbl, 'stco'), co64 = one(stbl, 'co64');
    if ((!stsz && !stz2) || (stsz && stz2) || (!stco && !co64) || (stco && co64)) fail('MP4 requires exactly one size and chunk-offset table');
    const sampleSizes = await sizes(cache, (stsz ?? stz2)!, operation);
    const offsets = (await fixedTable(cache, (stco ?? co64)!, stco ? 4 : 8, operation)).table;
    const decoding = await fixedTable(cache, required(stbl, 'stts'), 8, operation);
    const ctts = one(stbl, 'ctts'), compositionInfo = ctts ? await fixedTable(cache, ctts, 8, operation, 1) : null;
    const chunkTable = (await fixedTable(cache, required(stbl, 'stsc'), 12, operation)).table;
    checkpoints += Math.ceil(decoding.table.count / PAGE_ROWS) + Math.ceil((compositionInfo?.table.count ?? 0) / PAGE_ROWS)
      + Math.ceil(chunkTable.count / PAGE_ROWS) + (edits?.segments.length ?? 0);
    if (checkpoints > MAX_RESIDENT_CHECKPOINTS) tooLarge('MP4 total index checkpoints and edit segments exceed the resident limit');
    const time = await buildRuns(cache, decoding.table, false, true, sampleSizes.count, operation);
    const composition = compositionInfo ? await buildRuns(cache, compositionInfo.table, compositionInfo.version === 1, false, sampleSizes.count, operation) : null;
    const chunk = await buildChunks(cache, chunkTable, offsets.count, sampleSizes, descriptions.length, operation);
    const stss = one(stbl, 'stss'), sync = stss ? (await fixedTable(cache, stss, 4, operation)).table : null;
    if (sync) await validateSync(cache, sync, sampleSizes.count, operation);
    const sdtp = one(stbl, 'sdtp'), dependencies = sdtp ? await dependencyTable(cache, sdtp, sampleSizes.count, operation) : null;
    const track = new TrackIndex(cache, { sizes: sampleSizes, offsets, time, composition, chunk, sync, dependencies }, payloads, id, timescale, time.duration, descriptions.map(item => item.type), edits);
    const rollSamples = await audioRoll(cache, stbl, kind === 'audio', sampleSizes.count, operation);
    if (playback && kind && handler) {
      if (!track.sampleCount || time.minDelta === 0) refuse('Paged MP4 playback requires nonempty tracks with positive decode durations');
      playbackTracks.push({ index: track, kind, metadata: [trackHeader, mediaHeader, handler, stsd], rollSamples,
        envelope: await playbackEnvelope(cache, time, composition, operation) });
    }
    indices.push(track);
  }
  checkOperation(operation, browserScheduler);
  return { indices: Object.freeze(indices), playbackTracks, mvhd, fileType: one(top, 'ftyp') ?? one(top, 'styp') };
}

/** Internal metadata extents for the bounded decoder-config probe. No original
 * sample table is passed to that provider. */
export async function readMp4PlaybackIndex(cache: SourceCache, operation: OperationContext) {
  const classic = await readClassicIndex(cache, operation, true);
  return { tracks: classic.playbackTracks, movieHeader: classic.mvhd ?? fail('Missing MP4 mvhd box'), fileType: classic.fileType };
}

/** Classic audio-only ALAC, outside the provider's codec registry. */
export async function openClassicAlac(cache: SourceCache, operation: OperationContext) {
  const [index, ...others] = await openMp4PagedIndex(cache, operation);
  if (!index || others.length || index.descriptions.length !== 1 || index.descriptions[0] !== 'alac') {
    return refuse('Software ALAC requires one classic audio track and one sample configuration');
  }
  const scanner = new Scanner(cache);
  const moov = await scanner.children(required(await scanner.boxes(0, cache.source.size, operation), 'moov'), operation);
  const trak = await scanner.children(required(moov, 'trak'), operation);
  const mdia = await scanner.children(required(trak, 'mdia'), operation);
  const hdlr = await header(cache, required(mdia, 'hdlr'), 12, operation);
  if (hdlr.getUint32(8) !== 0x736f756e) return refuse('ALAC track handler is not audio');
  const info = await scanner.children(required(mdia, 'minf'), operation);
  const stbl = await scanner.children(required(info, 'stbl'), operation);
  const stsd = required(stbl, 'stsd');
  const entry = required(await scanner.boxes(stsd.body + 8, stsd.end, operation), 'alac');
  if ((await header(cache, entry, 28, operation)).getUint16(8) !== 0) return refuse('Unsupported ALAC audio sample-entry version');
  const atom = required(await scanner.boxes(entry.body + 28, entry.end, operation), 'alac');
  if (atom.end - atom.body !== 28) return fail('Invalid ALAC cookie extent');
  const cookie = new Uint8Array(36);
  new DataView(cookie.buffer).setUint32(0, cookie.length);
  cookie.set([0x61, 0x6c, 0x61, 0x63], 4);
  await cache.readValue(atom.body, atom.end, operation, bytes => cookie.set(bytes, 8));
  const config = view(cookie), rate = config.getUint32(32), channels = config.getUint8(21);
  if (config.getUint32(8) !== 0 || config.getUint8(16) !== 0 ||
      ![16, 24].includes(config.getUint8(17)) || rate !== index.timescale ||
      rate < 8000 || rate > 192000 || channels < 1 || channels > 8 ||
      config.getUint32(12) < 1 || config.getUint32(12) > 65536) return refuse('ALAC sample geometry exceeds its exact profile');
  const edit = index.edits?.segments[0];
  if (index.edits && (index.edits.segments.length !== 1 || edit?.mediaStart == null)) return refuse('Software ALAC needs a single contiguous edit');
  const start = edit?.mediaStart ?? 0n;
  const editSamples = edit ? edit.movieEnd * BigInt(rate) / BigInt(index.edits!.movieTimescale) : index.decodeDuration;
  const end = start + editSamples < index.decodeDuration ? start + editSamples : index.decodeDuration;
  if (end <= start || end > BigInt(Number.MAX_SAFE_INTEGER)) return refuse('ALAC presentation interval is not admitted');
  return { index, cookie, rate, channels, start, end };
}

async function trackEdit(cache: SourceCache, trackOrder: number, expectedTracks: number, handler: number, operation: OperationContext): Promise<{
  readonly edit: Mp4EditMap | null; readonly unsupported: boolean;
}> {
  const scanner = new Scanner(cache);
  const root = await scanner.children(required(await scanner.boxes(0, cache.source.size, operation), 'moov'), operation);
  const tracks = root.filter(box => box.type === 'trak'), track = tracks[trackOrder];
  if (tracks.length !== expectedTracks || !track) return { edit: null, unsupported: true };
  const children = await scanner.children(track, operation);
  const mdia = await scanner.children(required(children, 'mdia'), operation);
  if ((await header(cache, required(mdia, 'hdlr'), 12, operation)).getUint32(8) !== handler) return { edit: null, unsupported: true };
  const edits = one(children, 'edts');
  if (!edits) return { edit: null, unsupported: false };
  const movieTimescale = await parseTimescale(cache, required(root, 'mvhd'), operation);
  const mediaTimescale = await parseTimescale(cache, required(mdia, 'mdhd'), operation);
  try {
    const edit = await editMap(scanner, edits, movieTimescale, mediaTimescale, operation);
    if (edit.segments.length !== 1 || edit.segments[0]!.mediaStart === null) return { edit: null, unsupported: true };
    return { edit, unsupported: false };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'UNSUPPORTED_PROFILE') return { edit: null, unsupported: true };
    throw error;
  }
}

/** Derive the audible end from the actual unit-rate MP4 edit, rather than
 * assuming the media-header duration describes the unpadded presentation. */
export async function mp4AudioEditEnd(cache: SourceCache, trackOrder: number, expectedTracks: number, rate: number, operation: OperationContext) {
  const { edit, unsupported } = await trackEdit(cache, trackOrder, expectedTracks, 0x736f756e, operation);
  if (!edit) return { end: null, unsupported };
  const scale = BigInt(edit.movieTimescale);
  // Movie timescales need not represent every audio sample exactly.
  const end = (2n * edit.duration * BigInt(rate) + scale) / (2n * scale);
  return end > 0n && end <= BigInt(Number.MAX_SAFE_INTEGER) ? { end, unsupported: false } : { end: null, unsupported: true };
}

/** mvhd/elst uses the movie presentation clock. mdhd alone can understate
 * the displayed interval of a reordered video track. */
export async function mp4VideoEditEnd(cache: SourceCache, trackOrder: number, expectedTracks: number, operation: OperationContext): Promise<MediaTime | null> {
  const { edit } = await trackEdit(cache, trackOrder, expectedTracks, 0x76696465, operation);
  return edit && edit.duration <= BigInt(Number.MAX_SAFE_INTEGER)
    ? mediaTime(edit.duration, timeBase(1n, BigInt(edit.movieTimescale))) : null;
}
