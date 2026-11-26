import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile as callbackExec } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { CodecNodeWorker } from './helpers/codec-node-worker.mjs';
import { sessionStamp } from '../packages/core/dist/index.js';
import { openMedia, operationContext } from '../packages/io-demux/dist/index.js';
import { PortableDecoder } from '../packages/wasm-adapters/dist/index.js';

const exec = promisify(callbackExec);
const manifestFile = process.argv[2] ?? 'test/fixtures/modern/manifest.json';
const wanted = new Set(process.argv.slice(3));
const sourceRoot = path.resolve(process.env.UBVE_MODERN_MEDIA_ROOT ?? path.dirname(path.resolve(manifestFile)));
const fixturePack = JSON.parse(await readFile(manifestFile, 'utf8'));
const assetBaseUrl = new URL('../apps/vue-player/public/vendor/', import.meta.url).href;
const sha = x => createHash('sha256').update(x).digest('hex');
const attempt = new Date().toISOString().replaceAll(':', '-') + '-' + process.pid;
const records = [];
globalThis.Worker = CodecNodeWorker;

for (const row of fixturePack.cases) {
  if (wanted.size && !wanted.has(row.id)) continue;
  const file = path.resolve(sourceRoot, row.path);
  const stamp = sessionStamp(crypto.randomUUID(), 0), abort = new AbortController();
  const operation = label => operationContext(stamp, label, abort.signal, 20_000);
  const record = { id: row.id, fixtureSha256: row.sha256, evidenceClass: 'WASM_COMPONENT_CORRECTNESS_NOT_QUALIFIED', status: 'FAILED' };
  records.push(record);
  let decoder, media;
  try {
    assert.equal(sha(await readFile(file)), row.sha256);
    media = await openMedia(await openAsBlob(file), { stamp, signal: abort.signal });
    const track = media.tracks.find(track => track.kind === row.reference.kind);
    assert.ok(track, 'No selected media track');
    const options = { codec: track.codec, description: track.codecPrivate, stamp, assetBaseUrl };
    decoder = track.kind === 'video'
      ? await PortableDecoder.create({ ...options, kind: 'video', width: track.width, height: track.height, color: track.color })
      : await PortableDecoder.create({ ...options, kind: 'audio', sampleRate: track.sampleRate, channels: track.channelCount,
        timestampToleranceSamples: Math.ceil(media.audioTimestampResolutionSeconds * track.sampleRate), endSample: track.audioEndSample });
    const frames = [], blocks = [];
    let nextAudioSample = 0n, audioLayout = null, previousVideoTime = -Infinity, decoded = 0;
    const consume = async () => {
      for (;;) {
        const output = await decoder.readOutput(operation('output-' + decoded++));
        if (!output) return;
        try {
          const value = output.payload.borrow();
          if (value.kind === 'video') {
            const time = Number(output.pts.ticks) * Number(output.pts.timeBase.numerator) / Number(output.pts.timeBase.denominator);
            assert.ok(time >= previousVideoTime, 'Decoded picture presentation order moved backwards');
            previousVideoTime = time;
            frames.push(sha(value.data));
            if (value.signalMetadata?.masteringDisplay.state === 'known') record.hdrSeen = true;
          } else {
            const start = output.pts.ticks, trim = start < 0n ? Number(-start) : 0;
            if (trim >= value.frames) continue;
            assert.equal(start + BigInt(trim), nextAudioSample, 'Output has a gap after trimming startup priming');
            assert.equal(value.sampleRate, row.reference.rate);
            assert.equal(value.channelLabels.length, row.reference.channels);
            audioLayout ??= value.channelLabels;
            assert.deepEqual(value.channelLabels, audioLayout);
            nextAudioSample += BigInt(value.frames - trim);
            const data = value.planes[0].subarray(trim * value.channelLabels.length);
            blocks.push(Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
          }
        } finally { output.payload.release(); }
      }
    };
    const produce = async () => {
      for await (const packet of media.packets([track.id], { stamp, signal: abort.signal })) {
        const submitted = decoder.trySubmit(packet, operation('packet-' + packet.decodeSequence));
        try {
          if (submitted.status !== 'accepted') throw submitted.error ?? Error(submitted.reason);
          await submitted.inputConsumed;
        } finally { packet.bytes.release(); }
      }
      await decoder.flushEndOfStream(operation('eos'));
    };
    const reportOnError = action => action().catch(error => { abort.abort(error); throw error; });
    const settled = await Promise.allSettled([reportOnError(produce), reportOnError(consume)]);
    const rejected = settled.find(x => x.status === 'rejected');
    if (rejected) throw rejected.reason;
    record.decoder = decoder.diagnostics();
    assert.equal(record.decoder.codecEofObserved, true);
    assert.equal(record.decoder.output.items, 0);
    if (row.reference.kind === 'video') {
      record.pictures = frames.length;
      assert.equal(frames.length, row.reference.frames.length, 'Incorrect EOS picture count');
      const wrong = frames.findIndex((value, i) => value !== row.reference.frames[i]);
      assert.equal(wrong, -1, `First incorrect visible picture at ${wrong}`);
    } else {
      record.pcmFrames = Number(nextAudioSample);
      record.channelLabels = audioLayout;
      assert.equal(record.pcmFrames, row.expected.pcmFrames, 'Incorrect audible sample count');
      const pcm = Buffer.concat(blocks);
      record.pcmSha256 = sha(pcm);
      if (row.reference.format === 's32le') assert.equal(record.pcmSha256, row.reference.sha256);
      else {
        const reference = !process.env.UBVE_CHECK_LOSSY_REFERENCE && row.reference.pcmFile
          ? gunzipSync(await readFile(path.join(sourceRoot, row.reference.pcmFile)))
          : (await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-cpuflags', '0', '-threads', '1', '-flags', '+bitexact',
            '-i', file, '-map', '0:a:0', '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { encoding: 'buffer', timeout: 20_000, maxBuffer: 32 * 1024 ** 2 })).stdout;
        assert.equal(sha(reference), row.reference.sha256, 'Independent PCM differed from the reference lock');
        assert.equal(pcm.length, reference.length);
        const peak = Array(row.reference.channels).fill(0), squares = [...peak];
        for (let i = 0; i < pcm.length / 4; i++) {
          const delta = Math.abs(pcm.readFloatLE(i * 4) - reference.readFloatLE(i * 4)), c = i % row.reference.channels;
          peak[c] = Math.max(peak[c], delta); squares[c] += delta * delta;
        }
        record.peakDifference = peak;
        record.rmsDifference = squares.map(v => Math.sqrt(v / record.pcmFrames));
        assert.ok(peak.every(v => v <= row.reference.absoluteTolerance), `peak PCM error ${peak}`);
        assert.ok(record.rmsDifference.every(v => v <= row.reference.rmsTolerance), `RMS PCM error ${record.rmsDifference}`);
      }
    }
    record.status = 'PASSED';
  } catch (error) {
    record.error = { message: error.message, details: error.details ?? null };
    process.exitCode = 1;
  } finally {
    const cleanup = await Promise.allSettled([decoder?.dispose(), media?.dispose()]);
    if (cleanup.some(x => x.status === 'rejected')) { record.cleanup = 'FAILED'; record.status = 'FAILED'; process.exitCode = 1; }
    else record.cleanup = 'PASSED';
    console.log(`${record.id} ${record.status}${record.error ? ' · ' + record.error.message.split('\n')[0] : ''}`);
  }
}
if (!records.length) throw Error('No matching modern codec fixture');
const directory = '.local/modern-evidence';
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, attempt + '.json'), JSON.stringify({ records }, null, 2) + '\n');
