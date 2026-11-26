import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { byteLength, sessionStamp, sourceIdentity, validatePacket } from '../packages/core/dist/index.js';
import { BlobSource, BoundedSource, openMedia } from '../packages/io-demux/dist/index.js';
import { fragmentedMp4Fixture, gopPictures, largeMp4Fixture, padClassicMoov, sparsePcmMovie } from './fixtures/paged-mp4.mjs';

function sparseSource(fixture) {
  return new class extends BoundedSource {
    size = byteLength(fixture.size);
    identity = sourceIdentity(`paged-sparse-${crypto.randomUUID()}`, 'fixed');
    async load(range) {
      const bytes = new Uint8Array(range.end - range.start);
      for (const [base, section] of fixture.segments) {
        const start = Math.max(base, range.start), end = Math.min(base + section.length, range.end);
        if (end > start) bytes.set(section.subarray(start - base, end - base), start - range.start);
      }
      return bytes;
    }
  }();
}

function verifyPacket(packet, expected) {
  try {
    validatePacket(packet);
    assert.equal(packet.representation.kind, 'source-exact');
    assert.equal(packet.timingProvenance.kind, 'container-exact');
    assert.deepEqual(packet.sourceSpans.map(span => span.range), [{ start: expected.start, end: expected.end }]);
    assert.deepEqual(Buffer.from(packet.bytes.borrow()), expected.bytes);
  } finally { packet.bytes.release(); }
}

test('I10 classic MP4 over the old cap opens with exact paged A/V packets', async () => {
  const fixture = await largeMp4Fixture();
  const source = new BlobSource(new Blob([fixture.bytes]));
  const media = await openMedia(source);
  try {
    assert.equal(media.input, null, 'do not open the original tables in Mediabunny');
    const [video, audio] = media.tracks;
    assert.deepEqual([video.codec, video.width, video.height], ['avc', 32, 24]);
    assert.deepEqual([audio.codec, audio.sampleRate, audio.channelCount, audio.audioEndSample], ['aac', 48000, 1, 276480000n]);
    assert.match(media.mimeType, /avc1.*mp4a/);
    assert.equal(media.duration, fixture.duration);
    const opened = media.snapshot();
    assert.ok(opened.parserMetadata.entries > 262_144);
    assert.equal(opened.parserMetadata.requiresPaged, true);
    assert.ok(opened.pagedMp4.codecProbeBytes < 4096);
    assert.ok(opened.pagedMp4.checkpoints < 64);
    assert.equal(opened.pagedMp4.samples, fixture.audioSamples + fixture.videoSamples);
    assert.equal(opened.cache.provider.reads, 0);
    assert.ok(source.stats.deliveredBytes < source.size, 'open does not read the entire file');
    const leading = [];
    for await (const packet of media.packets([video.id])) {
      leading.push([packet.ptsTicks, packet.dtsTicks, packet.durationTicks, packet.recovery]);
      verifyPacket(packet, fixture.videoPacket(packet.decodeSequence));
      if (leading.length === 4) break;
    }
    assert.deepEqual(leading, [[0n, 0n, 512n, 'key'], [1536n, 512n, 512n, 'delta'], [512n, 1024n, 512n, 'delta'], [1024n, 1536n, 512n, 'delta']]);
    const rolling = media.packets([audio.id]);
    try {
      const { value: firstAudio } = await rolling.next();
      assert.equal(firstAudio.ptsTicks, -1024n, 'timeline preserves AAC priming');
      verifyPacket(firstAudio, fixture.audioPacket(0));
    } finally { await rolling.return(); }
  } finally { await media.dispose(); }
  assert.equal(source.ledger.snapshot().bytes, 0);
  assert.equal(media.snapshot().packets.bytes, 0);
});

test('I10 deep paged seek over ETag-bound ranges preserves preroll, epoch identity and the final packets', async t => {
  const fixture = await largeMp4Fixture(), etag = '"paged-mp4-fixture"';
  let largestRange = 0;
  const server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    const start = Number(match?.[1]), end = Number(match?.[2]) + 1;
    if (!match || start >= end || end > fixture.bytes.length || (end - start !== 1 && request.headers['if-match'] !== etag)) {
      response.writeHead(416).end(); return;
    }
    largestRange = Math.max(largestRange, end - start);
    response.writeHead(206, { ETag: etag, 'Content-Range': `bytes ${start}-${end - 1}/${fixture.bytes.length}`, 'Content-Length': end - start })
      .end(fixture.bytes.subarray(start, end));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const stamp = sessionStamp('paged-seek', 1), media = await openMedia({ url: `http://127.0.0.1:${server.address().port}/large.mp4` }, { stamp });
  try {
    const [video, audio] = media.tracks, selected = [video.id, audio.id];
    const cancel = new AbortController(), seek = fixture.duration - 0.5;
    const retired = media.packets(selected, { startTime: seek, stamp, signal: cancel.signal });
    const first = await retired.next(); first.value.bytes.release();
    cancel.abort();
    await assert.rejects(retired.next(), { code: 'CANCELLED' });
    const next = sessionStamp('paged-seek', 2);
    const positions = new Map([[video.id, []], [audio.id, []]]);
    for await (const packet of media.packets(selected, { startTime: seek, stamp: next })) {
      assert.deepEqual(packet.stamp, next);
      positions.get(packet.trackId).push([packet.decodeSequence, packet.ptsTicks, packet.recovery]);
      verifyPacket(packet, packet.trackId === video.id ? fixture.videoPacket(packet.decodeSequence) : fixture.audioPacket(packet.decodeSequence));
    }
    assert.deepEqual(positions.get(video.id)[0], [fixture.videoSamples - gopPictures, BigInt(fixture.videoSamples - gopPictures) * 512n, 'key']);
    assert.equal(positions.get(video.id).length, gopPictures);
    const audioStart = Math.floor((seek - 0.2) * 48000 / 1024); // edit origin adds one, the roll group subtracts one
    assert.equal(positions.get(audio.id)[0][0], audioStart);
    assert.deepEqual(positions.get(audio.id).at(-1), [fixture.audioSamples - 1, BigInt(fixture.audioSamples - 2) * 1024n, 'key']);
    assert.ok(largestRange <= 256 * 1024);
    assert.ok(media.snapshot().cache.peakBytes <= 8 * 1024 * 1024);
    assert.equal(media.snapshot().packets.bytes, 0);
  } finally { await media.dispose(); }
  assert.equal(media.snapshot().cache.bytes, 0);
});

test('I10 paged playback rejects a large sample count that does not match the table bytes', async () => {
  const fixture = await largeMp4Fixture({ brokenSizeCount: true });
  const source = new BlobSource(new Blob([fixture.bytes]));
  await assert.rejects(openMedia(source), { code: 'INVALID_PACKET', message: 'MP4 sample-size count does not match its extent' });
  assert.equal(source.ledger.snapshot().bytes, 0);
});

test('I10 fragmented MP4 admits a long file without expanding its aggregate sample count', async () => {
  const fixture = await fragmentedMp4Fixture();
  const source = new BlobSource(new Blob([fixture.bytes])), media = await openMedia(source);
  try {
    const [audio] = media.tracks, snapshot = media.snapshot();
    assert.equal(audio.codec, 'aac');
    assert.equal(media.duration, fixture.durationTicks / 48000);
    assert.ok(snapshot.parserMetadata.entries > 262_144);
    assert.equal(snapshot.parserMetadata.requiresPaged, undefined);
    assert.deepEqual(snapshot.parserMetadata.fragments, { count: fixture.fragmentCount, peakSamples: fixture.samplesPerFragment, lookupRows: fixture.fragmentCount });
    let packets = 0, lastPts = -1n;
    for await (const packet of media.packets([audio.id], { startTime: media.duration - 0.5 })) {
      try {
        assert.deepEqual(Buffer.from(packet.bytes.borrow()), fixture.payload);
        assert.equal(packet.timingProvenance.kind, 'api-seconds');
        assert.ok(packet.ptsTicks > lastPts); lastPts = packet.ptsTicks; packets++;
      } finally { packet.bytes.release(); }
    }
    assert.ok(packets > 20 && packets < 45, 'seek reads only the selected tail plus preroll');
    assert.equal(lastPts, BigInt(Math.round((fixture.durationTicks - 1024) / 48000 * 1e9)));
    assert.ok(media.snapshot().cache.peakBytes <= 8 * 1024 * 1024);
  } finally { await media.dispose(); }
  assert.equal(source.ledger.snapshot().bytes, 0);
});

test('I10 long fragmented MP4 still refuses a single unbounded fragment', async () => {
  const fixture = await fragmentedMp4Fixture({ oversizedFragment: true });
  await assert.rejects(openMedia(new Blob([fixture.bytes])), { code: 'ITEM_TOO_LARGE', message: 'Expanded MP4 fragment exceeds 262144 samples' });
});

test('I10 fixed-size PCM in sparse MOV seeks above 4 GiB in exact frame blocks', async () => {
  const fixture = await sparsePcmMovie(2_200_000_000, 2_200_000_000);
  const source = sparseSource(fixture);
  const media = await openMedia(source);
  try {
    const [audio] = media.tracks;
    assert.equal(media.container, 'quicktime');
    assert.equal(audio.codec, 'pcm-s16');
    assert.equal(audio.audioEndSample, BigInt(fixture.frames));
    const fromFrame = fixture.frames - 24000, seek = fromFrame / 48000, seen = [];
    for await (const packet of media.packets([audio.id], { startTime: seek })) {
      try {
        validatePacket(packet);
        const length = packet.bytes.borrow().length, range = packet.sourceSpans[0].range;
        assert.equal(range.start, fixture.dataAt + packet.decodeSequence * 2);
        assert.ok(range.start > 2 ** 32);
        assert.equal(length, Number(packet.durationTicks) * 2);
        assert.ok(length <= 8192 * 2);
        seen.push([packet.decodeSequence, Number(packet.durationTicks), [...packet.bytes.borrow().subarray(-2)]]);
      } finally { packet.bytes.release(); }
    }
    assert.ok(Math.abs(seen[0][0] - fromFrame) <= 1);
    assert.ok(seen.length >= 3 && seen.length <= 5);
    assert.equal(seen.at(-1)[0] + seen.at(-1)[1], fixture.frames);
    assert.deepEqual(seen.at(-1)[2], [0x12, 0x34]);
    assert.ok(source.stats.deliveredBytes < 1024 * 1024);
  } finally { await media.dispose(); }
  assert.equal(source.ledger.snapshot().bytes, 0);
});

test('I10 oversized classic metadata does not tie paging to one codec', async () => {
  for (const [name, codecs] of [['modern/avc-aac.mp4', ['avc', 'aac']], ['modern/hevc-main10.mp4', ['hevc']],
    ['modern/vp9-profile2.mp4', ['vp9']], ['modern/alac-24.m4a', ['alac']], ['modern/pcm-24.mov', ['pcm-s24be']], ['paged-av1-seed.mp4', ['av1']]]) {
    const original = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    const source = sparseSource(padClassicMoov(original)), media = await openMedia(source);
    try {
      assert.deepEqual(media.tracks.map(track => track.codec), codecs, name);
      assert.equal(media.preflight.requiresPaged, true);
      assert.ok(media.preflight.moovBytes > 16 * 1024 * 1024);
      assert.ok(source.stats.deliveredBytes < 1024 * 1024, 'do not allocate the sparse free box');
      const firstOfEach = new Set();
      for await (const packet of media.packets(media.tracks.map(track => track.id))) {
        try {
          validatePacket(packet);
          const [{ range }] = packet.sourceSpans;
          assert.deepEqual(Buffer.from(packet.bytes.borrow()), original.subarray(range.start, range.end), name);
          firstOfEach.add(packet.trackId);
        } finally { packet.bytes.release(); }
        if (firstOfEach.size === codecs.length) break;
      }
      assert.equal(firstOfEach.size, codecs.length, name);
    } finally { await media.dispose(); }
  }
});
