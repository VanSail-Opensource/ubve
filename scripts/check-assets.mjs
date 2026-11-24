import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.cwd(), vendor = path.join(root, 'apps/vue-player/public/vendor');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = async name => JSON.parse(await readFile(path.join(vendor, name), 'utf8'));
const codecs = await manifest('codecs-manifest.json'), presentation = await manifest('presentation-manifest.json'), disc = await manifest('disc/build-manifest.json');
const declared = [
  ...codecs.files.map(asset => ({ path: asset.file, bytes: asset.bytes, sha256: asset.sha256 })),
  ...presentation.assets,
  ...disc.assets.map(asset => ({ ...asset, path: `disc/${path.basename(asset.path)}` })),
];
for (const entry of declared) {
  const resolved = path.resolve(vendor, entry.path);
  if (!resolved.startsWith(vendor + path.sep)) throw Error('Asset manifest escaped vendor root');
  const bytes = await readFile(resolved);
  if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw Error(`Asset hash mismatch: ${entry.path}`);
}
const files = [];
async function walk(directory, prefix = '') {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name = prefix + item.name;
    if (item.isDirectory()) await walk(path.join(directory, item.name), name + '/');
    else if (name !== 'assets-manifest.json') { const bytes = await readFile(path.join(directory, item.name)); files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) }); }
  }
}
await walk(vendor);
const report = { schema: 'ubve-built-assets-v1', integrity: 'VERIFIED_BUILD_ASSETS', qualification: 'NOT_QUALIFIED', files };
await writeFile(path.join(vendor, 'assets-manifest.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(root, 'evidence/assets-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Verified ${declared.length} provider assets; recorded ${files.length} self-hosted files.`);
