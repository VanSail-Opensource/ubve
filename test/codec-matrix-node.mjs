// Untimed component correctness against a local v8 HDR10 corpus, no browser/physical/throughput claims.
// Run after the codec asset and package builds with: node test/codec-matrix-node.mjs HDR10_DIR OUTPUT_JSON [COMBINED_DIR]
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodecNodeProbe } from './helpers/codec-node-probe.mjs';

const exec = promisify(execFile), [sourceDir, output, combinedDir] = process.argv.slice(2);
if (!sourceDir || !output) throw Error('Usage: node test/codec-matrix-node.mjs HDR10_DIR OUTPUT_JSON [COMBINED_DIR]');
const sha = data => createHash('sha256').update(data).digest('hex');
const ffmpegVersion = (await exec('ffmpeg', ['-version'])).stdout.match(/^ffmpeg version ([0-9.]+)/)?.[1] ?? null;
const record = { schema: 'ubve-node-codec-component-v1', class: 'COMPONENT_CORRECTNESS_ONLY', qualification: 'NOT_QUALIFIED', browser: null, performance: null, reference: { ffmpegVersion, video: 'libaom-av1 -> yuv420p10le', audio: 'truehd -> pcm_s32le where enabled' }, candidate: { av1: 'libmedia-1.3.1-dav1d-atomic', sha256: '9a3048be7f159a6e8976349045a296c7c14a5a3d91f4e2cf52e42c2214025a63', threads: 4, truehd: '@mediabunny/truehd@1.66.4 where enabled' }, rows: [] };
const save = () => writeFile(output, JSON.stringify(record, null, 2) + '\n');
const matrix = new Set(await readdir(sourceDir));
const resolutions = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
const cases = [];
for (const resolution of resolutions) for (const fps of [60, 120]) for (const requestedEncoderTargetMbps of [4, 20, 80]) {
  const basename = `av1-hdr10-pattern-${resolution}-${fps}fps-limited-textured-${requestedEncoderTargetMbps}M.mkv`;
  cases.push({ basename, resolution, fps, requestedEncoderTargetMbps, audio: false, path: matrix.has(basename) ? join(sourceDir, basename) : null });
}
if (combinedDir) {
  const files = new Set(await readdir(combinedDir));
  for (const resolution of resolutions) for (const fps of [60, 120]) {
    const basename = `combined-hdr10-av1-truehd-ass-${resolution}-${fps}fps-20M.mkv`;
    cases.push({ basename, resolution, fps, requestedEncoderTargetMbps: 20, audio: true, path: files.has(basename) ? join(combinedDir, basename) : null });
  }
}
for (const { path, ...details } of cases) {
  const row = { ...details, status: 'NOT_RUN' };
  record.rows.push(row);
  if (!path) { row.status = 'UNAVAILABLE_FIXTURE'; await save(); continue; }
  let probe;
  try {
    const bytes = await readFile(path);
    row.sourceSha256 = sha(bytes); row.sourceBytes = bytes.length;
    const info = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout);
    const video = info.streams.find(stream => stream.codec_type === 'video');
    if (!video || video.codec_name !== 'av1' || `${video.width}x${video.height}` !== row.resolution || video.r_frame_rate !== `${row.fps}/1`) throw Error('Source dimensions, codec or cadence differ from the requested case');
    row.sourceNominalFrameRate = video.r_frame_rate;
    row.sourceContainerBitrateBps = Number(info.format.bit_rate) || null;
    const { stdout } = await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-threads', '2', '-c:v', 'libaom-av1', '-i', path, '-map', '0:v:0', '-threads', '2', '-pix_fmt', 'yuv420p10le', '-f', 'framehash', '-hash', 'sha256', '-']);
    const frames = stdout.split('\n').filter(line => /^\d,/.test(line)).map(line => line.split(',').at(-1).trim());
    if (!frames.length) throw Error('No independent libaom reference pictures');
    row.referencePictures = frames.length; row.referenceOrderedHashListSha256 = sha(JSON.stringify(frames));
    if (row.audio) {
      const pcm = (await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-threads', '2', '-i', path, '-map', '0:a:0', '-c:a', 'pcm_s32le', '-f', 's32le', '-'], { encoding: 'buffer', maxBuffer: 10 * 1024 ** 2 })).stdout;
      row.referencePcmSha256 = sha(pcm);
    }
    probe = await CodecNodeProbe.open(bytes, { threads: 4, audio: row.audio });
    const got = await probe.run({ allowUnknownHdrFields: true });
    row.codecObservedThreads = got.observedVideoThreads;
    row.decodedPictures = got.videoSha256.length; row.actualOrderedHashListSha256 = sha(JSON.stringify(got.videoSha256));
    row.allHdrFieldsAdmittedByDescriptor = got.allHdrFieldsAdmitted; row.firstStaticHdrDescriptor = got.hdr ?? null;
    if (row.audio) { row.actualPcmSha256 = got.audioSha256; row.actualPcmFrames = got.samples; }
    const firstMismatch = frames.findIndex((hash, index) => hash !== got.videoSha256[index]);
    if (firstMismatch >= 0) row.firstVideoMismatch = { frame: firstMismatch, expected: frames[firstMismatch], actual: got.videoSha256[firstMismatch] ?? null };
    if (got.videoSha256.length !== frames.length || firstMismatch !== -1 || (row.audio && row.referencePcmSha256 !== row.actualPcmSha256) || got.observedVideoThreads !== 4) throw Error('Ordered video hashes/count, PCM hash, or observed thread count differ');
    row.status = got.allHdrFieldsAdmitted ? 'EXACT_COMPONENT_MATCH' : 'EXACT_PLANES_HDR_DESCRIPTOR_INCOMPLETE';
  } catch (error) { row.status = 'FAILED'; row.error = { message: error.message ?? String(error), ...(error.code ? { code: error.code } : {}) }; }
  finally {
    if (probe) try { await probe.dispose(); row.disposal = 'RETURNED'; } catch (error) { row.disposal = 'FAILED'; row.disposalError = String(error); row.status = 'FAILED'; }
    console.log(`${row.status} ${row.basename}`);
    await save();
  }
}
await save();
if (record.rows.some(row => row.status === 'FAILED')) process.exitCode = 1;
