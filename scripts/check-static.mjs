import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDist = fileURLToPath(new URL('../apps/vue-player/dist/', import.meta.url));
const dist = path.resolve(process.argv[2] ?? defaultDist);
const inside = (relative) => {
  const resolved = path.resolve(dist, relative);
  assert.ok(resolved.startsWith(`${dist}${path.sep}`), `Path escapes static output: ${relative}`);
  return resolved;
};
const read = (relative) => readFile(inside(relative));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const rules = new Map();
for (const line of (await read('_headers')).toString().split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('#')) continue;
  if (line.startsWith('/')) {
    assert.ok(!rules.has(line), `Duplicate header rule ${line}`);
    rules.set(line, new Map());
    continue;
  }
  const match = /^\s+([^:]+):\s+(.+)$/.exec(line);
  assert.ok(match && rules.size, `Malformed header assignment ${line}`);
  const headers = [...rules.values()].at(-1);
  const key = match[1].toLowerCase();
  assert.ok(!headers.has(key), `Duplicate header ${key}`);
  headers.set(key, match[2]);
}
function headersAt(url) {
  const applied = new Map();
  for (const [rule, values] of rules) {
    if (!(rule.endsWith('*') ? url.startsWith(rule.slice(0, -1)) : url === rule)) continue;
    for (const [key, value] of values) {
      assert.ok(!applied.has(key), `Conflicting ${key} rules at ${url}`);
      applied.set(key, value);
    }
  }
  return applied;
}

for (const [url, entry, isolated] of [['/', 'index.html', false], ['/isolated/', 'isolated/index.html', true]]) {
  const html = (await read(entry)).toString();
  const script = /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[a-zA-Z0-9._-]+\.js)"/.exec(html);
  assert.ok(script && (await read(script[1].slice(1))).length > 0, `Missing hashed same-origin entry script for ${url}`);
  assert.ok(!html.includes('/src/main.ts'), `Unresolved application source at ${url}`);
  const headers = headersAt(url);
  assert.equal(headers.get('cross-origin-opener-policy'), isolated ? 'same-origin' : undefined, url);
  assert.equal(headers.get('cross-origin-embedder-policy'), isolated ? 'require-corp' : undefined, url);
  assert.equal(headers.get('cache-control'), 'no-cache', url);
  assert.ok(headers.get('content-security-policy')?.includes("object-src 'none'"), url);
  assert.match(headersAt(script[1]).get('cache-control') ?? '', /immutable/);
  assert.equal(headersAt(script[1]).get('cross-origin-embedder-policy'), 'require-corp', script[1]);
}
assert.match((await read('404.html')).toString(), /404|not found/i);
const support = JSON.parse((await read('support-status.json')).toString());
assert.ok(typeof support.releaseReady === 'boolean' && Array.isArray(support.qualifiedProfiles), 'Malformed published support status');
assert.ok(!support.releaseReady || support.qualifiedProfiles.length > 0, 'Release readiness cannot have an empty profile set');
const providerManifest = JSON.parse((await read('vendor/assets-manifest.json')).toString());
assert.ok(Array.isArray(providerManifest.files) && providerManifest.files.length > 0, 'Absent built provider assets');
for (const file of providerManifest.files) {
  const filename = `vendor/${file.path}`;
  const bytes = await read(filename);
  assert.equal(bytes.length, file.bytes, filename);
  assert.equal(hash(bytes), file.sha256, filename);
  assert.equal(headersAt(`/${filename}`).get('cache-control'), 'no-cache', filename);
  assert.equal(headersAt(`/${filename}`).get('cross-origin-embedder-policy'), 'require-corp', filename);
}
for (const forbidden of ['functions', '_worker.js', 'tests', 'test']) {
  await assert.rejects(stat(inside(forbidden)), { code: 'ENOENT' });
}
console.log(`Verified standard/isolated Pages documents, static routing and ${providerManifest.files.length} same-origin provider files. Exact playback qualified: ${support.releaseReady}.`);
