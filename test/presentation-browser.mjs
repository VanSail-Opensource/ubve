import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const { outputFiles } = await build({ entryPoints: ['packages/presentation/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' });
const bundle = outputFiles[0].contents;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body><h1>UBVE presentation checks</h1><div id="stage" style="position:relative;width:640px;height:360px;background:#000"><video playsinline></video><div id="overlay"></div></div></body></html>');
    return;
  }
  if (url.pathname === '/presentation.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); return; }
  const asset = path.resolve(root, 'apps/vue-player/public', '.' + decodeURIComponent(url.pathname));
  if (!asset.startsWith(path.join(root, 'apps/vue-player/public') + path.sep)) { response.writeHead(403); response.end(); return; }
  try {
    const bytes = await readFile(asset);
    response.setHeader('Content-Type', asset.endsWith('.wasm') ? 'application/wasm' : asset.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
let browser;
try {
  browser = await chromium.launch({ ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}), headless: true,
    args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async () => {
    const { PcmOutput } = await import('/presentation.js');
    const events = [];
    const audio = await PcmOutput.create({ sampleRate: 48000, channelLabels: ['FL', 'FR'], blockFrames: 256, poolBlocks: 16, primeMs: 8, onEvent: event => events.push(event) });
    audio.setVolume(0);
    const wait = async predicate => {
      const until = performance.now() + 5000;
      while (!predicate()) { if (performance.now() > until) throw new Error('Presentation browser check timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
    };
    const block = new Float32Array(512);
    for (let i = 0; i < 256; i++) { block[i * 2] = i / 65536; block[i * 2 + 1] = -i / 65536; }
    const cancelledStart = audio.start().then(() => 'unexpected-success', error => error.name);
    await audio.pause();
    const cancelledBeforePrime = await cancelledStart;
    if (!audio.tryWrite(block, 0n) || !audio.tryWrite(block, 256n)) throw new Error('Initial pool admission failed');
    const started = await audio.start();
    await wait(() => events.some(event => event.type === 'underrun'));
    const missing = events.find(event => event.type === 'underrun').nextMediaSample;
    audio.tryWrite(block, 512n);
    await wait(() => events.some(event => event.type === 'rejected' && event.reason === 'NOT_ACCEPTING'));
    const frozen = audio.snapshot.nextMediaSample;
    await audio.reset(BigInt(missing));
    if (!audio.tryWrite(block, BigInt(missing)) || !audio.tryWrite(block, BigInt(missing + 256))) throw new Error('Reprime pool admission failed');
    await audio.end(BigInt(missing + 512));
    const restarted = await audio.start();
    await wait(() => events.some(event => event.type === 'ended' && event.epoch === 1));
    const final = audio.snapshot;
    await audio.reset(10000n);
    if (!audio.tryWrite(block, 10000n) || !audio.tryWrite(block, 10256n)) throw new Error('Seek pool admission failed');
    const paused = await audio.pause();
    await audio.end(10512n); await audio.start();
    await wait(() => events.some(event => event.type === 'ended' && event.epoch === 2));
    await audio.dispose();
    return { userAgent: navigator.userAgent, crossOriginIsolated, sampleRate: audio.context.sampleRate,
      started, cancelledBeforePrime, missing, frozen, restarted, final, paused: String(paused),
      disposed: audio.context.state, transportBytes: audio.transportBytes, events };
  });
  assert.equal(result.crossOriginIsolated, true);
  assert.equal(result.missing, 512); assert.equal(result.frozen, 512);
  assert.equal(result.started.type, 'started'); assert.equal(result.restarted.type, 'started');
  assert.equal(result.cancelledBeforePrime, 'AbortError');
  assert.equal(result.final.nextMediaSample, 1024); assert.equal(result.final.underruns, 1);
  assert.equal(result.paused, '10000'); assert.equal(result.disposed, 'closed');
  assert.equal(result.events.filter(e => e.type === 'disposed').length, 1);
  const assFixture = await readFile('test/fixtures/sample.ass', 'utf8');
  const subtitleStartup = await page.evaluate(async fixture => {
    const { SubtitleController } = await import('/presentation.js');
    const video = document.querySelector('video'), overlay = document.querySelector('#overlay');
    const request = video.requestVideoFrameCallback, cancel = video.cancelVideoFrameCallback;
    const requested = [], cancelled = [];
    video.requestVideoFrameCallback = function(callback) {
      const id = request.call(this, callback); requested.push(id); return id;
    };
    video.cancelVideoFrameCallback = function(id) { cancelled.push(id); cancel.call(this, id); };
    try {
      const subtitles = new SubtitleController({ video, overlay });
      window.__ubveSubtitleProbe = subtitles;
      const noSubtitles = requested.length;
      subtitles.setExternalClock(true);
      await subtitles.load({ kind: 'ass', data: fixture });
      const externalClock = requested.length;
      subtitles.followVideo();
      const nativeOverlay = requested.length;
      subtitles.setExternalClock(true);
      return { status: subtitles.getStatus(), nativeClock: { noSubtitles, externalClock, nativeOverlay, requested, cancelled } };
    } finally {
      video.requestVideoFrameCallback = request; video.cancelVideoFrameCallback = cancel;
    }
  }, assFixture);
  const { status: subtitleStatus, nativeClock } = subtitleStartup;
  assert.equal(subtitleStatus.renderer, 'jassub-2.5.38');
  assert.equal(nativeClock.noSubtitles, 0, 'No subtitle selection should register a native frame callback');
  assert.equal(nativeClock.externalClock, 0, 'An externally clocked subtitle overlay should not register a native frame callback');
  assert.equal(nativeClock.nativeOverlay, 1, 'A ready native-clock overlay must register one frame callback');
  assert.deepEqual(nativeClock.cancelled, nativeClock.requested, 'Switching back to the external clock must cancel the native frame callback');
  const capture = async time => {
    await page.evaluate(async time => {
      await window.__ubveSubtitleProbe.renderAt(time, 640, 360);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, time);
    return createHash('sha256').update(await page.locator('#stage').screenshot({ animations: 'disabled' })).digest('hex');
  };
  const assActive = await capture(0.1), assAfterEnd = await capture(0.6), assAfterSeek = await capture(0.1);
  assert.notEqual(assActive, assAfterEnd, 'Real ASS raster must differ during the cue');
  assert.equal(assAfterSeek, assActive, 'Real ASS raster must restore on backward seek');
  const ttml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="en"><head><layout><region xml:id="bottom" tts:origin="10% 65%" tts:extent="80% 25%"/></layout></head><body region="bottom"><div><p begin="0s" end="1s">Timed IMSC cue</p><p begin="1s" end="2s">Next IMSC cue</p></div></body></tt>';
  const imsc = await page.evaluate(async ttml => {
    const subtitles = window.__ubveSubtitleProbe, overlay = document.querySelector('#overlay');
    try {
      await subtitles.load({ kind: 'imsc', data: ttml });
      await subtitles.renderAt(0.5, 640, 360); const first = overlay.textContent;
      await subtitles.renderAt(1.5, 640, 360); const second = overlay.textContent;
      return { first, second, status: subtitles.getStatus() };
    } finally { await subtitles.dispose(); }
  }, ttml);
  assert.equal(imsc.status.renderer, 'imsc-2.0.0');
  assert.match(imsc.first, /Timed IMSC cue/); assert.match(imsc.second, /Next IMSC cue/);
  assert.doesNotMatch(imsc.second, /Timed IMSC cue/);
  const missingBundledFont = await page.evaluate(async fixture => {
    const { SubtitleController } = await import('/presentation.js');
    const subtitles = new SubtitleController({ video: document.querySelector('video'), overlay: document.querySelector('#overlay'),
      assetBaseUrl: '/intentionally-missing-subtitle-assets/' });
    try { await subtitles.load({ kind: 'ass', data: fixture }); return { state: 'unexpected-ready', message: '' }; }
    catch (error) { return { state: subtitles.getStatus().state, message: error.message }; }
    finally { await subtitles.dispose(); }
  }, assFixture);
  assert.equal(missingBundledFont.state, 'failed'); assert.match(missingBundledFont.message, /Bundled ASS fallback font unavailable/);
  assert.equal(errors.length, 0, errors.join('\n'));
  const evidence = { schema: 'ubve-presentation-browser-v1', recordedAt: new Date().toISOString(),
    status: 'COMPONENT_VERIFIED', qualifiedPlayback: false, gpuExecuted: false, nativeDecoderExecuted: false,
    scope: 'Real muted AudioWorklet, JASSUB screenshot witness across cue end/backward seek, and IMSC text update. No native-reference subtitle pixel fidelity, physical audio or combined player qualification.',
    result, subtitles: { ass: { status: subtitleStatus, nativeClock, activeScreenshotSha256: assActive, afterEndScreenshotSha256: assAfterEnd, afterSeekScreenshotSha256: assAfterSeek, missingBundledFont }, imsc } };
  await mkdir('evidence', { recursive: true }); await writeFile('evidence/presentation-browser.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log('Real AudioWorklet, ASS raster and IMSC timed-cue checks passed.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
