import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  control: { type: 'string' }, device: { type: 'string' },
  fixture: { type: 'string', multiple: true }, all: { type: 'boolean' },
  transport: { type: 'string', default: 'auto' }, scenario: { type: 'string', default: 'lifecycle' },
  av1: { type: 'string', default: 'portable' }, 'fold-down': { type: 'boolean' },
  'wait-ms': { type: 'string', default: '60000' },
} });
const waitMs = Number(values['wait-ms']);
if (!values.device?.trim() || Boolean(values.all) === Boolean(values.fixture?.length) ||
    !['auto', 'range', 'file'].includes(values.transport) || !['lifecycle', 'timing'].includes(values.scenario) ||
    !['portable', 'automatic'].includes(values.av1) || !Number.isSafeInteger(waitMs) || waitMs < 1000 || waitMs > 300_000) {
  throw new Error('Use --device NAME_OR_ID with --fixture ID (repeatable) or --all and a valid lab job configuration');
}

const control = values.control ? JSON.parse(await readFile(values.control, 'utf8')) : {
  controllerOrigin: process.env.UBVE_LAB_CONTROLLER, adminCode: process.env.UBVE_LAB_ADMIN_CODE,
};
const controller = new URL(control.controllerOrigin);
if (controller.protocol !== 'https:' || controller.hostname !== '127.0.0.1' || controller.href !== controller.origin + '/' ||
    typeof control.adminCode !== 'string' || !control.adminCode) throw new Error('Supply the trusted loopback controller origin and admin code');
let cookie;
const api = async (path, body) => {
  const response = await fetch(new URL(path, controller), { signal: AbortSignal.timeout(5000), redirect: 'error',
    method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: controller.origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`Master HTTP ${response.status}: ${data.error ?? 'controller request failed'}`);
  return { data, response };
};
const login = await api('/api/v1/admin', { code: control.adminCode });
cookie = login.response.headers.getSetCookie()[0]?.split(';', 1)[0];
if (!cookie) throw new Error('Master issued no controller session');

const waitFor = async (read, timeout, reason) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await delay(1000);
  }
  throw new Error(reason);
};
const lookup = async () => {
  const { data } = await api('/api/v1/dashboard');
  const candidates = data.devices.filter(d => d.connected && (d.id === values.device || d.name === values.device));
  if (candidates.length > 1) throw new Error('Multiple connected devices share that name. Select the exact device ID.');
  return candidates[0]?.ready ? { device: candidates[0], fixtures: data.fixtures } : null;
};
const first = await waitFor(lookup, waitMs, 'No matching foreground runner became ready');
const known = new Map(first.fixtures.map(f => [f.id, f]));
const playlist = values.all ? [...known.keys()] : values.fixture;
for (const fixture of playlist) if (!known.has(fixture)) throw new Error(`No such fixture on this master: ${fixture}`);
if (values.transport === 'range' && playlist.some(id => known.get(id).discClip)) throw new Error('Blu-ray image jobs require --transport file or auto');

const terminal = new Set(['passed', 'failed', 'refused', 'interrupted', 'timeout', 'cancelled', 'disconnected']);
for (const [index, fixtureId] of playlist.entries()) {
  if (index > 0) await waitFor(async () => (await lookup())?.device.id === first.device.id ? true : null, waitMs,
    'The enrolled runner did not become ready for the next job');
  const transport = values.transport === 'auto' ? known.get(fixtureId).discClip ? 'file' : 'range' : values.transport;
  const { data: queued } = await api('/api/v1/runs', { deviceId: first.device.id, fixtureId, transport,
    scenario: values.scenario, av1: values.av1, foldDown: values['fold-down'] === true });
  const attempt = await waitFor(async () => {
    const { data } = await api('/api/v1/runs/' + encodeURIComponent(queued.id));
    return terminal.has(data.state) ? data : null;
  }, 245_000, `The master did not settle attempt ${queued.id}`);
  const eos = attempt.result?.stages?.firstEos?.diagnostics;
  console.log(JSON.stringify({ id: attempt.id, fixture: fixtureId, build: attempt.build.id, state: attempt.state, reason: attempt.reason,
    decodedVideoFrames: eos?.decodedVideoFrames ?? null, submittedVideoFrames: eos?.submittedVideoFrames ?? null,
    pcmFrames: eos?.audio?.consumedFrames ?? null, physicalOutput: null, qualification: attempt.qualification }));
  if (attempt.state !== 'passed') process.exitCode = 1;
}
