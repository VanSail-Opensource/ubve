import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'packages/disc/runtime/build-manifest.json'), 'utf8'));
const target = path.join(root, 'apps/vue-player/public/vendor/disc'); await mkdir(target, { recursive: true });
for (const asset of manifest.assets) {
  const source = path.join(root, asset.path), bytes = await readFile(source);
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw Error(`Disc asset integrity failed: ${asset.path}`);
  await copyFile(source, path.join(target, path.basename(source)));
}
await copyFile(path.join(root, 'packages/disc/worker/disc-worker.mjs'), path.join(target, 'disc-worker.mjs'));
await copyFile(path.join(root, 'packages/disc/runtime/build-manifest.json'), path.join(target, 'build-manifest.json'));
console.log('Prepared pinned read-only disc worker assets (UNQUALIFIED).');
