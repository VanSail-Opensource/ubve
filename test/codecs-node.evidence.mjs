// Explicit Node/WASM correctness lane. Browser playback and throughput are different gates.
// Run: npm run build:packages && node scripts/build-codecs.mjs && node --test test/codecs-node.evidence.mjs
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodecNodeProbe } from './helpers/codec-node-probe.mjs';
import { CodecNodeWorker } from './helpers/codec-node-worker.mjs';
import { sessionStamp } from '../packages/core/dist/index.js';
import { Av1Decoder } from '../packages/wasm-adapters/dist/index.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const videoFixture = new URL('./fixtures/primary/combined-720p60.mkv', import.meta.url);
const expected = JSON.parse(await readFile(new URL('./fixtures/primary/codec-reference.json', import.meta.url), 'utf8'));

test('actual pinned four-thread AV1 and TrueHD transfer exact planes, HDR metadata and PCM across epochs', { timeout: 45_000 }, async t => {
  const source = await readFile(videoFixture);
  assert.equal(sha(source), expected.sourceSha256);
  const coach = await CodecNodeProbe.open(source, { threads: 4, outputFrames: 1, audio: true });
  t.after(() => coach.dispose());
  const options = { expectedVideoFrames: expected.videoSha256ByDisplayOrder.length, expectedStaticHdr: expected.hdrStatic };
  const initial = await coach.run(options);
  assert.deepEqual(initial.videoSha256, expected.videoSha256ByDisplayOrder);
  assert.deepEqual(initial.hdr, expected.hdrStatic);
  assert.equal(initial.samples, expected.audioFrames);
  assert.equal(initial.audioSha256, expected.audioS32leSha256);
  assert.equal(initial.observedVideoThreads, 4);
  assert.equal(initial.videoLedgerItemsAtEos, 1, 'EOS resolves while the last recipient holds the only admitted frame slot');
  await coach.reset(sessionStamp(coach.stamp.sessionId, 1));
  assert.equal(coach.video.snapshot().output.items, 0);
  const repeat = await coach.run(options);
  assert.deepEqual(repeat.videoSha256, initial.videoSha256);
  assert.deepEqual(repeat.hdr, initial.hdr);
  assert.equal(repeat.audioSha256, initial.audioSha256);
  assert.equal(repeat.samples, initial.samples);
});

test('actual AV1 worker refuses unsupported geometry and reports the original failed initialization', { timeout: 12_000 }, async () => {
  globalThis.Worker = CodecNodeWorker;
  const assetBaseUrl = new URL('../apps/vue-player/public/vendor/', import.meta.url).href;
  await assert.rejects(Av1Decoder.create({ stamp: sessionStamp('invalid-av1', 0), width: 4097, height: 2160, assetBaseUrl }), { code: 'INVALID_PACKET', message: /geometry\/thread profile/ });
});
