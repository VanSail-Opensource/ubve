import assert from 'node:assert/strict';
import test from 'node:test';
import { CancellationController, byteLength, byteRange, OwnedLease, BudgetLedger, sourceIdentity } from '../packages/core/dist/index.js';
import { openMp4PagedIndex } from '../packages/io-demux/dist/mp4-index.js';
import { SourceCache } from '../packages/io-demux/dist/source.js';

const word = value => { const copy = Buffer.alloc(4); copy.writeUInt32BE(value); return copy; };
const u64 = value => { const copy = Buffer.alloc(8); copy.writeBigUInt64BE(BigInt(value)); return copy; };
const int = value => { const copy = Buffer.alloc(4); copy.writeInt32BE(value); return copy; };
const box = (type, ...body) => Buffer.concat([word(8 + body.reduce((n, part) => n + part.length, 0)), Buffer.from(type), ...body]);
const full = (type, version, ...payload) => box(type, word(version * 0x1000000), ...payload);
const table = (type, rows, version = 0) => full(type, version, word(rows.length), ...rows);
const stsc = (...rows) => table('stsc', rows.map(row => Buffer.concat(row.map(word))));
const sizes = (...items) => full('stsz', 0, word(0), word(items.length), ...items.map(word));
const time = (...runs) => table('stts', runs.map(row => Buffer.concat(row.map(word))));
const offsets = (...numbers) => table('co64', numbers.map(u64));
const row = (...v) => Buffer.concat(v.map(word));
const desc = (type, reference = 1) => box(type, word(0), word(reference));
const DEFAULT_DESCRIPTIONS = table('stsd', [desc('av01'), desc('avc1')]);
const head = (type, id, version = 0) => full(type, version, Buffer.alloc(version === 1 ? 16 : 8), word(id));
const metadata = (tables, trackOptions = {}) => {
  const stsd = trackOptions.descriptions ?? DEFAULT_DESCRIPTIONS;
  const dinf = trackOptions.dinf ?? box('dinf', table('dref', [full('url ', 0, Buffer.alloc(0)).map((number, index) => index === 11 ? 1 : number)]));
  return box('moov', ...(trackOptions.movieTimescale ? [head('mvhd', trackOptions.movieTimescale, trackOptions.version)] : []), box('trak', head('tkhd', 19, trackOptions.version), ...(trackOptions.edits ? [box('edts', trackOptions.edits)] : []), box('mdia', head('mdhd', 90_000, trackOptions.version), box('minf', dinf, box('stbl', stsd, ...tables)))));
};
const identity = sourceIdentity('sparse-fixture', 'fixed-1');
const stamp = { sessionId: 'mp4-test', generation: 4 };
const operation = (cancellation = new CancellationController().signal) => ({ stamp, operationId: 'fixture-1', deadlineMs: performance.now() + 4000, cancellation });
function sparseFixture(segments, length) {
  const ledger = new BudgetLedger({ bytes: byteLength(65536), maxSingleItemBytes: byteLength(32768), items: 10 });
  let readBytes = 0, maxRead = 0;
  const cache = new SourceCache({ size: byteLength(length), identity,
    async readExact(range, op) {
      const size = byteLength(range.end - range.start), reserve = ledger.tryReserve(size);
      assert.ok(reserve, 'fixture source live bytes stay bounded');
      readBytes += size; maxRead = Math.max(maxRead, size);
      const data = new Uint8Array(size);
      for (const [base, segment] of segments) {
        const start = Math.max(base, range.start), end = Math.min(base + segment.length, range.end);
        if (end > start) data.set(segment.subarray(start - base, end - base), start - range.start);
      }
      return { identity, range, stamp: op.stamp, operationId: op.operationId, bytes: OwnedLease.adopt(reserve, data) };
    }, async close() {},
  }, 32768, 4096);
  return { cache, ledger, get readBytes() { return readBytes; }, get maxRead() { return maxRead; } };
}
function wideMdat(size) { return Buffer.concat([word(1), Buffer.from('mdat'), u64(size)]); }
function small(tables, options = {}) {
  const mdat = box('mdat', Buffer.alloc(64, 0xa7)), moov = metadata(tables, options);
  return sparseFixture([[0, mdat], [mdat.length, moov]], mdat.length + moov.length);
}

test('I10 paged MP4 preserves signed composition, description switches, chunk location and sync', async () => {
  const f = small([sizes(3, 5, 2, 6), time([2, 4], [2, 3]), table('ctts', [Buffer.concat([word(1), int(-3)]), Buffer.concat([word(3), int(2)])], 1), stsc([1, 3, 1], [2, 1, 2]), offsets(8, 24), table('stss', [word(2), word(4)])], { version: 1 });
  try {
    const [track] = await openMp4PagedIndex(f.cache, operation());
    assert.deepEqual([track.id, track.timescale, track.sampleCount, track.decodeDuration, track.descriptions], [19, 90000, 4, 14n, ['av01', 'avc1']]);
    const samples = [];
    for (let i = 0; i < 4; i++) samples.push(await track.sample(i, operation()));
    assert.deepEqual(samples.map(({ dts, pts, duration, range, descriptionIndex, sync }) => [dts, pts, duration, range.start, range.end, descriptionIndex, sync]), [
      [0n, -3n, 4n, 8, 11, 1, false], [4n, 6n, 4n, 11, 16, 1, true], [8n, 10n, 3n, 16, 18, 1, false], [11n, 13n, 3n, 24, 30, 2, true],
    ]);
    assert.equal(await track.precedingSync(0, operation()), null);
    assert.equal(await track.precedingSync(2, operation()), 1);
    assert.equal(await track.locateDts(10n, operation()), 2);
    assert.equal(await track.locateDts(100000n, operation()), 3);
    await assert.rejects(track.sample(4, operation()), /outside/);
    await track.sample(0, operation());
    await f.cache.close();
    await assert.rejects(track.sample(0, operation()), { code: 'DISPOSED' });
  } finally { await f.cache.close(); }
  assert.equal(f.ledger.snapshot().bytes, 0);
});

test('I10 five million variable sizes and >32-bit co64 offsets do not expand sample metadata', async () => {
  const count = 5_000_000, stride = 25_000, chunks = count / stride;
  const mdatEnd = 2 ** 40, mdatOffset = mdatEnd - 8_000_000;
  const chunkOffsets = Array.from({ length: chunks }, (_, index) => mdatOffset + index * stride);
  const fullMoov = metadata([full('stsz', 0, word(0), word(count), Buffer.alloc(count * 4, 0)), time([count, 1001]), stsc([1, stride, 1]), offsets(...chunkOffsets)]);
  // The full variable-size table is represented by holes plus one occupied index page;
  // this synthetic source checks exact addressing/geometric bounds, not disk throughput.
  const marker = fullMoov.indexOf(Buffer.from('stsz')) + 16, lastChunk = marker + (count - stride) * 4;
  const endingSizes = Buffer.alloc(stride * 4); for (let i = 0; i < stride; i++) endingSizes.writeUInt32BE(1, i * 4);
  const f = sparseFixture([[0, wideMdat(mdatEnd)], [mdatEnd, fullMoov.subarray(0, marker)], [mdatEnd + lastChunk, endingSizes], [mdatEnd + marker + count * 4, fullMoov.subarray(marker + count * 4)]], mdatEnd + fullMoov.length);
  try {
    const [track] = await openMp4PagedIndex(f.cache, operation());
    assert.equal(track.sampleCount, count); assert.equal(track.checkpointCount, 2);
    assert.equal(f.readBytes < 48_000, true, 'initial open skips the 20 MB size table');
    const sample = await track.sample(count - 1, operation());
    assert.deepEqual(sample.range, byteRange(mdatOffset + count - 1, mdatOffset + count));
    assert.equal(sample.dts, BigInt(count - 1) * 1001n);
    assert.equal(await track.locateDts(sample.dts - 1n, operation()), count - 2);
    assert.equal(f.maxRead, 4096); assert.ok(f.cache.snapshot().peakBytes <= 32768);
    assert.equal(f.cache.snapshot().retainedParserResults, 0);
  } finally { await f.cache.close(); }
  assert.equal(f.ledger.snapshot().bytes, 0);
});

test('I10 all three compact sample sizes handle odd nibbles and chunk boundaries', async () => {
  for (const [packing, data] of [[4, Buffer.from([0x35, 0x27, 0x60])], [8, Buffer.from([3, 5, 2, 7, 6])], [16, Buffer.from([0, 3, 0, 5, 0, 2, 0, 7, 0, 6])]]) {
    const f = small([full('stz2', 0, word(packing), word(5), data), time([5, 1]), stsc([1, 1, 1], [2, 4, 1]), offsets(8, 14), table('ctts', [row(5, 0x80000001)])]);
    try {
      const [track] = await openMp4PagedIndex(f.cache, operation());
      const sample = await track.sample(4, operation());
      assert.deepEqual([sample.range.start, sample.range.end, sample.pts], [28, 34, 0x80000005n]);
    } finally { await f.cache.close(); }
  }
});

test('I10 stsc and stts cross exact checkpoints without dropping the boundary row', async () => {
  const count = 4103, mdatEnd = count + 32;
  const runs = Array.from({ length: count }, (_, i) => [i + 1, 1, i % 2 + 1]);
  const md = metadata([full('stsz', 0, word(1), word(count)), time(...runs.map((_, i) => [1, i % 2])), stsc(...runs), offsets(...runs.map(([i]) => i + 15))]);
  const f = sparseFixture([[0, wideMdat(mdatEnd)], [mdatEnd, md]], mdatEnd + md.length);
  try {
    const [track] = await openMp4PagedIndex(f.cache, operation());
    assert.equal(track.checkpointCount, 4);
    for (const i of [4095, 4096, 4097, count - 1]) {
      const sample = await track.sample(i, operation());
      assert.equal(sample.descriptionIndex, i % 2 + 1);
      assert.equal(sample.dts, BigInt(Math.floor(i / 2)));
      assert.equal(sample.range.start, i + 16);
    }
    assert.equal(await track.locateDts(2048n, operation()), 4097);
  } finally { await f.cache.close(); }
});

test('I10 paged MP4 rejects malformed extents, inconsistent counts, and unsupported clock/protection', async () => {
  const base = [sizes(1, 1), time([2, 1]), stsc([1, 2, 1]), offsets(8)];
  const cases = [
    [[full('stsz', 0, word(0), word(25), word(1)), ...base.slice(1)], {}, /count does not match/],
    [[base[0], time([1, 1]), ...base.slice(2)], {}, /do not cover/],
    [[...base.slice(0, 2), stsc([1, 1, 1]), base[3]], {}, /do not cover/],
    [[...base, table('stss', [word(2), word(1)])], {}, /unordered/],
    [[...base, box('sgpd')], {}, /sample groups/],
    [base, { edits: box('elst') }, /missing its movie timescale/],
    [base, { edits: table('elst', [row(2, 0, 0)]), movieTimescale: 1000 }, /non-unit-rate/],
    [base, { descriptions: table('stsd', [desc('encv')]) }, /Encrypted/],
    [base, { descriptions: table('stsd', [desc('av01', 2)]) }, /not local/],
  ];
  for (const [tables, options, error] of cases) {
    const f = small(tables, options);
    try { await assert.rejects(openMp4PagedIndex(f.cache, operation()), error); }
    finally { await f.cache.close(); }
  }
  const f = small([sizes(2, 1), time([2, 1]), stsc([1, 2, 1]), offsets(71)]);
  try {
    const [track] = await openMp4PagedIndex(f.cache, operation());
    await assert.rejects(track.sample(0, operation()), /mdat payload/);
    const c = new CancellationController(); c.abort(new Error('retired epoch'));
    await assert.rejects(track.sample(1, operation(c.signal)), /retired epoch/);
  } finally { await f.cache.close(); }
});

test('I10 verifies declared sample dependencies before returning an indexed sample', async () => {
  const tables = [sizes(2, 1), time([2, 1]), stsc([1, 2, 1]), offsets(8)];
  const inconsistent = small([...tables, full('sdtp', 0, Buffer.of(0x20))]);
  try { await assert.rejects(openMp4PagedIndex(inconsistent.cache, operation()), /dependency count/); }
  finally { await inconsistent.cache.close(); }
  const contradicting = small([...tables, full('sdtp', 0, Buffer.of(0x20, 0x10))]);
  try {
    const [track] = await openMp4PagedIndex(contradicting.cache, operation());
    assert.equal((await track.sample(0, operation())).sync, true);
    await assert.rejects(track.sample(1, operation()), /contradicts its dependency flags/);
  } finally { await contradicting.cache.close(); }
});

function negative64(value) { const out = Buffer.alloc(8); out.writeBigInt64BE(value); return out; }

test('I10 classic MP4 v0/v1 edit mapping retains empty spans and exact fractional media ticks', async () => {
  for (const version of [0, 1]) {
    const edit = (duration, start) => version === 0 ? Buffer.concat([word(duration), int(start), word(65536)])
      : Buffer.concat([u64(duration), negative64(BigInt(start)), word(65536)]);
    const source = small([sizes(1, 1), time([2, 64000]), stsc([1, 2, 1]), offsets(8)],
      { edits: table('elst', [edit(5, -1), edit(10, 4), edit(1, 25)], version), movieTimescale: 1001, version });
    try {
      const [track] = await openMp4PagedIndex(source.cache, operation());
      assert.equal(track.edits.movieTimescale, 1001);
      assert.equal(track.edits.duration, 16n);
      assert.deepEqual(track.edits.mapMovieTick(4n), { kind: 'gap' });
      assert.deepEqual(track.edits.mapMovieTick(5n), { kind: 'media', mediaTicksNumerator: 4004n, mediaTicksDenominator: 1001n });
      assert.deepEqual(track.edits.mapMovieTick(6n), { kind: 'media', mediaTicksNumerator: 94004n, mediaTicksDenominator: 1001n });
      assert.deepEqual(track.edits.mapMovieTick(15n), { kind: 'media', mediaTicksNumerator: 25025n, mediaTicksDenominator: 1001n });
      assert.deepEqual(track.edits.mapMovieTick(16n), { kind: 'outside' });
      assert.equal((await track.sample(0, operation())).dts, 0n, 'edits do not silently rewrite container ticks');
    } finally { await source.cache.close(); }
  }
});
