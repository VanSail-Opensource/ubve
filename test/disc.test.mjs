import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import createDisc from '../packages/disc/runtime/ubve-disc.mjs';
import { DiscFolder, DiscSession, locateTitleTime, normalizeDiscPath, validateLinearTitle } from '../packages/disc/dist/index.js';
import { CancellationController, byteRange } from '../packages/core/dist/index.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = new URL('./fixtures/disc/pattern.udf', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('./fixtures/disc/manifest.json', import.meta.url), 'utf8'));
const runtime = JSON.parse(await readFile(new URL('../packages/disc/runtime/build-manifest.json', import.meta.url), 'utf8'));
const wasm = await readFile(new URL('../packages/disc/runtime/ubve-disc.wasm', import.meta.url));

test('I10 pinned read-only WASM and shim hashes match; exports do not expose navigation or decryptors', async () => {
  for (const asset of runtime.assets) assert.equal(sha(await readFile(new URL(`../${asset.path}`, import.meta.url))), asset.sha256);
  assert.equal(sha(await readFile(new URL('../packages/disc/native/disc-bridge.c', import.meta.url))), runtime.shimSha256);
  const module = await WebAssembly.compile(wasm), imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
  assert.equal(imports.some(item => /dlopen|dlsym|jvm|aacs|bdplus|pthread/i.test(item.name)), false);
  assert.equal(exports.some(item => /bd_play|bd_menu|aacs|bdplus|jvm/i.test(item.name)), false);
  for (const name of ['ubve_udf_open', 'ubve_udf_list', 'ubve_udf_read', 'ubve_disc_titles', 'ubve_disc_close'])
    assert.ok(exports.some(item => item.name === name), `Missing ${name}`);
});

test('I10 actual libudfread WASM reads a UDF 2.60 file without whole-image extraction', async () => {
  const bytes = await readFile(fixture); assert.equal(sha(bytes), manifest.imageSha256);
  let largestRead = 0, calls = 0;
  const io = {
    blocks(lba, heap, ptr, count) { assert.ok(count > 0 && count <= 512); const start = lba * 2048, size = count * 2048; largestRead = Math.max(largestRead, size); calls++; if (start + size > bytes.length) return 0; heap.set(bytes.subarray(start, start + size), ptr); return count; },
    blockCount() { return bytes.length / 2048; },
    open() { throw Error('Unexpected folder callback'); }, close() {},
  };
  const m = await createDisc({ wasmBinary: wasm, ubveIO: io });
  assert.equal(m._ubve_udf_open(), 1);
  const path = manifest.file.path, p = m._malloc(m.lengthBytesUTF8(path) + 1);
  m.stringToUTF8(path, p, m.lengthBytesUTF8(path) + 1);
  const h = m._ubve_udf_file_open(p); assert.ok(h >= 0); assert.equal(m._ubve_udf_file_size(h), manifest.file.bytes);
  const target = m._malloc(1024 * 1024), hash = createHash('sha256');
  for (let at = 0; at < manifest.file.bytes; at += 1024 * 1024) {
    const n = Math.min(1024 * 1024, manifest.file.bytes - at);
    assert.equal(m._ubve_udf_read(h, at, target, n), n); hash.update(m.HEAPU8.subarray(target, target + n));
  }
  assert.equal(hash.digest('hex'), manifest.file.sha256);
  assert.equal(m._ubve_udf_read(h, 0, target, 1024 * 1024 + 1), -1);
  assert.equal(m._ubve_udf_read(h, 256, target, 16), 16);
  assert.deepEqual([...m.HEAPU8.subarray(target, target + 16)], [...Array(16).keys()]);
  m._ubve_udf_file_close(h); m._free(p); m._free(target);
  const root = m._malloc(1); m.HEAPU8[root] = 0;
  const directory = JSON.parse(m.UTF8ToString(m._ubve_udf_list(root)));
  assert.ok(directory.some(item => item.name === 'BDMV' && item.directory));
  m._free(root); m._ubve_disc_close(); m._ubve_disc_close();
  assert.ok(calls > 1 && largestRead <= 1024 * 1024);
});

test('I10 malformed UDF is rejected by the actual pinned parser', async () => {
  const m = await createDisc({ wasmBinary: wasm, ubveIO: { blockCount: () => 256, blocks(_lba, heap, ptr, count) { heap.fill(0, ptr, ptr + count * 2048); return count; } }, printErr: () => {} });
  assert.equal(m._ubve_udf_open(), 0); m._ubve_disc_close();
});

test('I10 folder path identity and protected source refusals', () => {
  const blob = new Blob(['abc']), folder = new DiscFolder([{ path: 'Disc/BDMV/STREAM/00001.m2ts', blob }]);
  assert.equal(folder.get('bdmv/stream/00001.M2TS'), blob);
  assert.deepEqual(folder.children('BDMV'), ['STREAM']);
  assert.throws(() => normalizeDiscPath('BDMV/../secret'));
  assert.throws(() => new DiscFolder([{ path: 'BDMV/a', blob }, { path: 'bdmv/A', blob }]), /Ambiguous/);
  assert.throws(() => new DiscFolder([{ path: 'AACS/Unit_Key_RO.inf', blob }]), /protected/);
});

test('I10 title trims preserve public 90kHz clocks and refuse angles/stills', () => {
  const clip = (id, start, begin, end) => ({ id, start90k: `${start}`, in90k: `${begin}`, out90k: `${end}`, stillMode: 0, video: [], audio: [], pgs: [] });
  const title = { index: 0, playlist: 1, duration90k: '270000', angles: 1, clips: [clip('00001', 0, 90000, 180000), clip('00002', 90000, 45000, 225000)], chapters: [{ start90k: '90000', duration90k: '180000', clip: 1 }] };
  validateLinearTitle(title);
  assert.equal(locateTitleTime(title, 89999n).mediaTime90k, 179999n);
  assert.equal(locateTitleTime(title, 90000n).mediaTime90k, 45000n);
  assert.throws(() => validateLinearTitle({ ...title, angles: 2 }), /single-angle/);
  assert.throws(() => validateLinearTitle({ ...title, clips: [{ ...title.clips[0], stillMode: 1 }] }), /Still/);
  assert.throws(() => locateTitleTime(title, 270000n), /outside/);
});

function protocolWorker({ hangRead = false, mutateIdentity = false } = {}) {
  return { onmessage: null, onerror: null, onmessageerror: null, terminated: false,
    terminate() { this.terminated = true; },
    postMessage(data) {
      if (data.type === 'read' && hangRead) return;
      const result = data.type === 'open' ? { udf: true } : data.type === 'stat' ? { size: 8 } : data.type === 'read' ? new Uint8Array(data.length) : { closed: true };
      queueMicrotask(() => this.onmessage?.({ data: { id: data.id, stamp: data.stamp, operationId: mutateIdentity && data.type === 'read' ? 'wrong' : data.operationId, result } }));
    },
  };
}
const context = (cancellation = new CancellationController().signal, timeout = 1000) => ({ stamp: { sessionId: 'test', generation: 2 }, operationId: crypto.randomUUID(), cancellation, deadlineMs: performance.now() + timeout });
test('I10 disc leases stay charged after owner close until their recipient releases them', async () => {
  const worker = protocolWorker(), session = await DiscSession.open([{ path: 'file', blob: new Blob(['12345678']) }], { udfOnly: true, workerFactory: () => worker });
  const source = await session.source('file'), read = await source.readExact(byteRange(0, 8), context());
  assert.equal(session.snapshot().ownedBytes, 8); await session.close(); assert.equal(worker.terminated, true);
  assert.equal(session.snapshot().ownedBytes, 8); read.bytes.release(); assert.equal(session.snapshot().ownedBytes, 0);
  await source.close(); await assert.rejects(source.readExact(byteRange(0, 1), context()), /closed/);
});
test('I10 timed-out synchronous owner is retired; no unbounded reservation survives', async () => {
  const worker = protocolWorker({ hangRead: true }), session = await DiscSession.open([{ path: 'file', blob: new Blob(['12345678']) }], { udfOnly: true, workerFactory: () => worker });
  const source = await session.source('file');
  await assert.rejects(source.readExact(byteRange(0, 8), context(undefined, 10)), /deadline/);
  assert.equal(worker.terminated, true); assert.equal(session.snapshot().ownedBytes, 0); assert.equal(session.snapshot().physicalMemoryReclamation, 'unobserved');
});
test('I10 response epoch mismatch retires worker before delivering bytes', async () => {
  const worker = protocolWorker({ mutateIdentity: true }), session = await DiscSession.open([{ path: 'file', blob: new Blob(['12345678']) }], { udfOnly: true, workerFactory: () => worker });
  const source = await session.source('file'); await assert.rejects(source.readExact(byteRange(0, 8), context()), /identity mismatch/);
  assert.equal(worker.terminated, true); assert.equal(session.snapshot().ownedBytes, 0);
});
