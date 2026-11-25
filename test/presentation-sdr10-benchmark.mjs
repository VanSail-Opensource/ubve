import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rawToRgba } from '../packages/presentation/dist/index.js';

const [filename, cap, startArg, preparedRaw] = process.argv.slice(2);
if (!filename) throw new Error('Usage: node test/presentation-sdr10-benchmark.mjs <local-media> [maximum-output-height] [start-seconds] [prepared-raw-file]');
const start = Number(startArg ?? 0);
assert.ok(Number.isFinite(start) && start >= 0, 'Invalid start time');
const previousModule = process.env.UBVE_SDR10_BASELINE_MODULE;
const baseline = previousModule ? (await import(pathToFileURL(resolve(previousModule)).href)).rawToRgba : rawToRgba;
assert.equal(typeof baseline, 'function');
const asHash = data => createHash('sha256').update(data).digest('hex');
const hashSource = async file => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const sourceSha256 = await hashSource(filename);
const ffprobe = process.env.UBVE_FFPROBE || 'ffprobe', ffmpeg = process.env.UBVE_FFMPEG || 'ffmpeg';
const source = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', filename], { encoding: 'utf8' })).streams[0];
assert.ok(source && source.pix_fmt === 'yuv420p10le', 'Expected a genuine 10-bit planar 4:2:0 source');
assert.ok(['bt709', 'smpte170m', 'bt470bg'].includes(source.color_space), 'Expected an admitted SDR YUV matrix');
const declaredSdrTransfers = ['bt709', 'smpte170m', 'iec61966-2-1', 'srgb'];
const interpretation = process.env.UBVE_SDR10_TRANSFER_OVERRIDE || null;
if (interpretation !== null) {
  assert.ok(!source.color_transfer || source.color_transfer === 'unknown', 'Do not override a known source transfer');
  assert.ok(declaredSdrTransfers.includes(interpretation), 'Unsupported SDR interpretation override');
}
const transfer = interpretation ?? source.color_transfer;
assert.ok(declaredSdrTransfers.includes(transfer), 'Expected a declared SDR transfer or explicit SDR interpretation override');
assert.ok(['tv', 'pc'].includes(source.color_range), 'Unknown source range');
const width = source.width, height = source.height, maximumHeight = Number(cap ?? height);
assert.ok(Number.isSafeInteger(maximumHeight) && maximumHeight > 0);
const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2), yBytes = width * height * 2, chromaBytes = cw * ch * 2;
const frameBytes = yBytes + chromaBytes * 2;
// Decode is preparation outside the timer. No source format/bit-depth conversion.
const content = preparedRaw ? readFileSync(preparedRaw) : execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(start), '-i', filename, '-map', '0:v:0', '-frames:v', '3',
  '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', '-'], { maxBuffer: frameBytes * 3 + 65536 });
const frameCount = content.byteLength / frameBytes;
assert.ok(Number.isInteger(frameCount) && frameCount >= 1, 'No complete source picture at the selected start time');
const trials = [];
for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
  const aligned = new Uint8Array(frameBytes);
  aligned.set(content.subarray(frameIndex * frameBytes, (frameIndex + 1) * frameBytes));
  const unaligned = new Uint8Array(frameBytes + 1).subarray(1);
  unaligned.set(aligned);
  const common = { format: 'I420P10', codedWidth: width, codedHeight: height, visibleRect: { x: 0, y: 0, width, height },
    color: { primaries: source.color_primaries ?? null, matrix: source.color_space, transfer, range: source.color_range === 'tv' ? 'limited' : 'full' },
    planes: [{ offsetBytes: 0, strideBytes: width * 2, rows: height }, { offsetBytes: yBytes, strideBytes: cw * 2, rows: ch },
      { offsetBytes: yBytes + chromaBytes, strideBytes: cw * 2, rows: ch }] };
  const base = { ...common, data: previousModule ? aligned : unaligned }, candidate = { ...common, data: aligned };
  const options = { maximumHeight }, expected = baseline(base, options), actual = rawToRgba(candidate, options);
  assert.deepEqual(actual.data, expected.data, `Output differs for picture ${frameIndex}`);
  const observed = [];
  for (let i = 0; i < 3; i++) { baseline(base, options, expected.data); rawToRgba(candidate, options, actual.data); }
  for (let i = 0; i < 7; i++) {
    const pair = {};
    for (const variant of ((i + frameIndex) % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized'])) {
      const t0 = performance.now();
      if (variant === 'baseline') baseline(base, options, expected.data);
      else rawToRgba(candidate, options, actual.data);
      pair[`${variant}Ms`] = performance.now() - t0;
    }
    observed.push(pair);
  }
  trials.push({ frameIndex, frameSha256: asHash(aligned), outputSha256: asHash(actual.data), outputWidth: actual.width, outputHeight: actual.height,
    bitIdenticalRgba: true, alternatingTrials: observed });
}
console.log(JSON.stringify({ schema: 'ubve-sdr10-raster-paired-v1', qualification: 'NOT_QUALIFIED', filename: basename(filename), sourceSha256, runtime: process.version,
  comparison: previousModule ? 'separately built previous implementation; same aligned plane bytes' : 'same build generic unaligned fallback vs aligned fast path',
  source: { width, height, codec: source.codec_name, profile: source.profile, pixelFormat: source.pix_fmt, frameRate: source.r_frame_rate,
    primaries: source.color_primaries ?? null, matrix: source.color_space, transfer: source.color_transfer ?? null, range: source.color_range },
  declaredInterpretationOverride: interpretation, rawPreparation: preparedRaw ? 'operator-supplied pre-extracted frames' : 'decoded from input before timers',
  start, maximumHeight, timerBoundary: 'raw-to-RGBA8 CPU transform with output reuse; no source decode, Canvas upload, playback or physical presentation', trials }, null, 2));
