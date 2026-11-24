import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(root, process.argv[2] ?? 'apps/vue-player/public/vendor');
const jassubRoot = path.join(root, 'node_modules/jassub');
const packageJson = JSON.parse(await readFile(path.join(jassubRoot, 'package.json'), 'utf8'));
if (packageJson.version !== '2.5.38') throw new Error('Presentation assets require jassub 2.5.38');
const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(path.join(destination, 'ubve'), { recursive: true });
await mkdir(path.join(destination, 'jassub'), { recursive: true });
await build({ entryPoints: [path.join(root, 'packages/presentation/worklet/pcm-processor.ts')],
  outfile: path.join(destination, 'ubve/pcm-worklet.js'), bundle: true, format: 'esm', target: 'es2023', sourcemap: false });

const expectedThreadSource = 'export const THREAD_COUNT = self.crossOriginIsolated ? Math.min(Math.max(1, navigator.hardwareConcurrency - 2), 8) : 1;';
const utilFile = path.join(jassubRoot, 'dist/worker/util.js');
const upstreamUtil = await readFile(utilFile, 'utf8');
if (upstreamUtil.split(expectedThreadSource).length !== 2) throw new Error('Upstream JASSUB thread-selection source changed; review the patch');
await build({ entryPoints: [path.join(jassubRoot, 'dist/worker/worker.js')],
  outfile: path.join(destination, 'jassub/worker.js'), bundle: true, format: 'esm', target: 'es2023',
  plugins: [{ name: 'ubve-subtitle-worker-budget', setup(context) {
    context.onLoad({ filter: /[\\/]jassub[\\/]dist[\\/]worker[\\/]util\.js$/ }, () => ({
      contents: upstreamUtil.replace(expectedThreadSource, 'export const THREAD_COUNT = 1; // UBVE measured one-thread candidate; zero pthread pool.'),
      loader: 'js', resolveDir: path.dirname(utilFile),
    }));
  } }],
});
const wasmSource = path.join(jassubRoot, 'dist/wasm');
for (const name of await readdir(wasmSource)) {
  if (name.endsWith('.wasm') || name.endsWith('.js')) await cp(path.join(wasmSource, name), path.join(destination, 'jassub', name));
}
await cp(path.join(jassubRoot, 'dist/default.woff2'), path.join(destination, 'jassub/default.woff2'));
await cp(path.join(jassubRoot, 'LICENSE'), path.join(destination, 'jassub/LICENSE'));
await cp(path.join(root, 'node_modules/imsc/LICENSE'), path.join(destination, 'jassub/IMSC-LICENSE'));
const assets = [];
for (const directory of ['ubve', 'jassub']) {
  for (const name of (await readdir(path.join(destination, directory))).sort()) {
    if (name === 'manifest.json') continue;
    const bytes = await readFile(path.join(destination, directory, name));
    assets.push({ path: `${directory}/${name}`, bytes: bytes.length, sha256: hash(bytes) });
  }
}
const manifest = {
  schema: 'ubve-presentation-assets-v1', jassub: '2.5.38', imsc: '2.0.0',
  patch: { description: 'Pin the public JASSUB worker thread count to 1, creating no pthread children.',
    upstreamUtilSha256: hash(upstreamUtil), replacement: 'THREAD_COUNT = 1', wasmChanged: false },
  threadBudget: { hostWorkers: 1, pthreadChildren: 0 },
  physicalOutputQualification: 'DEFERRED_NOT_QUALIFIED', assets,
};
await writeFile(path.join(destination, 'presentation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${assets.length} self-hosted presentation assets with hashes.`);
