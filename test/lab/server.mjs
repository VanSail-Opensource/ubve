import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LabError, openLabState, label } from './state.mjs';

const adminCookie = '__Host-ubve-controller', runnerCookie = '__Host-ubve-runner';
const typeOf = name => ({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json',
  '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.mka': 'audio/x-matroska', '.weba': 'audio/webm',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.aac': 'audio/aac',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.aifc': 'audio/aiff', '.caf': 'audio/x-caf',
})[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
const shaFile = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const verifiedPath = async (root, name) => {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.includes('\\')) throw new Error('Invalid manifest path');
  const file = await realpath(path.resolve(root, name));
  if (!inside(root, file)) throw new Error('Manifest file escapes its configured root');
  return file;
};
const fileVersion = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');

export async function loadFixtures(manifestFile, mediaRoot) {
  const root = await realpath(mediaRoot);
  const { cases } = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (!Array.isArray(cases) || !cases.length || cases.length > 256) throw new Error('Fixture pack must contain 1–256 cases');
  const fixtures = new Map();
  for (const row of cases) {
    if (!/^[a-z0-9-]{1,80}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.sha256) || fixtures.has(row.id)) throw new Error('Invalid or duplicate fixture identity');
    const file = await verifiedPath(root, row.path), before = await stat(file, { bigint: true });
    const bytes = Number(before.size), version = fileVersion(before);
    if (!before.isFile() || bytes < 1 || !Number.isSafeInteger(bytes) || (row.bytes != null && row.bytes !== bytes) ||
        await shaFile(file) !== row.sha256 || fileVersion(await stat(file, { bigint: true })) !== version) throw new Error(`Fixture bytes do not match the lock: ${row.id}`);
    const expected = {};
    for (const key of ['videoFrames', 'pcmFrames', 'subtitleEvents', 'fonts']) {
      if (row.expected?.[key] !== undefined) {
        if (!Number.isSafeInteger(row.expected[key]) || row.expected[key] < 0) throw new Error(`Invalid expected ${key}: ${row.id}`);
        expected[key] = row.expected[key];
      }
    }
    const audioSampleRate = row.audioSampleRate ?? (row.reference?.kind === 'audio' ? row.reference.rate : null);
    if (audioSampleRate !== null && (!Number.isSafeInteger(audioSampleRate) || audioSampleRate < 8000 || audioSampleRate > 192000)) {
      throw new Error(`Invalid audio sample rate: ${row.id}`);
    }
    const discClip = row.discClip ?? null;
    if (discClip !== null && (!/\.(iso|udf)$/i.test(file) || ![discClip.title, discClip.clip].every(index => Number.isSafeInteger(index) && index >= 0 && index < 1024))) {
      throw new Error(`Invalid local disc clip selection: ${row.id}`);
    }
    fixtures.set(row.id, { file, version, public: { id: row.id, sha256: row.sha256, bytes, mime: typeOf(file),
      name: row.id + path.extname(file), quality: row.quality === 'performance' ? 'performance' : 'full', expected, audioSampleRate, discClip } });
  }
  return fixtures;
}

async function loadBuild(buildDir) {
  const root = await realpath(buildDir), lock = JSON.parse(await readFile(path.join(root, 'build-lock.json'), 'utf8'));
  if (lock.schema !== 'ubve-lab-build-v1' || !Array.isArray(lock.files) || !/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error('Invalid lab build lock');
  const buildId = createHash('sha256').update(JSON.stringify({ commit: lock.commit, dirty: lock.dirty, files: lock.files })).digest('hex');
  if (buildId !== lock.id) throw new Error('Lab build identity changed');
  const files = new Map();
  for (const row of lock.files) {
    const file = await verifiedPath(root, row.path), info = await stat(file, { bigint: true });
    if (files.has('/' + row.path) || !info.isFile() || Number(info.size) !== row.bytes || await shaFile(file) !== row.sha256) throw new Error(`Lab build asset changed: ${row.path}`);
    files.set('/' + row.path, { file, version: fileVersion(info), public: { sha256: row.sha256, bytes: row.bytes, mime: typeOf(file) } });
  }
  for (const required of ['/controller.html', '/runner.html', '/runner.js', '/controller.js']) if (!files.has(required)) throw new Error(`Build does not contain ${required}`);
  return { files, build: { id: lock.id, commit: lock.commit, dirty: lock.dirty === true, assetsSha256: lock.files.find(f => f.path === 'vendor/assets-manifest.json')?.sha256 ?? null } };
}

export function resolveRange(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  if (typeof value !== 'string' || value.length > 52) return null;
  const parts = /^bytes=([0-9]+)-([0-9]*)$/.exec(value);
  if (!parts) return null;
  const start = BigInt(parts[1]), end = parts[2] ? BigInt(parts[2]) : BigInt(size) - 1n;
  if (end < start || end >= BigInt(size)) return null;
  return { start: Number(start), end: Number(end), partial: true };
}

async function fileResponse(req, res, entry, allowRange) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new LabError(405, 'Unsupported method');
  const { bytes, sha256: sha, mime } = entry.public;
  const etag = `"${sha}"`;
  const fd = await open(entry.file, 'r').catch(() => { throw new LabError(412, 'Frozen asset is no longer available'); });
  try {
    if (fileVersion(await fd.stat({ bigint: true })) !== entry.version) throw new LabError(412, 'Frozen asset changed. Rebuild or restage the lab.');
    if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== etag) throw new LabError(412, 'Source revision changed');
    const range = resolveRange(allowRange ? req.headers.range : undefined, bytes);
    res.setHeader('ETag', etag);
    if (allowRange) res.setHeader('Accept-Ranges', 'bytes');
    if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${bytes}` }).end(); return; }
    const { start, end, partial } = range;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', end - start + 1);
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes}`);
    res.writeHead(partial ? 206 : 200);
    if (req.method === 'HEAD') res.end();
    else await pipeline(fd.createReadStream({ start, end, autoClose: false }), res);
  } finally { await fd.close().catch(() => undefined); }
}

const headers = (res, isolated, worker) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; media-src 'self' blob:; connect-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  if (isolated) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isolated || worker) res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
};
const json = (res, status, payload) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(payload));
const cookie = (req, key) => req.headers.cookie?.split(/;\s*/).find(part => part.startsWith(key + '='))?.slice(key.length + 1);
const setCookie = (res, key, value) => res.setHeader('Set-Cookie', `${key}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/`);
async function readJson(req, origin) {
  if (req.headers.origin !== origin) throw new LabError(403, 'Wrong request origin');
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new LabError(415, 'Use JSON');
  if (Number(req.headers['content-length']) > 256 * 1024) throw new LabError(413, 'Receipt is too large');
  const pieces = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new LabError(413, 'Receipt is too large');
    pieces.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(pieces, size).toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* use the same structured failure for bad JSON */ }
  throw new LabError(400, 'Expected a JSON object');
}

const uuid = '([0-9a-f-]{36})';
const runPattern = new RegExp(`^/api/v1/runs/${uuid}$`);
const cancelPattern = new RegExp(`^/api/v1/runs/${uuid}/cancel$`);
const eventPattern = new RegExp(`^/api/v1/runs/${uuid}/events$`);
function lanAddress(value) {
  if (!isIPv4(value)) throw new Error('Use a LAN IPv4 address');
  const [a, b] = value.split('.').map(Number);
  if (value !== '127.0.0.1' && a !== 10 && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)) throw new Error('The runner must bind to loopback or a private IPv4 address');
  if (!Object.values(networkInterfaces()).flat().some(x => x?.address === value)) throw new Error('The runner address is not assigned to this machine');
  return value;
}

export async function startLab({ runnerHost = '127.0.0.1', runnerPort = 4174, controllerPort = 4175, tls, buildDir, mediaRoot, manifestFile, evidence, now }) {
  runnerHost = lanAddress(runnerHost);
  const [{ build, files }, fixtures] = await Promise.all([loadBuild(buildDir), loadFixtures(manifestFile, mediaRoot)]);
  const sampleRates = [...new Set([...fixtures.values()].flatMap(({ public: fixture }) => fixture.audioSampleRate !== null ?
    [fixture.audioSampleRate] : fixture.expected.pcmFrames > 0 ? [48000, 44100] : []))].sort((a, b) => a - b);
  if (sampleRates.length > 4) throw new Error('Split the fixture pack into labs with at most four exact audio rates each');
  const state = await openLabState({ evidence, build, fixtures, now });
  const listen = (host, port, role) => new Promise((resolve, reject) => {
    const server = createServer({ ...tls, minVersion: 'TLSv1.2', requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
      const origin = `https://${host}:${server.address().port}`;
      const run = async () => {
        if (req.headers.host !== new URL(origin).host || !req.url?.startsWith('/') || req.url.startsWith('//')) throw new LabError(400, 'Invalid request host');
        const pathname = new URL(req.url, origin).pathname;
        headers(res, role === 'runner' && pathname === '/isolated/', pathname.startsWith('/vendor/'));
        const post = req.method === 'POST', get = req.method === 'GET';
        if (role === 'controller') {
          if (post && pathname === '/api/v1/admin') {
            const body = await readJson(req, origin); setCookie(res, adminCookie, state.beginAdmin(body.code)); return json(res, 200, { ok: true });
          }
          if (pathname.startsWith('/api/')) {
            if (!state.authorizeAdmin(cookie(req, adminCookie))) throw new LabError(401, 'Open the authenticated controller link printed by the master');
            if (get && pathname === '/api/v1/dashboard') return json(res, 200, { ...await state.dashboard(), runnerOrigin });
            if (post && pathname === '/api/v1/pairs') { await readJson(req, origin); return json(res, 201, { code: await state.issuePair(), runnerOrigin }); }
            if (post && pathname === '/api/v1/runs') return json(res, 201, await state.queue(await readJson(req, origin)));
            const detail = runPattern.exec(pathname), cancel = cancelPattern.exec(pathname);
            if (get && detail) return json(res, 200, state.detail(detail[1]));
            if (post && cancel) { await readJson(req, origin); return json(res, 200, await state.cancel(cancel[1])); }
          } else {
            const asset = files.get(pathname === '/' ? '/controller.html' : pathname);
            if (asset && ['/', '/controller.html', '/controller.js', '/lab.css'].includes(pathname)) return fileResponse(req, res, asset, false);
          }
        } else {
          const key = cookie(req, runnerCookie);
          if (get && pathname === '/api/v1/runner-config') return json(res, 200, { build: build.id, sampleRates });
          if (post && pathname === '/api/v1/pair') {
            const joined = await state.pair(await readJson(req, origin));
            setCookie(res, runnerCookie, joined.key); return json(res, 201, { id: joined.id });
          }
          if (post && pathname === '/api/v1/poll') return json(res, 200, await state.poll(key, await readJson(req, origin)));
          const event = eventPattern.exec(pathname);
          if (post && event) return json(res, 200, await state.event(key, event[1], await readJson(req, origin)));
          const media = /^\/fixtures\/([a-z0-9-]+)$/.exec(pathname);
          if (media) {
            const entry = fixtures.get(media[1]);
            if (!entry || !state.availableFixture(key, media[1])) throw new LabError(404, 'Fixture is not assigned to this runner');
            return fileResponse(req, res, entry, true);
          }
          const asset = files.get(['/', '/isolated/'].includes(pathname) ? '/runner.html' : pathname);
          if (asset && (/^\/(runner\.(html|js)|lab\.css)?$/.test(pathname) || pathname === '/isolated/' || pathname.startsWith('/vendor/'))) return fileResponse(req, res, asset, false);
        }
        throw new LabError(404, 'No such lab route');
      };
      void run().catch(error => {
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        json(res, error instanceof LabError ? error.status : 500, { error: error instanceof LabError ? error.message : 'Lab request failed' });
        if (!(error instanceof LabError)) console.error(error.message);
      });
    });
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => { server.removeListener('error', reject); resolve(server); });
  });
  let runnerOrigin;
  const runner = await listen(runnerHost, runnerPort, 'runner');
  runnerOrigin = `https://${runnerHost}:${runner.address().port}`;
  let controller;
  try { controller = await listen('127.0.0.1', controllerPort, 'controller'); }
  catch (error) { runner.close(); throw error; }
  let tickPending = false;
  const tick = setInterval(() => {
    if (tickPending) return;
    tickPending = true;
    void state.tick().catch(error => console.error(error.message)).finally(() => { tickPending = false; });
  }, 1000);
  tick.unref();
  return { runnerOrigin, controllerOrigin: `https://127.0.0.1:${controller.address().port}`, adminCode: state.adminCode,
    close: async () => {
      clearInterval(tick);
      await Promise.all([controller, runner].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: options } = parseArgs({ options: {
    'lan-ip': { type: 'string', default: '127.0.0.1' }, cert: { type: 'string' }, key: { type: 'string' },
    build: { type: 'string', default: '.local/device-lab-build' }, manifest: { type: 'string', default: 'test/lab/fixtures.json' },
    'media-root': { type: 'string', default: '.' }, evidence: { type: 'string', default: '.local/device-lab' },
    'runner-port': { type: 'string', default: '4174' }, 'controller-port': { type: 'string', default: '4175' },
  } });
  if (!label(options.cert, 1024) || !label(options.key, 1024)) throw new Error('Supply --cert and --key for the LAN certificate');
  const lab = await startLab({ runnerHost: options['lan-ip'], runnerPort: Number(options['runner-port']),
    controllerPort: Number(options['controller-port']), tls: { cert: await readFile(options.cert), key: await readFile(options.key) },
    buildDir: options.build, mediaRoot: options['media-root'], manifestFile: options.manifest, evidence: options.evidence });
  console.log(`Controller ${lab.controllerOrigin}/#admin=${lab.adminCode}\nDevice runner ${lab.runnerOrigin}/isolated/\nUse the controller to generate one-use pairing links.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void lab.close(); });
}
