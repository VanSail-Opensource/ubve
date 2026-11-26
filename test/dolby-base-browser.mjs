import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { dolbyBaseCarriage } from './fixtures/dolby-base-carriage.mjs';

const authored = await dolbyBaseCarriage(), incompatible = await dolbyBaseCarriage({ profile: 5 });
const av1 = await dolbyBaseCarriage({ av1: true, profile: 10 }), proprietaryAv1 = await dolbyBaseCarriage({ av1: true, profile: 10, compatibility: 0 });
const cases = [
  { id: 'authored-mkv-rpu-carriage', name: 'authored-carriage.mkv', bytes: authored.bytes, mode: 'profile-81', pictures: authored.clean.length },
  { id: 'declared-profile-5-refusal', name: 'no-hdr10-base.mkv', bytes: incompatible.bytes, refused: true },
  { id: 'authored-av1-profile-101-carriage', name: 'authored-av1-carriage.mkv', bytes: av1.bytes, mode: 'profile-101', pictures: av1.clean.length },
  { id: 'declared-profile-10-refusal', name: 'proprietary-av1-color.mkv', bytes: proprietaryAv1.bytes, refused: true, profile: 10 },
];
const root = process.env.UBVE_DOLBY_SAMPLE_ROOT;
if (root) {
  const { cases: verified } = JSON.parse(await readFile(path.join(root, 'reference-manifest.json'), 'utf8'));
  for (const entry of verified) {
    assert.equal(path.basename(entry.path), entry.path);
    const bytes = await readFile(path.join(root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    cases.push({ id: entry.id, name: entry.path, bytes, mode: entry.hdr10Base, pictures: entry.reference.frames.length });
    if (process.env.UBVE_DOLBY_GPU === '1' && entry.id === 'fate-profile7.mkv')
      cases.push({ id: 'profile-7-webgpu-hdr-candidate', name: entry.path, bytes, mode: entry.hdr10Base, pictures: entry.reference.frames.length, gpu: true });
  }
  const p5 = await readFile(path.join(root, 'jellyfin-profile5.mp4'));
  assert.equal(createHash('sha256').update(p5).digest('hex'), 'c0dedeeef7d11c404955e126f9544318cdeb6eab62423528cfde9b567e8ca1a4');
  cases.push({ id: 'jellyfin-real-profile-5-refusal', name: 'profile5.mp4', bytes: p5, refused: true });
}
const external = process.env.UBVE_DOLBY_PLAYER_URL;
const server = external ? null : await preview({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player',
  preview: { host: '127.0.0.1', port: 0, strictPort: true } });
const origin = external ? new URL(external).origin : `http://127.0.0.1:${server.httpServer.address().port}`;
const report = { schema: 'ubve-dolby-base-browser-v1', origin, qualification: 'NOT_QUALIFIED', results: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true });
  report.browser = browser.version();
  for (const entry of cases) {
    const page = await browser.newPage(), errors = [];
    const receipt = { id: entry.id, sha256: createHash('sha256').update(entry.bytes).digest('hex'), status: 'FAILED' };
    report.results.push(receipt);
    page.on('pageerror', error => errors.push(String(error)));
    // Keep the actual probe results in the receipt. Refuse only the DV MIME
    // probe for this test so hardware-advertised DoVi cannot mask the fallback.
    await page.addInitScript(() => {
      window.dvProbes = [];
      const canPlay = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function(mime) {
        const result = canPlay.call(this, mime);
        if (!/\b(?:dvhe|dvh1|dav1)\./i.test(mime)) return result;
        window.dvProbes.push({ mime, result }); return '';
      };
    });
    const waitState = async state => {
      const handle = await page.waitForFunction(wanted => {
        const state = document.querySelector('.session-state')?.textContent.trim();
        return state === wanted || state === 'Playback issue' ? state : false;
      }, state, { timeout: 30000 });
      assert.equal(await handle.jsonValue(), state, await page.locator('.stage-error').allTextContents());
    };
    try {
      await page.goto(origin + '/', { timeout: 20000 });
      if (entry.gpu) await page.getByLabel(/Try WebGPU presentation/).check();
      else await page.getByRole('button', { name: 'Performance', exact: true }).click();
      await page.getByLabel('Open media').setInputFiles({ name: entry.name, mimeType: entry.name.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4', buffer: entry.bytes });
      if (entry.refused) {
        await waitState('Playback issue');
        receipt.refusal = await page.locator('.stage-error p').innerText();
        assert.match(receipt.refusal, new RegExp(`Dolby Vision P${entry.profile ?? 5}.*no verified HDR10-compatible`));
      } else {
        await waitState('Ready');
        await page.locator('.first-play button').click();
        await waitState('Ended');
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export diagnostics' }).click()]);
        const diagnostics = JSON.parse(await readFile(await download.path(), 'utf8')), managed = diagnostics.pipeline.managed;
        assert.equal(diagnostics.snapshot.route, 'C1');
        assert.equal(managed.hdr10Base.mode, entry.mode);
        assert.equal(managed.submittedVideoFrames, entry.pictures);
        assert.equal(managed.renderer.api, entry.gpu ? 'webgpu' : 'canvas2d');
        if (entry.gpu) assert.equal(managed.renderer.output, 'hdr-candidate');
        assert.match(diagnostics.snapshot.notices.join(' '), /Dolby Vision metadata and enhancement are not rendered/);
        receipt.diagnostics = diagnostics;
      }
      receipt.nativeProbes = await page.evaluate(() => window.dvProbes);
      if (entry.name.endsWith('.mp4')) assert.ok(receipt.nativeProbes.length, 'Automatic must check the exact Dolby Vision MIME');
      assert.deepEqual(errors, []);
      receipt.status = 'PASSED';
      console.log(`${entry.id} ${entry.refused ? 'explicitly refused' : `${entry.pictures} base pictures to EOS (${entry.gpu ? 'WebGPU' : 'SDR'})`}`);
    } catch (error) {
      receipt.error = String(error);
      receipt.pageErrors = errors;
      receipt.nativeProbes = await page.evaluate(() => window.dvProbes).catch(() => null);
      process.exitCode = 1;
      console.error(entry.id, error);
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await mkdir('.local/dolby-base-browser', { recursive: true });
  await writeFile(`.local/dolby-base-browser/run-${Date.now()}-${process.pid}.json`, JSON.stringify(report, null, 2) + '\n');
}
