import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'apps/vue-player/public/vendor');
await mkdir(path.join(output, 'av1'), { recursive: true });
await mkdir(path.join(output, 'portable'), { recursive: true });
const sourceWasm = path.join(root, 'packages/wasm-adapters/assets/av1-atomic.wasm');
const wasm = await readFile(sourceWasm);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (wasm.length !== 844881 || hash(wasm) !== '9a3048be7f159a6e8976349045a296c7c14a5a3d91f4e2cf52e42c2214025a63') throw Error('Pinned AV1 atomic module failed integrity validation');
await build({ absWorkingDir: root, entryPoints: ['packages/wasm-adapters/workers/dav1d.worker.mjs'], outfile: path.join(output, 'av1/dav1d.worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['browser'], legalComments: 'eof', minify: true });
const assets = [
  ['packages/wasm-adapters/assets/av1-atomic.wasm', 'av1/av1-atomic.wasm'],
  ['node_modules/@libmedia/cheap/dist/esm/webassembly/WebAssemblyRunnerWorker.js', 'av1/WebAssemblyRunnerWorker.js'],
  ['node_modules/@mediabunny/truehd/dist/bundles/mediabunny-truehd.worker.js', 'truehd.worker.js'],
  ['node_modules/@mediabunny/flac-encoder/dist/bundles/mediabunny-flac-encoder.worker.js', 'flac.worker.js'],
];
const portableRoot = 'packages/wasm-adapters/runtime';
const portable = JSON.parse(await readFile(path.join(root, portableRoot, 'build-manifest.json'), 'utf8'));
if (portable.abi !== 'ubve-software-decode-v1' || portable.ffmpeg.version !== '9.0.2' || portable.emscripten.version !== '6.0.0') throw Error('Unexpected portable codec ABI or provider');
for (const [name, digest] of Object.entries(portable.inputs)) {
  if (!['scripts/build-software-codecs.sh', 'packages/wasm-adapters/native/decode.c'].includes(name) ||
      hash(await readFile(path.join(root, name))) !== digest) throw Error(`Portable codec recipe changed without rebuilt assets: ${name}`);
}
const portablePins = {};
for (const name of ['video.mjs', 'video.wasm', 'audio.mjs', 'audio.wasm', 'FFmpeg-COPYING.LGPLv2.1', 'libaom-LICENSE', 'libaom-PATENTS']) {
  const file = portable.files.find(asset => asset.file === name);
  const bytes = await readFile(path.join(root, portableRoot, name));
  if (!file || file.bytes !== bytes.length || file.sha256 !== hash(bytes)) throw Error(`Portable codec asset changed: ${name}`);
  if (name.endsWith('.wasm')) portablePins[name.split('.')[0]] = { bytes: file.bytes, sha256: file.sha256 };
  assets.push([`${portableRoot}/${name}`, `portable/${name}`]);
}
assets.push([`${portableRoot}/build-manifest.json`, 'portable/build-manifest.json']);
await build({ absWorkingDir: root, entryPoints: ['packages/wasm-adapters/workers/portable.worker.ts'],
  outfile: path.join(output, 'portable/portable.worker.js'), bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', minify: true, define: { UBVE_PORTABLE_PINS: JSON.stringify(portablePins) } });
for (const [source, destination] of assets) await copyFile(path.join(root, source), path.join(output, destination));
const files = [];
for (const name of ['av1/dav1d.worker.js', 'portable/portable.worker.js', ...assets.map(x => x[1])]) { const bytes = await readFile(path.join(output, name)); files.push({ file: name, bytes: bytes.length, sha256: hash(bytes) }); }
await writeFile(path.join(output, 'codecs-manifest.json'), JSON.stringify({ schema: 1, versions: { libmedia: '1.3.1', common: '2.3.0', truehd: '1.66.4', flac: '1.66.4', ffmpeg: '9.0.2', libaom: 'b141d9c4' }, candidate: 'dav1d-atomic-single-thread-and-portable', blocked: ['dav1d-simd-default-4-threads', 'dav1d-atomic-4-thread-not-default'], files }, null, 2) + '\n');
console.log(`Built ${files.length} self-hosted codec assets; verified atomic module SHA-256.`);
