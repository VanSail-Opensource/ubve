// Production lab smoke. The browser must already trust the supplied CA.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startLab } from './server.mjs';

const { UBVE_LAB_CERT: cert, UBVE_LAB_KEY: key } = process.env;
assert.ok(cert && key, 'Set UBVE_LAB_CERT and UBVE_LAB_KEY to a trusted certificate and key with a 127.0.0.1 SAN');
const evidence = '.local/device-lab-browser-smoke';
await mkdir(evidence, { recursive: true });
const smoke = await mkdtemp(path.join(evidence, 'manifest-'));
const primary = JSON.parse(await readFile('test/lab/fixtures.json', 'utf8')).cases[0];
const authored = JSON.parse(await readFile('test/fixtures/modern/manifest.json', 'utf8')).cases;
const endTrim = ['opus-ogg', 'mp3'].map(id => {
  const fixture = authored.find(row => row.id === id);
  assert.ok(fixture, `Missing locked trim fixture ${id}`);
  return { ...fixture, path: 'test/fixtures/modern/' + fixture.path };
});
const manifestFile = path.join(smoke, 'fixtures.json');
await writeFile(manifestFile, JSON.stringify({ cases: [primary, ...endTrim] }));
const lab = await startLab({ tls: { cert: await readFile(cert), key: await readFile(key) },
  buildDir: process.env.UBVE_LAB_BUILD_DIR ?? '.local/device-lab-build', mediaRoot: '.',
  manifestFile, evidence, runnerPort: 0, controllerPort: 0 });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, args: ['--disable-gpu'], headless: true });
  const master = await browser.newPage();
  await master.goto(lab.controllerOrigin + '/#admin=' + lab.adminCode);
  await master.locator('#status').filter({ hasText: 'Ready' }).waitFor();
  await master.locator('#pair').click();
  const join = await master.locator('#pair-link a').getAttribute('href');
  assert.ok(join, 'Controller did not create a pairing link');
  const device = await browser.newPage();
  await device.goto(join);
  assert.equal(await device.evaluate(() => isSecureContext && crossOriginIsolated), true);
  await device.locator('#name').fill('Local Chromium smoke');
  await device.locator('#platform').fill(process.platform);
  await device.locator('#pair button').click();
  await device.locator('#status').filter({ hasText: 'start automatically' }).waitFor();
  assert.equal(await device.locator('#setup-audio').isVisible(), false);
  await master.bringToFront();
  await master.waitForFunction(() => document.querySelector('#target option')?.textContent?.includes('connected'));
  const deviceId = await master.locator('#target').inputValue();
  const receipts = [];
  for (const fixture of [primary, primary, ...endTrim]) {
    await master.bringToFront();
    await master.locator('#fixture').selectOption(fixture.id);
    await master.locator('#queue button').click();
    await device.bringToFront();
    // No gestures on the device after enrollment, including seek and reopen.
    const deadline = Date.now() + 110_000;
    let id;
    while (!id && Date.now() < deadline) {
      id = await master.evaluate(async ({ device, seen }) => {
        const view = await (await fetch('/api/v1/dashboard', { signal: AbortSignal.timeout(4000) })).json();
        return view.attempts.find(attempt => attempt.deviceId === device && !seen.includes(attempt.id) &&
          ['passed', 'failed', 'refused', 'interrupted', 'timeout', 'cancelled', 'disconnected'].includes(attempt.state))?.id;
      }, { device: deviceId, seen: receipts });
      if (!id) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(id, 'Automatic lab playback did not settle before the deadline');
    const result = await master.evaluate(async runId => (await fetch('/api/v1/runs/' + runId)).json(), id);
    assert.equal(result.state, 'passed', result.reason ?? JSON.stringify(result.result));
    assert.equal(result.result.cleanup, true);
    assert.equal(result.result.route, 'C1');
    assert.deepEqual(result.result.environment.audioSampleRates, [48000]);
    assert.equal(result.result.stages.firstEos.diagnostics.submittedVideoFrames, fixture.expected.videoFrames);
    assert.equal(result.result.stages.firstEos.diagnostics.audio.consumedFrames, fixture.expected.pcmFrames);
    receipts.push(result.id);
  }
  console.log(`Trusted HTTPS Chromium completed C1 twice and exact Opus/MP3 tail checks after one enrollment: ${receipts.join(', ')}`);
} finally {
  await browser?.close();
  await lab.close();
}
