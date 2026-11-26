import { build as bundle } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd(), target = path.resolve(process.env.UBVE_LAB_BUILD_DIR ?? '.local/device-lab-build');
await mkdir(target, { recursive: true });
await bundle({ absWorkingDir: root, entryPoints: ['test/lab/controller.ts', 'test/lab/runner.ts'],
  outdir: target, bundle: true, format: 'esm', target: 'es2022', minify: true, platform: 'browser', legalComments: 'eof' });
for (const file of ['runner.html', 'controller.html', 'lab.css']) await cp(path.join(root, 'test/lab', file), path.join(target, file));
await cp(path.join(root, 'apps/vue-player/public/vendor'), path.join(target, 'vendor'), { recursive: true });

const sha = data => createHash('sha256').update(data).digest('hex'), files = [];
async function walk(directory, prefix = '') {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && item.name === 'build-lock.json') continue;
    const relative = prefix + item.name;
    if (item.isDirectory()) await walk(path.join(directory, item.name), relative + '/');
    else if (item.isFile()) {
      const bytes = await readFile(path.join(directory, item.name));
      files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
    } else throw new Error('Lab build must use only ordinary local files');
  }
}
await walk(target);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: root }).trim();
const identity = { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '', files };
const id = sha(JSON.stringify(identity));
await writeFile(path.join(target, 'build-lock.json'), JSON.stringify({ schema: 'ubve-lab-build-v1', id, ...identity }, null, 2) + '\n');
console.log(`Built lab ${id.slice(0, 12)} with ${files.length} verified inputs at ${target}`);
