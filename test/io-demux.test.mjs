import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { byteRange, sessionStamp } from '../packages/core/dist/index.js';
import { BlobSource, SourceCache, operationContext, preflightMetadata, openMedia, readVint, decodeLacing } from '../packages/io-demux/dist/index.js';

const stamp = sessionStamp('io-test', 0);
const op = (signal) => operationContext(stamp, crypto.randomUUID(), signal);
test('immutable Blob source returns exact boundaries, permits EOF empty reads, and retains ownership until release', async () => {
  const source = new BlobSource(new Blob([new Uint8Array([1, 2, 3, 4])]));
  const read = await source.readExact(byteRange(1, 3), op());
  assert.deepEqual([...read.bytes.borrow()], [2, 3]); assert.equal(source.ledger.snapshot().bytes, 2);
  await source.close(); assert.equal(source.ledger.snapshot().bytes, 2); read.bytes.release(); assert.equal(source.ledger.snapshot().bytes, 0);
  await assert.rejects(source.readExact(byteRange(0, 0), op()), { code: 'DISPOSED' });
  const emptySource = new BlobSource(new Blob());
  const empty = await emptySource.readExact(byteRange(0, 0), op()); assert.equal(empty.bytes.borrow().length, 0); empty.bytes.release();
  await assert.rejects(emptySource.readExact(byteRange(0, 1), op()), { code: 'RANGE_OUTSIDE_SOURCE' }); await emptySource.close();
});
test('cancelled and expired reads never deliver bytes', async () => {
  const source = new BlobSource(new Blob([new Uint8Array(256)])), cancel = new AbortController(); cancel.abort();
  await assert.rejects(source.readExact(byteRange(0, 8), op(cancel.signal)), { code: 'CANCELLED' });
  await assert.rejects(source.readExact(byteRange(0, 8), { ...op(), deadlineMs: -1 }), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(source.ledger.snapshot().bytes, 0); await source.close();
});
test('one shared cache reuses and evicts bounded backing leases', async () => {
  const data = Uint8Array.from({ length: 4096 }, (_, n) => n % 251), source = new BlobSource(new Blob([data])), cache = new SourceCache(source, 512, 256);
  assert.deepEqual(await cache.read(7, 510, op()), data.slice(7, 510));
  await cache.read(100, 200, op()); assert.equal(source.stats.reads, 2);
  await cache.read(700, 900, op()); assert.ok(cache.snapshot().bytes <= 512); assert.ok(cache.snapshot().hits >= 1);
  await cache.close(); assert.equal(source.ledger.snapshot().bytes, 0);
});
test('parser read results remain charged until their actual owner releases them', async () => {
  const source = new BlobSource(new Blob([new Uint8Array(1024)])), cache = new SourceCache(source, 512, 256);
  const result = await cache.readOwned(0, 700, op());
  assert.equal(cache.snapshot().readResults.bytes, 700);
  await cache.read(10, 30, op()); assert.equal(cache.snapshot().readResults.bytes, 720);
  await cache.close(); assert.equal(cache.snapshot().readResults.bytes, 700);
  assert.equal(result.borrow().length, 700); result.release(); assert.equal(cache.snapshot().readResults.bytes, 0);
});
test('cache close rejects queued reads even when every requested page was already cached', async () => {
  const source = new BlobSource(new Blob([new Uint8Array(1024)])), cache = new SourceCache(source, 512, 256);
  const initial = await cache.readOwned(0, 256, op()); initial.release();
  const queued = cache.readOwned(0, 128, op());
  const check = assert.rejects(queued, { code: 'DISPOSED' });
  const firstClose = cache.close(), secondClose = cache.close(); assert.equal(firstClose, secondClose);
  await Promise.all([check, firstClose]); assert.equal(source.ledger.snapshot().bytes, 0); assert.equal(cache.snapshot().readResults.bytes, 0);
});
test('MP4 preflight rejects a declared five-million-entry table before parser allocation', async () => {
  const box = (type, data) => { const out = new Uint8Array(data.length + 8); new DataView(out.buffer).setUint32(0, out.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8); return out; };
  const table = new Uint8Array(12); new DataView(table.buffer).setUint32(8, 5_000_000);
  const bytes = box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsz', table))))));
  const source = new BlobSource(new Blob([bytes])), cache = new SourceCache(source);
  await assert.rejects(preflightMetadata(cache, op()), { code: 'ITEM_TOO_LARGE' }); assert.ok(source.stats.deliveredBytes <= bytes.length); await cache.close();
});
test('EBML uses safe 64-bit values and validates each lacing scheme', () => {
  assert.equal(readVint(new Uint8Array([1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe])).value, (1n << 56n) - 2n);
  assert.deepEqual(decodeLacing(new Uint8Array([1, 2, 3, 4, 5]), 0, 2), { offset: 1, sizes: [2, 2] });
  assert.deepEqual(decodeLacing(new Uint8Array([1, 2, 8, 9, 10, 11]), 0, 1), { offset: 2, sizes: [2, 2] });
  assert.throws(() => decodeLacing(new Uint8Array([1, 255]), 0, 1), { code: 'INVALID_PACKET' });
});
test('real MKV central reader exposes and preserves all video, audio and timed ASS payloads', async () => {
  const bytes = await readFile(new URL('./fixtures/vp9-opus-ass.mkv', import.meta.url));
  const reference = JSON.parse(await readFile(new URL('./fixtures/vp9-opus-ass.ffprobe.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sourceSha256);
  const media = await openMedia(new Blob([bytes]));
  assert.deepEqual(media.tracks.map(t => t.codec), ['vp9', 'opus', 'ass']);
  const counts = [0, 0, 0];
  for await (const packet of media.packets(media.tracks.map(t => t.id))) {
    const index = media.tracks.findIndex(t => t.id === packet.trackId), expected = reference.packets.filter(p => p.stream_index === index)[counts[index]++];
    assert.equal('SHA256:' + createHash('sha256').update(packet.bytes.borrow()).digest('hex'), expected.data_hash);
    assert.equal(packet.dtsTicks, null); assert.equal(packet.timingProvenance.kind, 'container-exact');
    if (index === 2) assert.ok(packet.durationTicks > 0n);
    packet.bytes.release();
  }
  assert.deepEqual(counts, [24, 21, 1]); assert.equal(media.snapshot().packets.bytes, 0); assert.ok(media.snapshot().cache.peakBytes <= 8 * 1024 * 1024);
  await media.dispose(); await assert.rejects(async () => { for await (const _ of media.packets(['mkv:1'])) {} }, { code: 'DISPOSED' });
});
test('duplicate-codec tracks retain container order, language and their own decoder channel configuration', async () => {
  const bytes = await readFile(new URL('./fixtures/duplicate-opus.mkv', import.meta.url));
  const media = await openMedia(new Blob([bytes]));
  const tracks = media.tracks.filter(track => track.kind === 'audio');
  assert.deepEqual(tracks.map(track => [track.id, track.codec, track.language, track.name, track.audioConfig?.numberOfChannels]), [
    ['mkv:2', 'opus', 'fra', 'FrenchMono', 1], ['mkv:3', 'opus', 'jpn', 'JapaneseStereo', 2],
  ]);
  const counts = new Map();
  for await (const packet of media.packets(tracks.map(track => track.id))) { counts.set(packet.trackId, (counts.get(packet.trackId) ?? 0) + 1); packet.bytes.release(); }
  assert.ok(counts.get('mkv:2') > 0 && counts.get('mkv:3') > 0); await media.dispose();
});

test('real AV1/HDR10 + TrueHD + ASS central scan preserves all selected packet hashes, exact ticks and font', async () => {
  const fixture = new URL('./fixtures/primary/combined-720p60.mkv', import.meta.url);
  const bytes = await readFile(fixture), digest = data => createHash('sha256').update(data).digest('hex');
  const manifest = JSON.parse(await readFile(new URL('./fixtures/primary/manifest.json', import.meta.url), 'utf8'));
  assert.equal(digest(bytes), manifest.sha256);
  // ffprobe 7.1.5, -show_packets -show_data_hash sha256. Each column digest is over
  // its UTF-8 LF-terminated values, in per-stream packet/decode order (not sort-by-PTS).
  const expected = [
    [48, 'ea0e5dfaccb9d37ba3f843d432d368745bfd760ae0421d641b8567630c09931a', 'bcb0bcaaba52bef3112e8a2eda9cb65d28b7b1109545bb43528fa28ff2aadfdb'],
    [960, '7064bdb07a2cebcc325238b40834163f73d0b6aef516c4aeeb156a6a813826e5', '1db9271ddf329d805344c85dac7cd607eb3a4832386640aca11e75adc1067f5d'],
    [24, '1547915a386a4a1055aebf5999853d67c376620a68dfe1d295c3ee794bdfa3a6', '69c4bc4fd1640d18c3d0c651e941472be364a6f21f64a64efa4d059a0a626091'],
  ];
  const media = await openMedia(new Blob([bytes]));
  try {
    const [video, audio, subtitle] = media.tracks;
    assert.deepEqual(media.tracks.map(track => track.codec), ['av1', 'truehd', 'ass']);
    assert.deepEqual([video.width, video.height, video.matroskaTrack.color.primaries, video.matroskaTrack.color.transfer, video.matroskaTrack.color.matrix, video.matroskaTrack.color.range], [1280, 720, 9, 16, 9, 1]);
    assert.deepEqual([audio.sampleRate, audio.channelCount], [48000, 6]);
    assert.ok(subtitle.codecPrivate.length > 0);
    assert.deepEqual(media.attachments.map(attachment => [attachment.name, attachment.data.length, digest(attachment.data)]), [
      ['LiberationSans-default.woff2', 145972, '886929903707c5bb28b07cd2eed69921b3d5ef5c49c73a0dd1e187ebf6546a4c'],
    ]);
    const observed = media.tracks.map(() => ({ count: 0, payload: createHash('sha256'), pts: createHash('sha256') }));
    for await (const packet of media.packets(media.tracks.map(track => track.id))) {
      try {
        const index = media.tracks.findIndex(track => track.id === packet.trackId), track = observed[index], data = packet.bytes.borrow();
        assert.equal(packet.decodeSequence, track.count++);
        assert.equal(packet.dtsTicks, null);
        assert.equal(packet.timingProvenance.kind, 'container-exact');
        assert.equal(packet.representation.kind, 'source-exact');
        const [{ range }] = packet.sourceSpans;
        const hash = digest(data);
        assert.equal(hash, digest(bytes.subarray(range.start, range.end)), 'original source-byte span');
        track.payload.update(hash + '\n'); track.pts.update(String(packet.ptsTicks) + '\n');
        if (index === 2) assert.equal(packet.durationTicks, 800000000n);
      } finally { packet.bytes.release(); }
    }
    assert.deepEqual(observed.map(track => [track.count, track.payload.digest('hex'), track.pts.digest('hex')]), expected);
    assert.equal(media.snapshot().packets.bytes, 0);
  } finally { await media.dispose(); }
});

test('selected Matroska track scanning does not load unselected large payloads', async () => {
  const { matroskaPackets } = await import('../packages/io-demux/dist/index.js');
  const ebml = (id, content) => {
    const idBytes = Array.isArray(id) ? id : [id];
    const length = content.length;
    const size = length <= 126 ? [0x80 + length] : [0x20 + Math.floor(length / 65536), (length >> 8) & 255, length & 255];
    return Buffer.concat([Buffer.from(idBytes), Buffer.from(size), Buffer.from(content)]);
  };
  const cluster = ebml([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([
    ebml(0xe7, [0]),
    ebml(0xa3, Buffer.concat([Buffer.from([0x82, 0, 0, 0x80]), Buffer.alloc(1024 * 1024, 17)])),
    ebml(0xa3, [0x81, 0, 9, 0x80, 1, 3, 5]),
  ]));
  const source = new BlobSource(new Blob([cluster])), cache = new SourceCache(source, 256, 64);
  const metadata = { timecodeScaleNs: 1000000n, segmentEnd: cluster.length, firstCluster: 0,
    tracks: [{ number: 1, codecDelayNs: 0n, defaultDurationNs: 1000000n, type: 'video' }] };
  const packets = [];
  for await (const packet of matroskaPackets(cache, metadata, new Set([1]), op)) packets.push([packet.ptsNs, [...packet.data]]);
  assert.deepEqual(packets, [[9000000n, [1, 3, 5]]]);
  assert.ok(source.stats.deliveredBytes <= 192, `unselected packet read amplification: ${source.stats.deliveredBytes}`);
  await cache.close(); assert.equal(source.ledger.snapshot().bytes, 0);
});

test('MP4 preflight rejects encrypted descriptions inside stsd and applies versioned table entry bounds', async () => {
  const box = (type, ...payload) => {
    const data = Buffer.concat(payload), head = Buffer.alloc(8);
    head.writeUInt32BE(data.length + 8); head.write(type, 4);
    return Buffer.concat([head, data]);
  };
  const count = (version, offset, n) => {
    const bytes = Buffer.alloc(offset + 4); bytes[0] = version; bytes.writeUInt32BE(n, offset); return bytes;
  };
  const movie = item => box('moov', box('trak', box('mdia', box('minf', box('stbl', item)))));
  for (const [data, error] of [
    [movie(box('stsd', count(0, 4, 1), box('encv'))), 'UNSUPPORTED_CODEC'],
    [movie(box('sbgp', count(1, 12, 5000000))), 'ITEM_TOO_LARGE'],
    [movie(box('sgpd', count(2, 16, 5000000))), 'ITEM_TOO_LARGE'],
    [Buffer.concat([box('ftyp'), box('moof', box('traf', box('trun', count(0, 4, 5000000))))]), 'ITEM_TOO_LARGE'],
  ]) {
    const source = new BlobSource(new Blob([data])), cache = new SourceCache(source);
    await assert.rejects(preflightMetadata(cache, op()), { code: error });
    assert.equal(cache.snapshot().retainedParserResults, 0, 'preflight only borrows parser buffers');
    await cache.close();
  }
});
