import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRange, startLab } from './lab/server.mjs';
import { LEASE_MS, openLabState } from './lab/state.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const mounted = async t => {
  const parent = path.resolve(tmpdir()), directory = await mkdtemp(path.join(parent, 'ubve-lab-test-'));
  assert.equal(path.dirname(path.resolve(directory)), parent);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test('lab byte ranges preserve offsets above 4 GiB and reject invalid extents', () => {
  const start = 2 ** 32 + 11;
  assert.deepEqual(resolveRange(`bytes=${start}-${start + 7}`, start + 10),
    { start, end: start + 7, partial: true });
  assert.deepEqual(resolveRange('bytes=4-', 6), { start: 4, end: 5, partial: true });
  assert.equal(resolveRange('bytes=9007199254740994-', start + 10), null);
  assert.equal(resolveRange('bytes=2-3,8-10', 32), null);
  assert.equal(resolveRange('bytes=2-6', 6), null);
});

test('paired state enforces exclusive timing, tab leases, immutable terminals and restart recovery', async t => {
  let now = 10_000;
  const evidence = await mounted(t), build = { id: 'build' };
  const fixture = { id: 'clip', bytes: 1, sha256: 'hash' };
  const config = { evidence, build, now: () => now, fixtures: new Map([['clip', { public: fixture }]]) };
  const s = await openLabState(config);
  const code = await s.issuePair();
  const a = await s.pair({ code, name: 'A', platform: 'A OS' });
  await assert.rejects(s.pair({ code, name: 'A', platform: 'A OS' }), { status: 401 });
  const b = await s.pair({ code: await s.issuePair(), name: 'B', platform: 'B OS' });
  const poll = (d, tab = d.id) => s.poll(d.key, { tab, ready: true });
  const queue = (d, scenario) => s.queue({ deviceId: d.id, fixtureId: 'clip', transport: 'range', av1: 'portable', foldDown: false, scenario });
  const send = (d, j, event) => s.event(d.key, j.id, { tab: d.id, build: 'build', ...event });
  const attempt = await queue(a, 'timing');
  const normal = await queue(b, 'lifecycle');
  assert.equal((await poll(b)).job, null);
  assert.equal((await poll(a)).job.id, attempt.id);
  await assert.rejects(poll(a, 'a-second-tab'), { status: 409 });
  assert.equal((await poll(b)).job, null);
  await send(a, attempt, { status: 'phase', phase: 'running' });
  await assert.rejects(send(a, attempt, { status: 'result', outcome: 'passed', result: { fixtureSha256: fixture.sha256 } }), { status: 400 });
  await s.cancel(attempt.id);
  assert.equal((await poll(a)).job.state, 'cancelling');
  assert.deepEqual(await send(a, attempt, { status: 'result', outcome: 'cancelled', result: { fixtureSha256: fixture.sha256, cleanup: true } }), {
    terminal: true, state: 'cancelled',
  });
  assert.equal((await poll(b)).job.id, normal.id);
  now += LEASE_MS;
  await s.tick();
  assert.equal(s.detail(normal.id).state, 'disconnected');
  assert.equal((await send(b, normal, { status: 'result', outcome: 'passed' })).state, 'disconnected');
  const acrossRestart = await queue(a, 'lifecycle');
  await poll(a);
  const recovered = await openLabState(config);
  assert.equal(recovered.detail(acrossRestart.id).state, 'interrupted');
  assert.equal(recovered.detail(attempt.id).result.cleanup, true);
});

test('real HTTPS lab keeps control loopback-only and serves exact authenticated fixture ranges', async t => {
  const directory = await mounted(t), build = path.join(directory, 'build');
  const openssl = process.env.UBVE_OPENSSL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem');
  const create = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=UBVE TLS test', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' });
  if (create.error?.code === 'ENOENT') return t.skip('OpenSSL is unavailable. Set UBVE_OPENSSL to run the real TLS lane.');
  assert.equal(create.status, 0, create.stderr);
  const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
  await mkdir(build);
  const files = [];
  for (const file of ['controller.html', 'runner.html', 'runner.js', 'controller.js']) {
    await writeFile(path.join(build, file), file);
    files.push({ path: file, bytes: file.length, sha256: digest(file) });
  }
  const identity = { commit: 'a'.repeat(40), dirty: false, files };
  await writeFile(path.join(build, 'build-lock.json'), JSON.stringify({ schema: 'ubve-lab-build-v1', ...identity, id: digest(JSON.stringify(identity)) }));
  const media = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), hash = digest(media), fixture = path.join(directory, 'clip.mkv');
  const manifestFile = path.join(directory, 'fixtures.json');
  await writeFile(fixture, media);
  await writeFile(manifestFile, JSON.stringify({ cases: [{ id: 'test-case', path: 'clip.mkv', sha256: hash, bytes: 26, audioSampleRate: 48000 }] }));
  const lab = await startLab({ tls, buildDir: build, mediaRoot: directory, manifestFile, evidence: path.join(directory, 'evidence'),
    runnerPort: 0, controllerPort: 0 });
  t.after(() => lab.close());
  const fetch = (origin, pathname, { body, headers = {}, method } = {}) => new Promise((resolve, reject) => {
    const encoded = body && JSON.stringify(body), req = request(new URL(pathname, origin), {
      method: method ?? (body ? 'POST' : 'GET'), ca: tls.cert, timeout: 3000,
      headers: { ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), Origin: origin } : {}), ...headers },
    }, res => {
      const items = [];
      res.on('data', b => items.push(b));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, data: Buffer.concat(items) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('HTTPS test timeout')));
    req.end(encoded);
  });
  const { runnerOrigin: worker, controllerOrigin: master } = lab;
  const admin = await fetch(master, '/api/v1/admin', { body: { code: lab.adminCode } });
  assert.equal(admin.code, 200);
  const adminHeaders = { Cookie: admin.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await fetch(worker, '/api/v1/dashboard', { headers: adminHeaders })).code, 404);
  assert.equal((await fetch(master, '/api/v1/pairs', { body: {}, headers: { ...adminHeaders, Origin: worker } })).code, 403);
  const invitation = await fetch(master, '/api/v1/pairs', { body: {}, headers: adminHeaders });
  const joined = await fetch(worker, '/api/v1/pair', { body: { code: JSON.parse(invitation.data).code, name: 'Test device', platform: 'HTTPS test' } });
  assert.equal(joined.code, 201);
  const deviceHeaders = { Cookie: joined.headers['set-cookie'][0].split(';')[0] };
  const tab = 'tab-test';
  const asset = await fetch(worker, '/isolated/');
  assert.equal(asset.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(asset.headers['cross-origin-embedder-policy'], 'require-corp');
  const config = await fetch(worker, '/api/v1/runner-config');
  assert.deepEqual(JSON.parse(config.data), { build: digest(JSON.stringify(identity)), sampleRates: [48000] });
  assert.equal((await fetch(worker, '/fixtures/test-case', { headers: deviceHeaders })).code, 404);
  const queued = await fetch(master, '/api/v1/runs', { headers: adminHeaders, body: { deviceId: JSON.parse(joined.data).id, fixtureId: 'test-case',
    scenario: 'lifecycle', av1: 'portable', foldDown: false, transport: 'range' } });
  assert.equal(queued.code, 201);
  const job = JSON.parse((await fetch(worker, '/api/v1/poll', { headers: deviceHeaders, body: { ready: true, tab } })).data).job;
  const range = await fetch(worker, '/fixtures/test-case', { headers: { ...deviceHeaders, Range: 'bytes=10-14', 'If-Match': `"${hash}"` } });
  assert.equal(range.code, 206);
  assert.equal(range.headers['content-range'], 'bytes 10-14/26');
  assert.equal(range.headers.etag, `"${hash}"`);
  assert.equal(range.data.toString(), 'KLMNO');
  const head = await fetch(worker, '/fixtures/test-case', { method: 'HEAD', headers: deviceHeaders });
  assert.equal(head.headers['content-length'], '26');
  assert.equal(head.data.length, 0);
  assert.equal((await fetch(worker, '/fixtures/test-case', { headers: { ...deviceHeaders, Range: 'bytes=26-' } })).code, 416);
  assert.equal((await fetch(worker, '/fixtures/test-case', { headers: { ...deviceHeaders, 'If-Match': '"different"' } })).code, 412);
  await writeFile(fixture, 'changed');
  assert.equal((await fetch(worker, '/fixtures/test-case', { headers: deviceHeaders })).code, 412);
  const event = await fetch(worker, `/api/v1/runs/${job.id}/events`, { headers: deviceHeaders, body: { tab, build: job.build.id,
    status: 'result', outcome: 'failed', reason: 'test-asset-changed', result: { fixtureSha256: hash } } });
  assert.equal(event.code, 200);
  const receipt = JSON.parse((await fetch(master, `/api/v1/runs/${job.id}`, { headers: adminHeaders })).data);
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.qualification, 'NOT_QUALIFIED');
});
