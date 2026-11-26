import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LEASE_MS = 15_000;
export const ACTIVE = new Set(['preparing', 'activation', 'running', 'cancelling']);
const FINAL = new Set(['passed', 'refused', 'failed', 'cancelled', 'interrupted', 'disconnected', 'timeout']);
const token = () => randomBytes(24).toString('base64url');
const iso = now => new Date(now).toISOString();

export class LabError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (status, message) => { throw new LabError(status, message); };
export const label = (value, limit = 80) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
  !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;

export async function openLabState({ evidence, build, fixtures, now = Date.now }) {
  await mkdir(evidence, { recursive: true });
  const jobs = new Map(), devices = new Map(), pairs = new Map();
  const adminCode = token(), adminSession = token();
  let pending = Promise.resolve();
  const transact = fn => {
    const result = pending.then(fn);
    pending = result.catch(() => undefined);
    return result;
  };
  const persist = async current => {
    const file = path.join(evidence, current.id + '.json');
    const tmp = path.join(evidence, current.id + '.' + randomUUID() + '.part');
    await writeFile(tmp, JSON.stringify(current, null, 2) + '\n', { flag: 'wx' });
    await rename(tmp, file);
    jobs.set(current.id, current);
  };
  const settle = (job, state, reason, result = null) => persist({ ...job, state, reason, result, endedAt: iso(now()) });
  for (const file of await readdir(evidence)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
    const job = JSON.parse(await readFile(path.join(evidence, file), 'utf8'));
    if (job.id + '.json' !== file || job.schema !== 'ubve-lab-attempt-v1') reject(500, 'Invalid saved attempt');
    if (job.state === 'queued' || ACTIVE.has(job.state)) await settle(job, 'interrupted', 'master-restarted');
    else if (FINAL.has(job.state)) jobs.set(job.id, job);
  }

  async function expire() {
    for (const [key, at] of pairs) if (at <= now()) pairs.delete(key);
    for (const job of jobs.values()) {
      if (job.state === 'queued' && job.deadline <= now()) await settle(job, 'timeout', 'queue-deadline');
      if (ACTIVE.has(job.state)) {
        const device = [...devices.values()].find(d => d.id === job.deviceId);
        if (!device || now() - device.lastSeen >= LEASE_MS) await settle(job, 'disconnected', 'worker-lease-expired');
        else if (job.deadline <= now()) await settle(job, 'timeout', 'run-deadline');
      }
    }
  }
  const requireDevice = key => devices.get(key) ?? reject(401, 'Pair this device first');
  const active = deviceId => [...jobs.values()].find(j => j.deviceId === deviceId && ACTIVE.has(j.state));
  const safeDevice = d => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt,
    lastSeen: d.lastSeen, connected: now() - d.lastSeen < LEASE_MS, ready: d.ready === true && now() - d.lastSeen < LEASE_MS, environment: d.environment });
  const brief = j => ({ id: j.id, deviceId: j.deviceId, fixture: j.fixture.id, build: j.build.id,
    state: j.state, reason: j.reason, scenario: j.scenario, transport: j.transport, createdAt: j.createdAt, endedAt: j.endedAt ?? null, pair: j.pair });
  return {
    adminCode, beginAdmin: code => code === adminCode ? adminSession : reject(401, 'Invalid controller link'),
    authorizeAdmin: key => key === adminSession,
    availableFixture: (key, id) => active(requireDevice(key).id)?.fixture.id === id,
    tick: () => transact(expire),
    issuePair: () => transact(async () => {
      await expire();
      if (pairs.size >= 32) reject(429, 'Too many unused pairing links');
      const code = token();
      pairs.set(code, now() + 300_000);
      return code;
    }),
    pair: request => transact(async () => {
      await expire();
      if (!pairs.has(request.code)) reject(401, 'Pairing link expired or was already used');
      const name = label(request.name), platform = label(request.platform);
      if (!name || !platform) reject(400, 'Enter a name and a device/OS label');
      if (devices.size >= 64) reject(429, 'Device limit reached');
      pairs.delete(request.code);
      const key = token(), id = randomUUID();
      devices.set(key, { id, name, platform, createdAt: iso(now()), lastSeen: now(), environment: null, tab: null });
      return { key, id };
    }),
    dashboard: () => transact(async () => {
      await expire();
      return { build, fixtures: [...fixtures.values()].map(f => f.public), devices: [...devices.values()].map(safeDevice),
        attempts: [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 250).map(brief) };
    }),
    detail: id => jobs.get(id) ?? reject(404, 'No such attempt'),
    queue: request => transact(async () => {
      await expire();
      const d = [...devices.values()].find(device => device.id === request.deviceId);
      const fixture = fixtures.get(request.fixtureId)?.public;
      if (!d || !fixture || !['file', 'range'].includes(request.transport) || !['lifecycle', 'timing'].includes(request.scenario) ||
          !['automatic', 'portable'].includes(request.av1) || typeof request.foldDown !== 'boolean') reject(400, 'Invalid job selection');
      if (request.transport === 'file' && fixture.bytes > 64 * 1024 ** 2) reject(400, 'Use range transport above 64 MiB');
      if (fixture.discClip && request.transport !== 'file') reject(400, 'Blu-ray image jobs require the local File lane');
      if (request.pair != null && !label(request.pair, 40)) reject(400, 'Invalid pair label');
      if ([...jobs.values()].filter(j => j.state === 'queued' || ACTIVE.has(j.state)).length >= 64) reject(429, 'Too many outstanding attempts');
      const job = { schema: 'ubve-lab-attempt-v1', evidenceClass: request.scenario === 'timing' ? 'paired-software-screening' : 'browser-software-screening',
        id: randomUUID(), deviceId: d.id, device: { name: d.name, platform: d.platform }, build, fixture, route: 'C1',
        transport: request.transport, scenario: request.scenario, av1: request.av1, foldDown: request.foldDown,
        prefetchCanvas: request.scenario === 'timing' && request.prefetchCanvas === true,
        pair: request.pair ?? null, state: 'queued', reason: null, result: null, createdAt: iso(now()), deadline: now() + 120_000,
        qualification: 'NOT_QUALIFIED' };
      await persist(job);
      return brief(job);
    }),
    cancel: id => transact(async () => {
      await expire();
      const job = jobs.get(id) ?? reject(404, 'No such attempt');
      if (job.state === 'queued') await settle(job, 'cancelled', 'master-cancelled-before-dispatch');
      else if (ACTIVE.has(job.state) && job.state !== 'cancelling') await persist({ ...job, state: 'cancelling', reason: 'master-requested-cancel' });
      return brief(jobs.get(id));
    }),
    poll: (key, request) => transact(async () => {
      await expire();
      const device = requireDevice(key);
      if (!label(request.tab, 48)) reject(400, 'Missing runner tab identity');
      if (device.tab && request.tab !== device.tab && now() - device.lastSeen < LEASE_MS) reject(409, 'This device is active in another tab');
      device.tab = request.tab;
      device.lastSeen = now();
      device.ready = request.ready === true;
      if (request.environment && typeof request.environment === 'object') {
        const env = request.environment;
        device.environment = { userAgent: label(env.userAgent, 512), secure: env.secure === true, isolated: env.isolated === true,
          visible: env.visible === true, focused: env.focused === true, audioWorklet: env.audioWorklet === true,
          audioSampleRates: Array.isArray(env.audioSampleRates) && env.audioSampleRates.length <= 4 ?
            env.audioSampleRates.filter(rate => Number.isSafeInteger(rate) && rate >= 8000 && rate <= 192000) : [] };
      }
      let job = active(device.id);
      if (!job && request.ready === true) {
        const live = [...jobs.values()].filter(j => ACTIVE.has(j.state));
        const waiting = [...jobs.values()].filter(j => j.state === 'queued');
        const timed = waiting.find(j => j.scenario === 'timing');
        const next = timed ? (!live.length && timed.deviceId === device.id ? timed : null) : waiting.find(j => j.deviceId === device.id);
        if (next && !live.some(j => j.scenario === 'timing')) {
          job = { ...next, state: 'preparing', deadline: now() + 120_000, assignedAt: iso(now()) };
          await persist(job);
          device.ready = false;
        }
      }
      return { job: job ?? null, peerTime: now(), leaseMs: LEASE_MS };
    }),
    event: (key, id, event) => transact(async () => {
      await expire();
      const d = requireDevice(key);
      if (event.tab !== d.tab) reject(409, 'Attempt came from a different runner tab');
      const job = jobs.get(id);
      if (!job || job.deviceId !== d.id) reject(404, 'No such assigned attempt');
      if (FINAL.has(job.state)) return { terminal: true, state: job.state };
      if (!ACTIVE.has(job.state)) reject(409, 'Attempt has not been dispatched');
      d.lastSeen = now();
      if (event.build !== job.build.id) reject(409, 'Attempt came from a different build');
      if (event.status === 'phase' && ['preparing', 'activation', 'running'].includes(event.phase)) {
        if (job.state !== 'cancelling' && job.state !== event.phase) await persist({ ...job, state: event.phase });
      } else if (event.status === 'result' && ['passed', 'refused', 'failed', 'cancelled', 'interrupted'].includes(event.outcome) &&
          event.result && typeof event.result === 'object' && !Array.isArray(event.result) && event.result.fixtureSha256 === job.fixture.sha256) {
        const outcome = job.state === 'cancelling' ? 'cancelled' : event.outcome;
        if (outcome === 'passed' && (event.result.cleanup !== true || event.result.route !== 'C1' || event.result.checksPassed !== true)) reject(400, 'A pass needs observed playback checks and cleanup');
        await settle(job, outcome, label(event.reason, 256), event.result);
      } else reject(400, 'Invalid attempt event');
      const status = jobs.get(id).state;
      return { terminal: FINAL.has(status), state: status };
    }),
  };
}
