import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const path = 'test/fixtures/disc', disc = 'packages/disc';
const authored = JSON.parse(await readFile(`${path}/authored-bdmv/manifest.json`, 'utf8'));
const udf = JSON.parse(await readFile(`${path}/manifest.json`, 'utf8'));
const { cases: packing } = JSON.parse(await readFile('test/fixtures/packing/manifest.json', 'utf8'));
const packed = packing.find(row => row.id === 'clear-bluray-iso');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const { outputFiles: [bundle] } = await build({ stdin: { contents: `export * from './${disc}/src/index.ts'; export { byteRange, CancellationController } from './packages/core/src/index.ts';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' });
const runtimeHashes = {};
const web = new Map([
  ['/', ['text/html', '<!doctype html><meta charset="utf-8"><title>UBVE real disc-worker fixtures</title>']],
  ['/disc.js', ['text/javascript', bundle.contents]],
]);
for (const file of ['disc-worker.mjs', 'ubve-disc.mjs', 'ubve-disc.wasm']) {
  const data = await readFile(`${disc}/${file === 'disc-worker.mjs' ? 'worker' : 'runtime'}/${file}`);
  runtimeHashes[file] = sha256(data);
  web.set(`/vendor/disc/${file}`, [file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', data]);
}
for (const [file, digest] of Object.entries(authored.files)) {
  const data = await readFile(`${path}/authored-bdmv/${file}`);
  assert.equal(sha256(data), digest);
  web.set(`/fixtures/bdmv/${file}`, ['application/octet-stream', data]);
}
const image = await readFile(`${path}/pattern.udf`);
assert.equal(sha256(image), udf.imageSha256);
web.set('/fixtures/pattern.udf', ['application/octet-stream', image]);
const iso = await readFile(packed.path);
assert.equal(sha256(iso), packed.sha256);
web.set('/fixtures/packed.iso', ['application/octet-stream', iso]);
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const entry = web.get(request.url);
  if (!entry) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', entry[0]); response.end(entry[1]);
});
let browser; const evidence = { schema: 'ubve-disc-browser-v1', recordedAt: new Date().toISOString(), status: 'BLOCKED_OR_FAILED', qualifiedPlayback: false, runtimeHashes, browserProvider: process.env.UBVE_BROWSER_PROVIDER ?? 'playwright-default', fixtureHashes: { bdmv: authored.files, udf: udf.imageSha256, iso: packed.sha256 } };
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}), headless: true, args: ['--disable-gpu'] });
  evidence.browserVersion = browser.version();
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ authored, udf, packed }) => {
    const { DiscSession, DiscTitleReader, byteRange, CancellationController } = await import('/disc.js');
    const fetchBlob = async resource => { const res = await fetch(resource); if (!res.ok) throw Error(`Fixture HTTP ${res.status}`); return res.blob(); };
    const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    let operationId = 0;
    const operation = () => ({ stamp: { sessionId: 'disc-browser', generation: 0 }, operationId: `real-worker-${++operationId}`, deadlineMs: performance.now() + 5000, cancellation: new CancellationController().signal });
    const files = await Promise.all(Object.keys(authored.files).map(async path => ({ path, blob: await fetchBlob(`/fixtures/bdmv/${path}`) })));
    const folder = await DiscSession.open(files);
    let actualTitle, clipHashes = [];
    try {
      const title = DiscTitleReader.select(folder, 0, authored.independentMplsParse.clips.map(() => ({ videoPid: authored.independentFfprobe.video.pid, audioPid: authored.independentFfprobe.audio.pid })));
      const before = title.locate(134999n), after = title.locate(135000n);
      actualTitle = { duration: String(title.duration90k), clips: title.clips.map(clip => clip.path), before: String(before.source90k), after: String(after.source90k), prerollExcluded: title.mapSourceTime(1, 54129600n) === null };
      for (const plan of title.clips) {
        const { source } = await title.openClip(plan.index, operation());
        try {
          const read = await source.readExact(byteRange(0, source.size), operation());
          try { clipHashes.push(await hash(read.bytes.borrow())); } finally { read.bytes.release(); }
        } finally { await source.close(); }
      }
    } finally { await folder.close(); }
    const udfSession = await DiscSession.open(await fetchBlob('/fixtures/pattern.udf'), { udfOnly: true });
    let udfHash;
    try {
      const source = await udfSession.source(udf.file.path), bytes = new Uint8Array(source.size);
      try {
        for (let start = 0; start < source.size; start += 256 * 1024) {
          const read = await source.readExact(byteRange(start, Math.min(source.size, start + 256 * 1024)), operation());
          try { bytes.set(read.bytes.borrow(), start); } finally { read.bytes.release(); }
        }
        udfHash = await hash(bytes);
      } finally { await source.close(); }
    } finally { await udfSession.close(); }
    const isoSession = await DiscSession.open(await fetchBlob('/fixtures/packed.iso'));
    let isoClipHash;
    try {
      const video = packed.reference.streams.find(stream => stream.codec_type === 'video');
      const audio = packed.reference.streams.find(stream => stream.codec_type === 'audio');
      const reader = DiscTitleReader.select(isoSession, packed.discClip.title, [{ videoPid: Number(video.id), audioPid: Number(audio.id) }]);
      const { source } = await reader.openClip(packed.discClip.clip, operation());
      try {
        const read = await source.readExact(byteRange(0, source.size), operation());
        try { isoClipHash = await hash(read.bytes.borrow()); } finally { read.bytes.release(); }
      } finally { await source.close(); }
    } finally { await isoSession.close(); }
    return { userAgent: navigator.userAgent, crossOriginIsolated, actualTitle, clipHashes, udfHash, isoClipHash,
      folderClosed: folder.snapshot(), udfClosed: udfSession.snapshot(), isoClosed: isoSession.snapshot() };
  }, { authored, udf, packed });
  evidence.result = result;
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(result.actualTitle.duration, '180000');
  assert.deepEqual([result.actualTitle.before, result.actualTitle.after, result.actualTitle.prerollExcluded], ['54134999', '54135000', true]);
  assert.deepEqual(result.clipHashes, result.actualTitle.clips.map(clip => authored.files[clip]));
  assert.equal(result.udfHash, udf.file.sha256);
  assert.equal(result.isoClipHash, packed.clipSha256);
  for (const snapshot of [result.folderClosed, result.udfClosed, result.isoClosed]) {
    assert.deepEqual([snapshot.state, snapshot.pending, snapshot.ownedBytes, snapshot.physicalMemoryReclamation], ['closed', 0, 0, 'unobserved']);
  }
  evidence.status = 'COMPONENT_VERIFIED';
  console.log('Real browser FileReaderSync/WASM disc worker verified folder and ISO clip hashes, BDMV inventory, clip trim mapping, UDF hash, and cleanup. Playback unqualified.');
} catch (error) { evidence.error = String(error); throw error; }
finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  const receipt = process.env.UBVE_DISC_BROWSER_OUTPUT ?? 'evidence/disc-browser.json';
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n');
}
