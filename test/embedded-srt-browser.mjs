import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const fixture = fileURLToPath(new URL('./fixtures/embedded-srt.mkv', import.meta.url));
const fixtureSha256 = createHash('sha256').update(await readFile(fixture)).digest('hex');
assert.equal(fixtureSha256, 'd01b5f608a5d07e67aca5d48e106a023e62821925dd26b7120d0f54f189075fa');
const external = process.env.UBVE_SRT_PLAYER_URL;
const server = external ? null : await preview({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player',
  preview: { host: '127.0.0.1', port: 0, strictPort: true } });
const origin = external ? new URL(external).origin : `http://127.0.0.1:${server.httpServer.address().port}`;
const report = { origin, fixtureSha256, results: [], qualification: 'NOT_QUALIFIED' };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true, args: ['--disable-gpu'] });
  report.browser = browser.version();
  const targets = [{ document: '/', route: 'automatic', expected: 'C1' }, { document: '/isolated/', route: 'managed', expected: 'C1' }];
  if (process.env.UBVE_SRT_BRIDGE === '1') targets.push({ document: '/', route: 'experimental', expected: 'N1' });
  for (const { document, route, expected } of targets) {
    const page = await browser.newPage({ locale: 'en-US' });
    const record = { document, route, expected, status: 'FAILED', steps: [], pageErrors: [] };
    report.results.push(record);
    page.on('pageerror', error => record.pageErrors.push(String(error)));
    const overlay = page.locator('.subtitle-overlay');
    const timeline = page.locator('#seek-position');
    const waitState = async expectedState => {
      const value = await page.waitForFunction(wanted => {
        const state = document.querySelector('.session-state')?.textContent.trim();
        return state === 'Playback issue' || state === wanted ? state : false;
      }, expectedState, { timeout: 25000 });
      assert.equal(await value.jsonValue(), expectedState, (await page.locator('.stage-error').allTextContents()).join(' '));
    };
    const readDiagnostics = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export diagnostics' }).click()]);
      return JSON.parse(await readFile(await download.path(), 'utf8'));
    };
    const seekPaused = async seconds => {
      await timeline.evaluate((el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, seconds);
      await waitState('Paused');
      assert.ok(Math.abs(Number(await timeline.inputValue()) - seconds) < 0.01);
    };
    try {
      await page.goto(origin + document, { timeout: 20000 });
      assert.equal(await page.evaluate(() => crossOriginIsolated), document === '/isolated/');
      if (route !== 'automatic') await page.locator('select').filter({ has: page.locator('option[value="automatic"]') }).selectOption(route);
      await page.getByLabel('Open media').setInputFiles(fixture);
      await waitState('Ready');
      const ready = (await readDiagnostics()).snapshot;
      assert.equal(ready.route, expected);
      assert.equal(ready.tracks.find(track => track.id === ready.selectedSubtitle).codec, 'srt');
      assert.equal(ready.requiresOverlay, true);
      assert.equal(await overlay.innerText(), '');
      record.steps.push('Selected default SRT on open without autoplay or a visible cue before its timestamp');
      await page.locator('.first-play button').click();
      await overlay.locator('b').filter({ hasText: 'Covering cue' }).waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await overlay.innerText(), /Covering cue\s+Second row & timing/);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await waitState('Paused');
      record.steps.push('Playback displayed formatted text and its second line on the media clock');
      await seekPaused(2.25);
      await overlay.locator('b').filter({ hasText: 'Covering cue' }).waitFor({ state: 'visible' });
      await seekPaused(2.95);
      assert.equal(await overlay.innerText(), '', 'Expired cue must clear in the gap');
      await seekPaused(3.65);
      await overlay.locator('i').filter({ hasText: 'Next cue' }).waitFor({ state: 'visible' });
      await seekPaused(0.05);
      assert.equal(await overlay.innerText(), '');
      record.steps.push('Forward and backward paused seeks reconstructed a cue from an earlier cluster and cleared expired cues');
      await page.getByRole('button', { name: 'Off', exact: true }).click();
      await overlay.locator(':scope > *').waitFor({ state: 'detached' });
      assert.equal(await overlay.locator(':scope > *').count(), 0);
      await seekPaused(2.25);
      assert.equal(await overlay.locator(':scope > *').count(), 0, 'Disabled embedded stream must not reappear on seek');
      record.steps.push('Disable clears the overlay and remains off on seek');
      assert.deepEqual(record.pageErrors, []);
      record.status = 'PASSED';
      console.log(`${document} ${route} ${expected}: embedded SRT playback, seek reconstruction and disable passed.`);
    } catch (error) { record.error = String(error); throw error; }
    finally { await page.close(); }
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await mkdir('.local/embedded-srt-browser', { recursive: true });
  await writeFile(`.local/embedded-srt-browser/run-${Date.now()}-${process.pid}.json`, JSON.stringify(report, null, 2) + '\n');
}
