import assert from 'node:assert/strict';
import test from 'node:test';
import { byteLength, sourceIdentity, validatePacket } from '../packages/core/dist/index.js';
import { BoundedSource, hdr10BaseMode, hevcPacketFilter, openMedia, readDolbyVisionConfig } from '../packages/io-demux/dist/index.js';
import { dolbyBaseCarriage } from './fixtures/dolby-base-carriage.mjs';

test('Only declared HDR10 base profiles with the matching layer flags can pass admission', () => {
  const config = (profile, compatibility, flags) => readDolbyVisionConfig('hvc1', Uint8Array.of(1, 0, profile * 2, 5 * 8 + flags, compatibility * 16));
  assert.equal(hdr10BaseMode(config(8, 1, 5)), 'profile-81');
  assert.equal(hdr10BaseMode(config(7, 6, 7)), 'profile-7');
  for (const args of [[5, 0, 5], [8, 4, 5], [8, 2, 5], [8, 1, 7], [8, 1, 4], [7, 6, 5], [7, 6, 6]]) {
    assert.equal(hdr10BaseMode(config(...args)), null);
  }
  assert.equal(hdr10BaseMode(readDolbyVisionConfig('dvh1', Uint8Array.of(1, 0, 16, 45))), null);
});

test('Declared Matroska P8.1 and P7 strip only RPU/EL while source tracks stay unchanged', async () => {
  for (const [profile, mode] of [[8, 'profile-81'], [7, 'profile-7']]) {
    const fixture = await dolbyBaseCarriage({ profile });
    const media = await openMedia(new Blob([fixture.bytes]));
    try {
      const [track] = media.tracks;
      assert.equal(hdr10BaseMode(track.matroskaTrack.dolbyVision), mode);
      const ordinary = media.packets([track.id]);
      const { value: original } = await ordinary.next();
      assert.equal(original.bytes.bytes, fixture.clean[0].length + (profile === 7 ? 14 : 7));
      const firstPts = original.ptsTicks;
      original.bytes.release(); await ordinary.return();
      let count = 0;
      for await (const packet of media.packets([track.id], { hevc: { trackId: track.id, mode } })) {
        try {
          validatePacket(packet);
          assert.equal(packet.representation.kind, 'repacked');
          assert.equal(packet.dtsTicks, null);
          assert.equal(packet.timingProvenance.kind, 'container-exact');
          if (count === 0) assert.equal(packet.ptsTicks, firstPts);
          const span = packet.sourceSpans[0].range;
          assert.equal(span.end - span.start, fixture.clean[count].length + (profile === 7 ? 14 : 7));
          assert.deepEqual(Buffer.from(packet.bytes.borrow()), fixture.clean[count++]);
        } finally { packet.bytes.release(); }
      }
      assert.equal(count, fixture.clean.length);
      assert.equal(media.snapshot().packets.bytes, 0);
      const filter = hevcPacketFilter(mode, track.codecPrivate), clean = fixture.clean[0];
      assert.throws(() => filter(Buffer.of(0xff, 0xff, 0xff, 0xff, 0x26, 1)), { code: 'INVALID_PACKET' });
      assert.throws(() => filter(Buffer.of(0, 0, 0, 2, 0x7c, 1)), /no base-layer data/);
      assert.throws(() => hevcPacketFilter('ordinary', track.codecPrivate)(Buffer.concat([clean, Buffer.of(0, 0, 0, 2, 0x7c, 1)])), /without a verified HDR10-compatible configuration/);
      if (profile === 8) assert.throws(() => filter(Buffer.concat([clean, Buffer.of(0, 0, 0, 2, 0x7e, 1)])), /unadmitted enhancement layer/);
    } finally { await media.dispose(); }
  }
});

test('Profile 5 never enters the HDR10 base-layer adapter', async () => {
  const { bytes } = await dolbyBaseCarriage({ profile: 5 });
  const media = await openMedia(new Blob([bytes]));
  try {
    const [track] = media.tracks;
    assert.equal(track.matroskaTrack.dolbyVision.profile, 5);
    await assert.rejects(media.packets([track.id], { hevc: { trackId: track.id, mode: 'profile-81' } }).next(), { code: 'UNSUPPORTED_PROFILE' });
    await assert.rejects(media.packets([track.id], { hevc: { trackId: track.id, mode: 'ordinary' } }).next(), { code: 'UNSUPPORTED_PROFILE' });
  } finally { await media.dispose(); }
});

test('MKV cue seeking keeps exact selected packet ranges above 4 GiB', async () => {
  const fixture = await dolbyBaseCarriage({ profile: null, sparse: true });
  const source = new class extends BoundedSource {
    size = byteLength(fixture.size);
    identity = sourceIdentity('sparse-mkv', 'fixed');
    async load(range) {
      const bytes = new Uint8Array(range.end - range.start);
      for (const [base, input] of fixture.segments) {
        const start = Math.max(base, range.start), end = Math.min(base + input.length, range.end);
        if (end > start) bytes.set(input.subarray(start - base, end - base), start - range.start);
      }
      return bytes;
    }
  }();
  const media = await openMedia(source);
  try {
    const [track] = media.tracks;
    assert.equal(media.container, 'matroska');
    assert.equal(media.duration, fixture.duration);
    let count = 0;
    for await (const packet of media.packets([track.id], { startTime: 1.05 })) {
      try {
        validatePacket(packet);
        assert.ok(packet.sourceSpans[0].range.start > 2 ** 32);
        if (count === 0) assert.equal(packet.ptsTicks, 1_000_000_000n);
        assert.deepEqual(Buffer.from(packet.bytes.borrow()), fixture.clean[count++]);
      } finally { packet.bytes.release(); }
    }
    assert.equal(count, fixture.clean.length);
    assert.ok(source.stats.deliveredBytes < 1024 * 1024, 'skip the sparse media gap without reading it');
  } finally { await media.dispose(); }
  assert.equal(source.ledger.snapshot().bytes, 0);
});
