import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { preparePlayback } from '../packages/browser/dist/index.js';
import { openMedia } from '../packages/io-demux/dist/index.js';

const { cases } = JSON.parse(await readFile('test/fixtures/packing/manifest.json', 'utf8'));
const entry = id => cases.find(x => x.id === id);
const sha = x => createHash('sha256').update(x).digest('hex');

test('I02 locked packing tuples identify their actual container and expose selected packet data', async () => {
  for (const row of cases) {
    const raw = await readFile(row.path);
    assert.equal(raw.byteLength, row.bytes, row.id);
    assert.equal(sha(raw), row.sha256, row.id);
    if (row.discClip) continue; // Real disc Worker and SDK playback use the browser lane.
    const media = await openMedia(await openAsBlob(row.path));
    try {
      assert.equal(media.container, row.container, row.id);
      const tracks = media.tracks.filter(track => track.kind !== 'subtitle');
      assert.ok(tracks.length > 0, row.id);
      if (row.audioSampleRate) assert.equal(tracks.find(track => track.kind === 'audio')?.sampleRate, row.audioSampleRate, row.id);
      const seen = new Set();
      for await (const sample of media.packets(tracks.map(track => track.id))) {
        try {
          assert.ok(sample.bytes.borrow().byteLength > 0, row.id);
          seen.add(sample.trackId);
          if (seen.size === tracks.length) break;
        } finally { sample.bytes.release(); }
      }
      assert.equal(seen.size, tracks.length, row.id);
      assert.equal(media.snapshot().packets.items, 0, row.id);
    } finally { await media.dispose(); }
  }
});

test('I02 MPEG-TS rebases one origin without erasing the independent audio/video offset or inventing exact DTS', async () => {
  const row = entry('mpeg-ts');
  const media = await openMedia(await openAsBlob(row.path));
  try {
    const values = [];
    for (const track of media.tracks) {
      const reference = row.reference.streams.find(stream => stream.codec_type === track.kind);
      assert.equal(track.transportPid, Number(reference.id));
      for await (const packet of media.packets([track.id])) {
        try {
          assert.equal(packet.dtsTicks, null);
          assert.equal(packet.timingProvenance.kind, 'api-seconds');
          assert.ok(Math.abs(packet.timingProvenance.originalPtsSeconds - reference.start_pts / 90000) < 1e-8);
          values.push([track.kind, packet.ptsTicks]);
        } finally { packet.bytes.release(); }
        break;
      }
    }
    assert.deepEqual(values, [['video', 23222222n], ['audio', 0n]]);
  } finally { await media.dispose(); }
});

test('I02 MPEG-TS rejects a corrupt current PAT and scrambled transport', async () => {
  const good = await readFile(entry('mpeg-ts').path);
  const scrambled = Buffer.from(good);
  scrambled[3] |= 0x80;
  await assert.rejects(openMedia(new Blob([scrambled])), { code: 'ENCRYPTED_MEDIA' });
  const invalid = Buffer.from(good);
  let broken = false;
  for (let at = 0; at + 188 <= invalid.length; at += 188) {
    if (invalid[at + 1] !== 0x40 || invalid[at + 2] !== 0) continue;
    const payload = Math.floor(invalid[at + 3] / 16) % 4 === 3 ? at + 5 + invalid[at + 4] : at + 4;
    const row = payload + 1 + invalid[payload];
    invalid[row + 8] ^= 1;
    broken = true;
    break;
  }
  assert.equal(broken, true);
  await assert.rejects(openMedia(new Blob([invalid])), { code: 'INVALID_MEDIA', message: /CRC/ });
});

test('I02 standalone PCM seeks by exact file sample, retains byte spans, and refuses truncated chunk extents', async () => {
  for (const id of ['aiff-pcm', 'aifc-pcm', 'caf-pcm']) {
    const data = await readFile(entry(id).path), media = await openMedia(new Blob([data]));
    try {
      const track = media.tracks[0];
      assert.equal(media.duration, 1.28);
      const iterator = media.packets([track.id], { startTime: .56 });
      const { value: packet } = await iterator.next();
      try {
        assert.equal(packet.ptsTicks, 24576n);
        assert.equal(packet.dtsTicks, packet.ptsTicks);
        assert.equal(packet.timingProvenance.kind, 'container-exact');
        const { range } = packet.sourceSpans[0];
        assert.deepEqual(Buffer.from(packet.bytes.borrow()), data.subarray(range.start, range.end));
      } finally { packet.bytes.release(); await iterator.return(); }
    } finally { await media.dispose(); }
    await assert.rejects(openMedia(new Blob([data.subarray(0, data.length - 1)])), { code: 'INVALID_MEDIA' });
  }
});

test('I07 remote disc images are refused before a native or range request', async () => {
  for (const route of ['automatic', 'managed']) {
    await assert.rejects(preparePlayback({ url: 'https://example.invalid/title.iso' }, {}, new AbortController().signal, route),
      { code: 'UNSUPPORTED_PROFILE', message: /local file/ });
  }
});
