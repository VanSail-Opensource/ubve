import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const { cases } = JSON.parse(await readFile('test/fixtures/packing/manifest.json', 'utf8'));
const fixture = cases.find(row => row.id === 'clear-bluray-iso');
const server = await createServer({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player', server: { host: '127.0.0.1', port: 0 } });
const evidence = '.local/packing-browser';
const report = { schema: 'ubve-disc-picker-browser-v1', qualification: 'NOT_QUALIFIED', results: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true, args: ['--disable-gpu'] });
  report.browser = browser.version();
  for (const [kind, input, name] of [['ISO', fixture.path, 'Open media'],
    ['BDMV folder', 'test/fixtures/packing/clear-bd-folder', 'Open Blu-ray folder']]) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await page.locator(`input[aria-label="${name}"]`).setInputFiles(path.resolve(input));
      const clip = page.getByRole('dialog', { name: 'Select a Blu-ray clip' });
      await clip.getByRole('button', { name: /00000\.mpls.*00000\.m2ts/ }).click();
      await page.locator('.session-state').filter({ hasText: 'Ready' }).waitFor();
      assert.equal(await page.locator('canvas.managed-video-surface').count(), 1);
      await page.locator('.first-play button').click();
      await page.locator('.session-state').filter({ hasText: 'Ended' }).waitFor({ timeout: 35000 });
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export diagnostics' }).click()]);
      const diagnostics = JSON.parse(await readFile(await download.path(), 'utf8'));
      assert.equal(diagnostics.snapshot.route, 'C1');
      assert.equal(diagnostics.snapshot.state, 'ended');
      assert.equal(diagnostics.pipeline.managed.submittedVideoFrames, fixture.expected.videoFrames);
      assert.equal(diagnostics.pipeline.managed.audio.consumedFrames, fixture.expected.pcmFrames);
      report.results.push({ kind, status: 'PASSED', diagnostics });
      console.log(`${kind} picker → C1 playback → EOS`);
    } catch (error) { report.results.push({ kind, status: 'FAILED', reason: String(error) }); process.exitCode = 1; }
    finally { await page.close(); }
  }
} finally {
  await browser?.close();
  await server.close();
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, `picker-${Date.now()}-${process.pid}.json`), JSON.stringify(report, (_key, val) => typeof val === 'bigint' ? String(val) : val, 2) + '\n');
}
