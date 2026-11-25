import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

// Static inventory only. The JavaScript AST is inspected without evaluating any
// packaged program. A byte-identical notice is evidence of its presence, not a
// determination that a distributor has met every condition of its license.
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.resolve(root, process.argv[2] ?? 'apps/vue-player/dist');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const installed = name => path.join(root, 'node_modules', name);
const npmName = file => file.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/)?.[1] ?? null;
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const noticeName = name => /^(?:licen[cs]e|copying|notice|copyrightnotice)(?:[.-]|$)/i.test(name);
const lock = await readJSON(path.join(root, 'package-lock.json'));

async function files(directory, prefix = '') {
  const output = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + item.name;
    if (item.isDirectory()) output.push(...await files(path.join(directory, item.name), relative + '/'));
    else if (item.isFile()) output.push(relative);
  }
  return output;
}

if (!(await stat(path.join(dist, 'index.html'))).isFile()) throw new Error('Build the application before auditing the static artifact');
const emitted = new Map();
for (const file of await files(dist)) {
  const bytes = await readFile(path.join(dist, file));
  const hash = digest(bytes);
  (emitted.get(hash) ?? (emitted.set(hash, []), emitted.get(hash))).push(file);
}
const emittedFiles = [...emitted.values()].flat().sort();

const sourceMaps = [];
for (const relative of emittedFiles.filter(file => file.startsWith('assets/') && file.endsWith('.js.map'))) {
  const map = await readJSON(path.join(dist, relative));
  const packages = [...new Set(map.sources.map(npmName).filter(Boolean))].sort();
  sourceMaps.push({ map: relative, packages });
}
if (!sourceMaps.length) throw new Error('No emitted JS maps available to establish bundle dependency inventory');

const dav1d = await build({ absWorkingDir: root,
  entryPoints: ['packages/wasm-adapters/workers/dav1d.worker.mjs'], outfile: 'dav1d.worker.js', write: false, metafile: true,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['browser'], legalComments: 'eof', minify: true });
const dav1dInputs = [...new Set(Object.values(dav1d.metafile.outputs).flatMap(output => Object.entries(output.inputs)
  .filter(([, item]) => item.bytesInOutput > 0).map(([file]) => npmName(file)).filter(Boolean)))].sort();
const dav1dDerivedHash = digest(dav1d.outputFiles[0].contents);
const dav1dMatches = emitted.get(dav1dDerivedHash) ?? [];

async function findNotice(base, file) {
  const hash = digest(await readFile(path.join(base, file)));
  return { file, sha256: hash, separateCopiesInDistribution: emitted.get(hash) ?? [] };
}
const namedPackages = new Set([...sourceMaps.flatMap(map => map.packages), ...dav1dInputs, '@mediabunny/truehd', '@mediabunny/flac-encoder']);
const packages = [];
for (const name of [...namedPackages].sort()) {
  const base = installed(name), manifest = await readJSON(path.join(base, 'package.json'));
  const pinned = lock.packages[`node_modules/${name}`];
  if (!pinned || pinned.version !== manifest.version || pinned.license !== manifest.license) throw new Error(`Installed manifest differs from lockfile for ${name}`);
  const notices = (await readdir(base, { withFileTypes: true })).filter(item => item.isFile() && noticeName(item.name)).map(item => item.name).sort();
  if (name === '@mediabunny/truehd') notices.push('licenses/ffmpeg/COPYING.LGPLv2.1', 'licenses/ffmpeg/LICENSE.md');
  if (name === '@mediabunny/flac-encoder') notices.push('licenses/libflac/COPYING.Xiph');
  packages.push({ name, version: manifest.version, packageDeclaredLicense: manifest.license, npmIntegrity: pinned.integrity ?? null,
    repo: manifest.repository ?? null, exactPackageNotices: await Promise.all(notices.map(file => findNotice(base, file))) });
}

function readEmbeddedWasm(source, name) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`Could not parse packaged worker ${name}`);
  const candidates = [];
  function walk(node) {
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && node.text.startsWith('\0asm')) {
      const bytes = Buffer.alloc(node.text.length);
      for (let i = 0; i < bytes.length; i++) {
        const code = node.text.charCodeAt(i);
        bytes[i] = (~code >> 8) & code; // provider's installed Emscripten string-decoding expression
      }
      if (WebAssembly.validate(bytes)) candidates.push(bytes);
    }
    node.forEachChild(walk);
  }
  walk(ast);
  if (candidates.length !== 1) throw new Error(`Expected one inert embedded WASM payload in ${name}`);
  return candidates[0];
}
const embeddedCodecs = [];
for (const [name, distFile, packageFile] of [
  ['@mediabunny/truehd', 'vendor/truehd.worker.js', 'dist/bundles/mediabunny-truehd.worker.js'],
  ['@mediabunny/flac-encoder', 'vendor/flac.worker.js', 'dist/bundles/mediabunny-flac-encoder.worker.js'],
]) {
  const emittedWorker = await readFile(path.join(dist, distFile));
  const sha256 = digest(emittedWorker), installedSha = digest(await readFile(path.join(installed(name), packageFile)));
  const payload = readEmbeddedWasm(emittedWorker.toString('utf8'), distFile), wasmSha256 = digest(payload);
  const readme = await readFile(path.join(installed(name), 'README.md'), 'utf8');
  const providerDeclaredWasmSha256 = readme.match(/SHA-256 of the WASM binary inlined[^\n]*: `([0-9a-f]{64})`/)?.[1] ?? null;
  embeddedCodecs.push({ name, distFile, packageFile, sha256, matchesInstalledWorker: sha256 === installedSha,
    embeddedWasmBytes: payload.length, wasmSha256, providerDeclaredWasmSha256, matchesProviderWasmPin: wasmSha256 === providerDeclaredWasmSha256 });
}

const discManifest = await readJSON(path.join(root, 'third_party/disc/manifest.json'));
const disc = [];
for (const name of ['libudfread', 'libbluray']) {
  const pin = discManifest[name], filename = `${name}-${pin.version}.tar.xz`;
  const bytes = await readFile(path.join(root, 'third_party/disc', filename));
  const algorithm = pin.sha512 ? 'sha512' : 'sha256';
  disc.push({ name, version: pin.version, filename, archivePinMatches: createHash(algorithm).update(bytes).digest('hex') === pin[algorithm],
    separateSourceArchiveCopiesInDistribution: emitted.get(digest(bytes)) ?? [], notice: await findNotice(path.join(root, 'third_party/disc'), `${name}-COPYING`) });
}

const emittedJassub = emittedFiles.filter(file => file.startsWith('vendor/jassub/') || /^assets\/(?:jassub-worker-|worker-|default-)/.test(file));
const aliases = [...emitted.values()].filter(names => names.some(name => name.startsWith('vendor/jassub/')) && names.some(name => name.startsWith('assets/')));
const av1Wasm = await readFile(path.join(dist, 'vendor/av1/av1-atomic.wasm'));
const appLicenses = (await readdir(root, { withFileTypes: true })).filter(item => item.isFile() && noticeName(item.name)).map(item => item.name).sort();
console.log(JSON.stringify({ schema: 'ubve-static-distribution-inventory-v1', scope: 'exact installed npm and static build inspection; not legal or published-source verification',
  staticFileCount: emittedFiles.length, applicationTopLevelNoticeFiles: appLicenses, sourceMaps, packages, embeddedCodecs, disc,
  dav1d: { derivedWorkerHash: dav1dDerivedHash, derivedWorkerMatches: dav1dMatches, derivedWorkerPackages: dav1dInputs,
    atomicWasmSha256: digest(av1Wasm), embeddedVersionLiteralOffset: av1Wasm.indexOf('1.4.1-63-g37155c11') },
  jassub: { files: emittedJassub, byteIdenticalVendorAndViteCopies: aliases },
}, null, 2));
