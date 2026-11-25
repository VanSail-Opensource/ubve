import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ffprobe = process.env.UBVE_FFPROBE ?? 'ffprobe';
export const maxCases = 128;

export function validateCases(raw, selected = []) {
  const cases = Array.isArray(raw) ? raw : raw?.cases;
  assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= maxCases, `Manifest needs 1–${maxCases} cases`);
  const ids = new Set();
  for (const fixture of cases) {
    assert.match(fixture?.id ?? '', /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(!ids.has(fixture.id), `Duplicate case ID ${fixture.id}`);
    ids.add(fixture.id);
    assert.ok(typeof fixture.path === 'string' && fixture.path.length > 0 && !path.posix.isAbsolute(fixture.path) &&
      !path.win32.isAbsolute(fixture.path) && !fixture.path.includes('\\') && !fixture.path.split('/').some(part => !part || part === '.' || part === '..'),
    `Fixture ${fixture.id} needs a directory-relative POSIX path`);
    assert.match(fixture.sha256 ?? '', /^[a-f0-9]{64}$/);
    if (fixture.bytes !== undefined) assert.ok(Number.isSafeInteger(fixture.bytes) && fixture.bytes > 0);
    assert.ok(['observe', 'playback', 'refusal'].includes(fixture.expect ?? 'observe'), `Unknown expectation for ${fixture.id}`);
  }
  for (const id of selected) assert.ok(ids.has(id), `Unknown selected case ${id}`);
  return cases.filter(fixture => !selected.length || selected.includes(fixture.id));
}

export async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function localFixture(root, fixture) {
  const actualRoot = await realpath(root);
  const filename = await realpath(path.resolve(actualRoot, fixture.path));
  const relative = path.relative(actualRoot, filename);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), 'Fixture resolves outside media root');
  const before = await stat(filename);
  assert.ok(before.isFile(), 'Fixture is not a regular file');
  if (fixture.bytes !== undefined) assert.equal(before.size, fixture.bytes, 'Declared file size differs');
  const actualSha256 = await sha256(filename);
  assert.equal(actualSha256, fixture.sha256, 'Source SHA-256 differs from manifest');
  const after = await stat(filename);
  assert.equal(before.size, after.size, 'Fixture size changed while hashing');
  assert.equal(before.mtimeMs, after.mtimeMs, 'Fixture changed while hashing');
  return { filename, bytes: after.size, sha256: actualSha256 };
}

const numeric = value => /^-?\d+(?:\.\d+)?$/.test(String(value)) && Number.isFinite(Number(value)) ? Number(value) : null;
const cadence = value => {
  const parts = String(value).match(/^(\d+)\/(\d+)$/)?.slice(1).map(Number);
  return parts && parts.every(x => Number.isSafeInteger(x) && x > 0) ? { numerator: parts[0], denominator: parts[1] } : null;
};
export function summarizeProbe(raw, bytes) {
  assert.ok(Array.isArray(raw.streams), 'FFprobe returned no stream list');
  const videoTracks = raw.streams.filter(x => x.codec_type === 'video' && x.disposition?.attached_pic !== 1);
  const video = videoTracks.find(x => x.disposition?.default === 1) ?? videoTracks[0];
  assert.ok(video?.codec_name && Number.isInteger(video.width) && video.width > 0 && Number.isInteger(video.height) && video.height > 0,
    'FFprobe did not admit a video track with known dimensions');
  const duration = numeric(raw.format?.duration) ?? numeric(video.duration);
  assert.ok(duration > 0, 'FFprobe did not find positive duration');
  const probeSize = numeric(raw.format?.size);
  if (probeSize !== null) assert.equal(probeSize, bytes, 'FFprobe disagrees with hashed file size');
  const tracks = raw.streams.map(x => ({ index: x.index, kind: x.codec_type, codec: x.codec_name ?? null, codecTag: x.codec_tag_string ?? null,
    profile: x.profile ?? null, disposition: x.disposition ?? null, sideData: x.side_data_list ?? [], channels: x.channels ?? null,
    channelLayout: x.channel_layout ?? null, sampleRate: numeric(x.sample_rate), language: x.tags?.language ?? null }));
  return { duration, measuredFileBytes: bytes, format: raw.format?.format_name ?? null,
    bytesReportedByProbe: probeSize, averageContainerBitrate: numeric(raw.format?.bit_rate),
    video: { index: video.index, codec: video.codec_name, codecTag: video.codec_tag_string ?? null,
      width: video.width, height: video.height, codedWidth: video.coded_width ?? null, codedHeight: video.coded_height ?? null,
      profile: video.profile ?? null, level: video.level ?? null, pixelFormat: video.pix_fmt ?? null, bitsPerRawSample: numeric(video.bits_per_raw_sample),
      colorPrimaries: video.color_primaries ?? null, transfer: video.color_transfer ?? null, colorSpace: video.color_space ?? null,
      colorRange: video.color_range ?? null, startSeconds: numeric(video.start_time), duration: numeric(video.duration),
      averageBitrate: numeric(video.bit_rate), declaredFrameCount: numeric(video.nb_frames), averageCadence: cadence(video.avg_frame_rate),
      streamCadence: cadence(video.r_frame_rate), sideData: video.side_data_list ?? [] }, tracks };
}

export async function probeFile(filename, bytes) {
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', filename],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return summarizeProbe(JSON.parse(stdout), bytes);
}
export async function probeVersion() {
  const { stdout } = await exec(ffprobe, ['-version'], { timeout: 5000, maxBuffer: 65536 });
  return stdout.split('\n', 1)[0];
}

export function classifyOpenFailure(stage, diagnosticCode, nativeCode, message) {
  const text = String(message ?? '');
  const declaredProfileRefusal = diagnosticCode === 'UNSUPPORTED_PROFILE' && (
    /^Native direct playback is not advertised for /i.test(text) ||
    /^Dolby Vision .+ is signaled in this file\. Dolby Vision output and an implicit compatibility-base fallback are not admitted by this player\.$/i.test(text)
  );
  if (stage === 'open' && (nativeCode === 4 || diagnosticCode === 'UNSUPPORTED_CONTAINER' || declaredProfileRefusal ||
    ((diagnosticCode === 'UNSUPPORTED_CODEC' || diagnosticCode === 'UNSUPPORTED_PROFILE' || diagnosticCode === null) &&
      /does not advertise support|no available playback route accepts|no admitted native soundtrack path|requires an embedded subtitle track|unsupported (?:codec|container|profile)/i.test(text)))) {
    return 'EXPLICIT_UNSUPPORTED_REFUSAL';
  }
  return 'PLAYBACK_FAILED';
}

export function caseSatisfiesExpectation(status, expect = 'observe') {
  if (status === 'FUNCTIONAL_PLAYBACK') return expect !== 'refusal';
  if (status === 'EXPLICIT_UNSUPPORTED_REFUSAL') return expect !== 'playback';
  return false;
}

const delta = (first, last) => Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null;
export function summarizeCadence(frames) {
  let distinct = 0, previous = null;
  for (const frame of frames) {
    if (previous !== null && frame.mediaTime < previous) return { callbackCount: frames.length, monotonicMediaTime: false };
    if (frame.mediaTime !== previous) distinct++;
    previous = frame.mediaTime;
  }
  const first = frames[0], last = frames.at(-1);
  const observedMs = first && last ? delta(first.at, last.at) : null;
  return { callbackCount: frames.length, distinctMediaTimestamps: distinct, monotonicMediaTime: true, observationSpanMs: observedMs,
    observedMediaTimeAdvance: first && last ? delta(first.mediaTime, last.mediaTime) : null,
    callbackRatePerSecond: observedMs > 0 ? (frames.length - 1) * 1000 / observedMs : null,
    compositorPresentedFramesCounterDelta: first && last ? delta(first.presentedFrames, last.presentedFrames) : null };
}
