import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';
import { rawToRgba } from '../packages/presentation/dist/index.js';
import { compareRgba, scalarToneMap } from './presentation-color-reference.mjs';

const input = 'test/fixtures/primary/combined-720p60.mkv';
const sha256 = data => createHash('sha256').update(data).digest('hex');
// Native FFmpeg is independent fixture preparation only. None of its work is timed.
const decoder = process.env.UBVE_FFMPEG || 'ffmpeg';
const video = execFileSync(decoder, ['-v', 'error', '-i', input, '-map', '0:v:0', '-frames:v', '3', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', '-'], { maxBuffer: 10 * 1024 * 1024 });
const width = 1280, height = 720, yBytes = width * height * 2, cBytes = width * height / 2;
const bytes = yBytes + 2 * cBytes;
assert.equal(video.byteLength, 3 * bytes);
const timings = [];
for (let index = 0; index < 3; index++) {
  const frame = { format: 'I420P10', codedWidth: width, codedHeight: height, visibleRect: { x: 0, y: 0, width, height },
    data: video.subarray(index * bytes, (index + 1) * bytes), color: { transfer: 'pq', primaries: 'bt2020', matrix: 'bt2020-ncl', range: 'limited' },
    planes: [{ offsetBytes: 0, strideBytes: width * 2, rows: height }, { offsetBytes: yBytes, strideBytes: width, rows: height / 2 }, { offsetBytes: yBytes + cBytes, strideBytes: width, rows: height / 2 }] };
  const options = { allowSdrToneMap: true, maximumHeight: 720 };
  const reused = new Uint8ClampedArray(width * height * 4);
  const reference = scalarToneMap(frame, options).data;
  const candidate = rawToRgba(frame, options, reused).data;
  const diff = compareRgba(reference, candidate);
  assert.ok(diff.maxAbsoluteDelta <= 1);
  const trials = [];
  for (let trial = 0; trial < 5; trial++) {
    const pair = {};
    const jobs = { scalar: () => scalarToneMap(frame, options), table: () => rawToRgba(frame, options, reused) };
    for (const name of trial % 2 ? ['table', 'scalar'] : ['scalar', 'table']) {
      const start = performance.now(); jobs[name](); pair[`${name}Ms`] = performance.now() - start;
    }
    trials.push(pair);
  }
  timings.push({ index, rawFrameSha256: sha256(frame.data), referenceRgbaSha256: sha256(reference), candidateRgbaSha256: sha256(candidate), diff, trials });
}
console.log(JSON.stringify({ schema: 'ubve-pq-rgba8-paired-component-v1', scope: 'CPU color/scale and output allocation only; excludes video decode, draw, browser, audio, subtitles and display',
  runtime: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model ?? null,
  input, inputSha256: sha256(readFileSync(input)), warmup: 'one untimed output per implementation and source frame',
  transform: 'PQ BT.2020 limited 10-bit -> Reinhard -> sRGB RGBA8 at 1280x720; scalar fresh output, table reused output', qualification: 'NOT_QUALIFIED', timings }, null, 2));
