import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { caseSatisfiesExpectation, classifyOpenFailure, localFixture, summarizeCadence, summarizeProbe, validateCases } from './helpers/jellyfin-fixtures.mjs';

const fixture = { id: 'sdr-avc-1080p-3m', path: 'SDR/AVC/Test Jellyfin 1080p AVC 3M.mp4', sha256: '0'.repeat(64) };

test('Jellyfin manifest admits nested library names but rejects traversal and duplicate IDs', () => {
  assert.deepEqual(validateCases({ cases: [fixture] }, [fixture.id]), [fixture]);
  for (const bad of ['../outside.mp4', 'SDR/../../outside.mp4', '/outside.mp4', 'C:\\outside.mp4', 'SDR//fixture.mp4']) {
    assert.throws(() => validateCases([{ ...fixture, path: bad }]), /relative POSIX path/);
  }
  assert.throws(() => validateCases([fixture, fixture]), /Duplicate/);
  assert.throws(() => validateCases([fixture], ['misspelled-id']), /Unknown selected/);
});

test('Jellyfin local fixture binds full file SHA and rejects links outside media root', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'jellyfin-fixture-'));
  try {
    const root = path.join(tmp, 'root'); await mkdir(root);
    await writeFile(path.join(root, 'fixture.mp4'), 'test');
    await writeFile(path.join(tmp, 'outside.mp4'), 'test');
    await symlink(path.join(tmp, 'outside.mp4'), path.join(root, 'link.mp4'));
    const record = { ...fixture, bytes: 4, path: 'fixture.mp4', sha256: createHash('sha256').update('test').digest('hex') };
    assert.equal((await localFixture(root, record)).bytes, 4);
    await assert.rejects(localFixture(root, { ...record, sha256: '0'.repeat(64) }), /SHA-256/);
    await assert.rejects(localFixture(root, { ...record, path: 'link.mp4' }), /outside media root/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('Independent FFprobe summary ignores attached pictures and preserves rational declared cadence', () => {
  const data = { format: { duration: '29.950000', size: '2000', format_name: 'mov,mp4' }, streams: [
    { index: 0, codec_type: 'video', width: 50, height: 50, codec_name: 'png', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', width: 1920, height: 1080, codec_name: 'av1', avg_frame_rate: '60000/1001', r_frame_rate: '0/0', color_transfer: 'smpte2084' },
  ] };
  const probe = summarizeProbe(data, 2000);
  assert.deepEqual(probe.video.averageCadence, { numerator: 60000, denominator: 1001 });
  assert.equal(probe.video.streamCadence, null);
  assert.equal(probe.video.transfer, 'smpte2084');
  assert.equal(probe.video.index, 1);
  assert.throws(() => summarizeProbe(data, 2500), /hashed file size/);
});

test('An explicit unsupported input differs from a timeout, decode crash or missing bytes', () => {
  assert.equal(classifyOpenFailure('open', 'UNSUPPORTED_PROFILE', null, 'The browser does not advertise support for test'), 'EXPLICIT_UNSUPPORTED_REFUSAL');
  assert.equal(classifyOpenFailure('open', 'UNSUPPORTED_PROFILE', null, 'Native direct playback is not advertised for video/mp4; codecs="hvc1.2.4.L123.B0" by this browser. Repackaging cannot add a missing decoder.'), 'EXPLICIT_UNSUPPORTED_REFUSAL');
  assert.equal(classifyOpenFailure('open', 'UNSUPPORTED_PROFILE', null, 'Dolby Vision P8.1 is signaled in this file. Dolby Vision output and an implicit compatibility-base fallback are not admitted by this player.'), 'EXPLICIT_UNSUPPORTED_REFUSAL');
  assert.equal(classifyOpenFailure('open', null, 4, 'unsupported'), 'EXPLICIT_UNSUPPORTED_REFUSAL');
  assert.equal(classifyOpenFailure('open', 'UNSUPPORTED_CODEC', 3, 'Could not decode'), 'PLAYBACK_FAILED');
  assert.equal(classifyOpenFailure('open', 'DEADLINE_EXCEEDED', null, 'No metadata'), 'PLAYBACK_FAILED');
  assert.equal(classifyOpenFailure('first-play', null, 4, 'unsupported'), 'PLAYBACK_FAILED');
  assert.equal(caseSatisfiesExpectation('FIXTURE_MISSING'), false);
  assert.equal(caseSatisfiesExpectation('EXPLICIT_UNSUPPORTED_REFUSAL', 'playback'), false);
  assert.equal(caseSatisfiesExpectation('EXPLICIT_UNSUPPORTED_REFUSAL', 'observe'), true);
});

test('Cadence observes callback cadence separately from distinct timestamps and compositor counters', () => {
  const frames = [{ at: 10, mediaTime: 0, presentedFrames: 1 }, { at: 20, mediaTime: 0, presentedFrames: 2 }, { at: 30, mediaTime: .033, presentedFrames: 4 }];
  assert.deepEqual(summarizeCadence(frames), { callbackCount: 3, distinctMediaTimestamps: 2, monotonicMediaTime: true, observationSpanMs: 20,
    observedMediaTimeAdvance: .033, callbackRatePerSecond: 100, compositorPresentedFramesCounterDelta: 3 });
  assert.equal(summarizeCadence([]).callbackRatePerSecond, null);
  assert.equal(summarizeCadence([...frames, frames[0]]).monotonicMediaTime, false);
});
