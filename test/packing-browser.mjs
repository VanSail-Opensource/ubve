import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startLab } from './lab/server.mjs';

const { UBVE_LAB_CERT, UBVE_LAB_KEY } = process.env;
assert.ok(UBVE_LAB_CERT && UBVE_LAB_KEY, 'Supply locally trusted loopback HTTPS PEM files');
const manifestFile = process.env.UBVE_PACKING_MANIFEST ?? 'test/fixtures/packing/manifest.json';
const { cases } = JSON.parse(await readFile(manifestFile, 'utf8'));
const selected = new Set(process.argv.slice(2));
assert.ok([...selected].every(id => cases.some(row => row.id === id)), 'Unknown fixture selection');
const verified = cases.filter(row => !selected.size || selected.has(row.id));
const transport = process.env.UBVE_PACKING_TRANSPORT ?? 'both';
assert.ok(['both', 'range', 'file'].includes(transport));
const plan = verified.flatMap(row => row.discClip ? (transport !== 'range' ? [{ row, transport: 'file' }] : []) :
  (transport === 'both' ? ['file', 'range'] : [transport]).map(value => ({ row, transport: value })));
assert.ok(plan.length, 'No packing jobs selected');
const evidenceRoot = '.local/packing-browser';
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(path.join(evidenceRoot, 'attempt-'));
const records = [], terminal = new Set(['passed', 'failed', 'refused', 'timeout', 'cancelled', 'interrupted', 'disconnected']);
const summary = { schema: 'ubve-packing-browser-v1', capturedAt: new Date().toISOString(),
  interpretation: 'Software browser integration only. No physical output or strict cadence observed.', results: records };
const lab = await startLab({ tls: { cert: await readFile(UBVE_LAB_CERT), key: await readFile(UBVE_LAB_KEY) }, manifestFile, mediaRoot: '.',
  buildDir: process.env.UBVE_LAB_BUILD_DIR ?? '.local/device-lab-build', evidence, runnerPort: 0, controllerPort: 0 });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true, args: ['--disable-gpu'] });
  summary.browser = browser.version();
  const master = await browser.newPage(), runner = await browser.newPage();
  await master.goto(`${lab.controllerOrigin}/#admin=${lab.adminCode}`);
  await master.locator('#status').filter({ hasText: 'Ready' }).waitFor();
  const masterRequest = (url, body) => master.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), ...(body !== null ? { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Error(`Master ${response.status}: ${data.error}`);
    return data;
  }, { url, body: body ?? null });
  const pair = await masterRequest('/api/v1/pairs', {});
  await runner.goto(`${pair.runnerOrigin}/isolated/#join=${encodeURIComponent(pair.code)}`);
  await runner.locator('#name').fill('Container integration browser');
  await runner.locator('#platform').fill(process.platform);
  await runner.locator('#pair button').click();
  await runner.locator('#status').filter({ hasText: 'start automatically' }).waitFor();
  await runner.bringToFront();
  let deviceId;
  const connectDeadline = Date.now() + 12000;
  while (!deviceId && Date.now() < connectDeadline) {
    const dashboard = await masterRequest('/api/v1/dashboard');
    deviceId = dashboard.devices.find(device => device.connected && device.ready)?.id;
    if (!deviceId) await delay(150);
  }
  assert.ok(deviceId, 'Automated container runner did not become ready');
  if (verified.some(row => row.discClip) && transport !== 'range') {
    const disc = verified.find(row => row.discClip);
    await assert.rejects(masterRequest('/api/v1/runs', { deviceId, fixtureId: disc.id, transport: 'range',
      scenario: 'lifecycle', av1: 'portable', foldDown: true }), /local File lane/);
  }

  for (const { row, transport: lane } of plan) {
    const record = { id: row.id, transport: lane, state: 'FAILED', receiptId: null };
    records.push(record);
    try {
      const queued = await masterRequest('/api/v1/runs', { deviceId, fixtureId: row.id, transport: lane,
        scenario: 'lifecycle', av1: 'portable', foldDown: true });
      record.receiptId = queued.id;
      const deadline = Date.now() + 245000;
      let result;
      while (Date.now() < deadline) {
        result = await masterRequest(`/api/v1/runs/${queued.id}`);
        if (terminal.has(result.state)) break;
        await delay(300);
      }
      assert.equal(result?.state, 'passed', result?.reason ?? result?.state);
      assert.equal(result.fixture.sha256, row.sha256);
      assert.equal(result.result.cleanup, true);
      assert.equal(result.result.physicalOutput, null);
      assert.equal(result.result.route, 'C1');
      assert.equal(result.result.environment.secure, true);
      assert.ok(Number.isFinite(result.result.stages.seekMs) && Number.isFinite(result.result.stages.resumeMs));
      const observed = result.result.stages.firstEos.diagnostics;
      if (row.expected.videoFrames !== undefined) {
        assert.equal(observed.decodedVideoFrames, row.expected.videoFrames);
        assert.equal(observed.submittedVideoFrames, row.expected.videoFrames);
      }
      if (row.expected.pcmFrames !== undefined) assert.equal(observed.audio.consumedFrames, row.expected.pcmFrames);
      Object.assign(record, { state: 'PASSED', build: result.build.id, videoFrames: observed.submittedVideoFrames,
        pcmFrames: observed.audio?.consumedFrames ?? null });
    } catch (error) { record.error = error.message; process.exitCode = 1; }
    console.log(`${row.id} ${lane} ${record.state}${record.error ? ' – ' + record.error.split('\n')[0] : ''}`);
  }
} catch (error) { summary.setupError = String(error); throw error; }
finally {
  await browser?.close();
  await lab.close();
  await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Evidence ${evidence}`);
}
