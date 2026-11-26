// An untimed, video-track-only correctness probe for an external clear AV1 fixture.
// npm run test:codecs && node test/av1-file-node.evidence.mjs <path-to-clip> [expected-source-sha256]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodecNodeProbe } from './helpers/codec-node-probe.mjs';

const exec = promisify(execFile), [fixture, expectedSourceSha256] = process.argv.slice(2);
assert.ok(fixture, 'A local fixture path is required');
const workerThreads = Number(process.env.UBVE_AV1_WORKER_THREADS ?? '1');
assert.ok([1, 2, 4].includes(workerThreads), 'Decoder worker count must be 1, 2 or 4');
const prefixPictures = Number(process.env.UBVE_AV1_PREFIX_PICTURES ?? '0');
assert.ok(Number.isSafeInteger(prefixPictures) && prefixPictures >= 0 && prefixPictures <= 60480, 'Picture prefix must be a nonnegative safe integer no greater than 60,480');
const timeoutMs = Number(process.env.UBVE_AV1_VERIFY_TIMEOUT_MS ?? '180000');
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1_800_000, 'Component verification timeout must be between 1 second and 30 minutes');
const nativeReference = process.env.UBVE_AV1_NATIVE_REFERENCE ?? 'libaom-av1';
assert.ok(['libaom-av1', 'libdav1d'].includes(nativeReference), 'Reference must be libaom-av1 or libdav1d');
const file = resolve(fixture);
const digest = createHash('sha256');
for await (const chunk of createReadStream(file)) digest.update(chunk);
const sourceSha256 = digest.digest('hex');
if (expectedSourceSha256) assert.equal(sourceSha256, expectedSourceSha256, 'The selected source differs from the publisher checksum');
const describeHashList = hashes => createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
const checked = (tool, args, options) => exec(tool, args, options).then(x => x.stdout);
const fileArgs = ['-protocol_whitelist', 'file'];
const stdout = await checked('ffprobe', ['-v', 'error', ...fileArgs, '-show_streams', '-show_format', '-of', 'json', file], { timeout: 15_000 });
const info = JSON.parse(stdout);
const video = info.streams.find(stream => stream.codec_type === 'video');
assert.equal(video?.codec_name, 'av1', 'Independent reference requires AV1 as the first video track');
const formats = { yuv420p: 'I420P8', yuv420p10le: 'I420P10' };
assert.ok(formats[video.pix_fmt], `Unsupported independent plane layout: ${video.pix_fmt}`);
const membership = info.streams.filter(stream => stream.codec_type === 'audio').map(stream => stream.codec_name);
const rationalEqual = (a, b) => {
  const left = a?.split('/').map(BigInt), right = b?.split('/').map(BigInt);
  return Boolean(left?.length === 2 && right?.length === 2 && left[1] > 0n && right[1] > 0n && left[0] * right[1] === right[0] * left[1]);
};
const row = {
  status: 'NOT_RUN', evidence: 'VIDEO_COMPONENT_CORRECTNESS_ONLY', qualification: 'NOT_QUALIFIED', performance: null,
  coverage: { scope: prefixPictures ? 'source-picture-prefix' : 'whole-source', requestedPictures: prefixPictures || null, eosCovered: false },
  source: { file: basename(file), sha256: sourceSha256, publisherChecksumVerified: !!expectedSourceSha256, bytes: Number(info.format.size), format: info.format.format_name, width: video.width, height: video.height, nominalCadence: video.r_frame_rate, pixFmt: video.pix_fmt, nonTestedAudioCodecs: membership },
  reference: { decoder: `FFmpeg/${nativeReference}`, output: `${video.pix_fmt} full ordered planes`, sha256: null, frames: null },
  workerThreads, verificationTimeoutMs: timeoutMs,
};
let codec;
try {
  const blob = await openAsBlob(file);
  assert.equal(blob.size, row.source.bytes);
  // Open UBVE before the native reference so unsupported sources fail without a
  // lengthy reference decode. This test supplies a disk-backed Blob, not all file bytes.
  codec = await CodecNodeProbe.open(blob, { threads: workerThreads, outputFrames: 4 });
  const got = await codec.run({ allowUnknownHdrFields: true, pixelFormat: formats[video.pix_fmt], timeoutMs, prefixPictures });
  row.coverage.eosCovered = !prefixPictures;
  row.observed = { frames: got.videoSha256.length, sha256: describeHashList(got.videoSha256), color: got.firstColor, firstStaticHdr: got.hdr ?? null, allHdrFieldsAdmitted: got.allHdrFieldsAdmitted, timingProvenance: got.timingProvenance, decoderThreads: got.observedVideoThreads };
  const hashText = await checked('ffmpeg', ['-nostdin', '-loglevel', 'error', ...fileArgs, '-threads', '2', '-c:v', nativeReference, '-i', file, '-map', '0:v:0', '-threads', '2', '-pix_fmt', video.pix_fmt, '-fps_mode', 'passthrough', ...(prefixPictures ? ['-frames:v', String(prefixPictures)] : []), '-f', 'framehash', '-hash', 'sha256', '-'], { timeout: timeoutMs, maxBuffer: 4 * 1024 ** 2 });
  const frames = hashText.split('\n').filter(line => /^\d+,/.test(line)).map(line => line.split(',').at(-1).trim());
  assert.ok(frames.length, 'Independent decode produced no pictures');
  if (prefixPictures) assert.equal(frames.length, prefixPictures, 'Independent decode ended within the requested picture prefix');
  row.reference.frames = frames.length;
  row.reference.sha256 = describeHashList(frames);
  const differing = frames.flatMap((hash, index) => hash === got.videoSha256[index] ? [] : [index]);
  const mismatch = differing[0] ?? -1;
  row.mismatchCount = differing.length + Math.max(0, got.videoSha256.length - frames.length);
  if (mismatch >= 0) row.firstMismatch = { frame: mismatch, expected: frames[mismatch], actual: got.videoSha256[mismatch] ?? null };
  assert.equal(got.videoSha256.length, frames.length, 'Actual and independent picture counts differ');
  assert.equal(mismatch, -1, 'Decoded plane hash mismatch');
  const meta = JSON.parse(await checked('ffprobe', ['-v', 'error', ...fileArgs, '-select_streams', 'v:0', '-show_frames', '-read_intervals', '%+#24', '-of', 'json', file], { timeout: 15_000 })).frames?.[0];
  assert.ok(meta, 'Independent first decoded frame descriptors are missing');
  const master = meta.side_data_list?.find(x => x.side_data_type === 'Mastering display metadata');
  const light = meta.side_data_list?.find(x => x.side_data_type === 'Content light level metadata');
  row.reference.firstDecodedColor = { primaries: meta.color_primaries ?? null, transfer: meta.color_transfer ?? null, matrix: meta.color_space ?? null, range: meta.color_range ?? null };
  row.reference.staticMasteringObserved = Boolean(master);
  row.reference.staticContentLightObserved = Boolean(light);
  const color = got.firstColor;
  if (['bt709', 'bt2020', 'smpte432'].includes(meta.color_primaries)) assert.equal(color.primaries, meta.color_primaries);
  if (['bt709', 'smpte2084', 'arib-std-b67'].includes(meta.color_transfer)) assert.equal(color.transfer, meta.color_transfer);
  if (meta.color_space === 'bt2020nc') assert.equal(color.matrix, 'bt2020-ncl');
  else if (['bt709', 'bt470bg', 'smpte170m'].includes(meta.color_space)) assert.equal(color.matrix, meta.color_space);
  if (['tv', 'pc'].includes(meta.color_range)) assert.equal(color.range, meta.color_range === 'tv' ? 'limited' : 'full');
  if (master && light) {
    const hdr = got.hdr;
    assert.ok(hdr, 'Decoder omitted reference static metadata');
    for (const point of ['red', 'green', 'blue', 'white']) for (const [index, axis] of ['x', 'y'].entries()) {
      assert.ok(rationalEqual(hdr[point][index], master[`${point === 'white' ? 'white_point' : point}_${axis}`]), `Static mastering ${point} ${axis} mismatch`);
    }
    assert.ok(rationalEqual(hdr.minimumLuminance, master.min_luminance));
    assert.ok(rationalEqual(hdr.maximumLuminance, master.max_luminance));
    assert.equal(hdr.maximumContentLightLevel, light.max_content || null);
    assert.equal(hdr.maximumFrameAverageLightLevel, light.max_average || null);
  }
  row.status = 'EXACT_VIDEO_PLANE_MATCH';
} catch (error) {
  row.status = 'FAILED';
  row.error = { code: error.code ?? null, message: String(error.message).replaceAll(file, basename(file)) };
  process.exitCode = 1;
} finally {
  if (codec) try { await codec.dispose(); row.disposal = 'RETURNED'; }
  catch (error) { row.disposal = 'FAILED'; row.status = 'FAILED'; row.disposalError = String(error.message); process.exitCode = 1; }
  console.log(JSON.stringify(row, null, 2));
}
