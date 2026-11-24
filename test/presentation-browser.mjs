import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const { outputFiles } = await build({ entryPoints: ['packages/presentation/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' });
const bundle = outputFiles[0].contents;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body><h1>UBVE presentation checks</h1></body></html>'); return; }
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
  assert.equal(errors.length, 0, errors.join('\n'));
  const evidence = { schema: 'ubve-presentation-browser-v1', recordedAt: new Date().toISOString(),
    status: 'COMPONENT_VERIFIED', qualifiedPlayback: false, gpuExecuted: false, nativeDecoderExecuted: false,
    scope: 'Real AudioWorklet/transferable pool; controlled starvation, frozen media sample, new-epoch reprime, paused seek, exact EOS and graph disposal. Muted output; no physical audio or combined player qualification.', result };
  await mkdir('evidence', { recursive: true }); await writeFile('evidence/presentation-browser.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log('Real AudioWorklet checks passed: startup, starvation latch, late block, reprime, seek, EOS, disposal.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
