import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Run after npm ci with FFmpeg and Playwright's Chromium installed, or set
// UBVE_CHROMIUM to a real compatible Chrome/Chromium binary. This lane tests
// native element and UI behavior, not hardware acceleration or real display.
const scratch = await mkdtemp(path.join(tmpdir(), 'ubve-native-smoke-'));
let server, browser;
try {
  const fixture = path.join(scratch, 'clip.webm');
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', 'test/fixtures/vp9-opus-ass.mkv', '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', fixture], { timeout: 15_000 });
  const media = await readFile(fixture);
  server = await createServer({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player', server: { port: 0, strictPort: false } });
  await server.listen();
  browser = await chromium.launch({ ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}), headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'native-smoke.webm', mimeType: 'video/webm', buffer: media });
  await page.waitForFunction(() => document.querySelector('.session-state')?.textContent.trim() === 'Ready');
  assert.equal(await page.locator('.stage-label').innerText(), 'N0 · 128 × 72');
  assert.equal(await page.locator('video').evaluate(video => video.paused), true, 'Open must not autoplay');
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.05);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.session-state')?.textContent.trim() === 'Paused');
  await page.locator('#seek-position').evaluate(slider => {
    slider.value = String(Number(slider.max) / 2);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && Math.abs(video.currentTime - video.duration / 2) < 0.1 && !video.seeking && video.paused;
  });
  await page.getByRole('button', { name: 'Playback settings', exact: true }).click();
  await page.getByLabel('Language').selectOption('zh-TW');
  await page.locator('html[lang="zh-TW"]').waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('button', { name: '播放', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.body.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ evidenceClass: 'FUNCTIONAL_BROWSER_SMOKE', browser: await browser.version(), viewport: '390x844', route: 'N0',
    fixtureSha256: createHash('sha256').update(media).digest('hex'), actions: ['open without autoplay', 'play', 'pause', 'seek while paused', 'live Traditional Chinese labels'],
    horizontalOverflow: false, pageErrorCount: 0, physicalOutputVerified: null, qualified: false }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
  await rm(scratch, { force: true, recursive: true });
}
