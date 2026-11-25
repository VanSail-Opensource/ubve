import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'apps/vue-player/public/vendor/notices');
const npm = [
  ['mediabunny', '1.66.4', ['LICENSE']],
  ['@mediabunny/truehd', '1.66.4', ['LICENSE', 'licenses/ffmpeg/LICENSE.md', 'licenses/ffmpeg/COPYING.LGPLv2.1']],
  ['@mediabunny/flac-encoder', '1.66.4', ['LICENSE', 'licenses/libflac/COPYING.Xiph']],
  ['@libmedia/avutil', '1.3.1', ['COPYING.LGPLv3']],
  ['@libmedia/cheap', '1.3.1', ['LICENSE']],
  ['@libmedia/common', '2.3.0', ['LICENSE']],
  ['jassub', '2.5.38', ['LICENSE']],
  ['imsc', '2.0.0', ['LICENSE']],
  ['tslib', '2.8.1', ['LICENSE.txt', 'CopyrightNotice.txt']],
  ['rvfc-polyfill', '1.0.8', ['LICENSE']],
  ...['@vue/shared', '@vue/runtime-core', '@vue/runtime-dom', '@vue/reactivity', 'vue'].map(name => [name, '3.5.46', ['LICENSE']]),
];
const notices = [], artifacts = [];
for (const [name, version, files] of npm) {
  const directory = path.join(root, 'node_modules', name);
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== name || metadata.version !== version) throw Error(`Notice inputs do not match ${name}@${version}`);
  const pkg = { name, version, installedLicenseDeclaration: metadata.license ?? null, files: [] };
  for (const file of files) {
    const data = await readFile(path.join(directory, file));
    const relative = `${name.replace(/^@/, '').replace('/', '-')}/${file}`;
    pkg.files.push({ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    artifacts.push([relative, data]);
  }
  notices.push(pkg);
}
for (const [name, version] of [['libbluray', '1.5.0'], ['libudfread', '1.2.0']]) {
  const data = await readFile(path.join(root, `third_party/disc/${name}-COPYING`));
  const relative = `${name}/COPYING`;
  notices.push({ name, version, files: [{ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }] });
  artifacts.push([relative, data]);
}
await rm(destination, { recursive: true, force: true });
for (const [relative, data] of artifacts) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
  schema: 'ubve-installed-notices-v1',
  scope: 'Exact notice files present in locked inputs. Does not verify complete corresponding source or authorize a release.',
  notices,
}, null, 2) + '\n');
console.log(`Staged and hashed ${artifacts.length} notice files from locked inputs.`);
