import { api, el, message } from './model.js';
import type { Fixture } from './model.js';

interface Device { id: string; name: string; platform: string; connected: boolean; ready: boolean;
  environment: { isolated: boolean; focused: boolean; audioSampleRates: number[] } | null }
interface Attempt { id: string; deviceId: string; fixture: string; state: string; reason: string | null; build: string; transport: string; scenario: string }
interface Dashboard { build: { id: string; commit: string; dirty: boolean }; fixtures: Fixture[]; devices: Device[]; attempts: Attempt[] }
const status = el('status'), target = el<HTMLSelectElement>('target'), fixture = el<HTMLSelectElement>('fixture');
const transport = el<HTMLSelectElement>('transport');
let fixtures: readonly Fixture[] = [];
const syncTransport = () => {
  const disc = fixtures.find(item => item.id === fixture.value)?.discClip != null;
  const range = Array.from(transport.options).find(option => option.value === 'range');
  if (range) range.disabled = disc;
  if (disc) transport.value = 'file';
};
const notice = (text: string) => { status.textContent = text; };
const fill = (select: HTMLSelectElement, options: readonly [string, string][]) => {
  const before = select.value;
  select.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
  if (options.some(([id]) => id === before)) select.value = before;
};
const link = (href: string, title: string) => {
  const a = document.createElement('a');
  a.href = href; a.textContent = title; a.target = '_blank'; a.rel = 'noopener';
  return a;
};
async function refresh(): Promise<void> {
  const d = await api<Dashboard>('/api/v1/dashboard');
  fixtures = d.fixtures;
  el('build').textContent = `Build ${d.build.id.slice(0, 12)} · commit ${d.build.commit.slice(0, 12)}${d.build.dirty ? ' with local changes' : ''}`;
  fill(target, d.devices.map(x => [x.id, `${x.name} · ${x.connected ? 'connected' : 'offline'}`]));
  fill(fixture, d.fixtures.map(f => [f.id, f.id]));
  syncTransport();
  el('devices').replaceChildren(...d.devices.map(x => {
    const row = document.createElement('li');
    const sound = x.environment?.audioSampleRates ?? [];
    row.textContent = `${x.name} · ${x.platform} · ${x.connected ? x.ready ? 'ready' : 'connected' : 'offline'}${x.environment?.focused ? ' · focused' : ''}${x.environment?.isolated ? ' · isolated' : ''}${sound.length ? ` · ${sound.join(', ')} Hz audio admitted` : ''}`;
    return row;
  }));
  el('attempts').replaceChildren(...d.attempts.map(x => {
    const row = document.createElement('tr');
    const name = d.devices.find(device => device.id === x.deviceId)?.name ?? x.deviceId.slice(0, 8);
    for (const text of [`${x.fixture} · ${x.transport}`, name, [x.state, x.reason].filter(Boolean).join(' · '), x.build.slice(0, 10)]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    const actions = document.createElement('td');
    actions.append(link(`/api/v1/runs/${x.id}`, 'JSON'));
    if (['queued', 'preparing', 'activation', 'running'].includes(x.state)) {
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      cancel.onclick = () => { void api(`/api/v1/runs/${x.id}/cancel`, {}).then(refresh).catch(e => notice(message(e))); };
      actions.append(' ', cancel);
    }
    row.append(actions);
    return row;
  }));
}
async function start(): Promise<void> {
  const code = new URLSearchParams(location.hash.slice(1)).get('admin');
  if (code) { await api('/api/v1/admin', { code }); history.replaceState(null, '', '/'); }
  await refresh();
  fixture.onchange = syncTransport;
  notice('Ready. Pair a foreground browser to run tests.');
  el('pair').onclick = () => {
    void api<{ code: string; runnerOrigin: string }>('/api/v1/pairs', {}).then(({ code, runnerOrigin }) => {
      const url = `${runnerOrigin}/isolated/#join=${encodeURIComponent(code)}`;
      el('pair-link').replaceChildren(link(url, url), ' · one use, expires in five minutes');
    }).catch(e => notice(message(e)));
  };
  el<HTMLFormElement>('queue').onsubmit = event => {
    event.preventDefault();
    void api('/api/v1/runs', { deviceId: target.value, fixtureId: fixture.value, transport: transport.value,
      scenario: el<HTMLSelectElement>('scenario').value, av1: el<HTMLSelectElement>('av1').value, foldDown: el<HTMLInputElement>('fold').checked,
      prefetchCanvas: el<HTMLInputElement>('prefetch').checked,
      pair: el<HTMLInputElement>('pair-label').value || null }).then(() => { notice('Test queued.'); return refresh(); }).catch(e => notice(message(e)));
  };
  const tick = async (): Promise<void> => {
    try { if (!document.hidden) await refresh(); }
    catch (e) { notice(message(e)); }
    setTimeout(() => { void tick(); }, 2000);
  };
  void tick();
}
void start().catch(error => notice(message(error)));
