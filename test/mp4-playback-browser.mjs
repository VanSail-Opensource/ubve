import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { fragmentedMp4Fixture, largeMp4Fixture, padClassicMoov, sparsePcmMovie } from './fixtures/paged-mp4.mjs';

const classic = await largeMp4Fixture(), fragmented = await fragmentedMp4Fixture(), pcm = await sparsePcmMovie(480000);
const av1Seed = await readFile(new URL('./fixtures/paged-av1-seed.mp4', import.meta.url));
assert.equal(createHash('sha256').update(av1Seed).digest('hex'), 'a4677a2b10e0a5349eae386918abc525ce158a7e1c544b9418a521292dc3b8d9');
function materialize(fixture) {
  const file = Buffer.alloc(fixture.size);
  for (const [offset, bytes] of fixture.segments) bytes.copy(file, offset);
  return file;
}
const cases = [
  { id: 'classic-avc-aac', filename: 'paged-classic.mp4', bytes: classic.bytes, duration: classic.duration, pictures: 13, samples: 24000, entries: ['/', '/isolated/'] },
  { id: 'fragmented-aac', filename: 'long-fragmented.mp4', bytes: fragmented.bytes, duration: fragmented.durationTicks / 48000, pictures: 0, samples: 24000, entries: ['/'] },
  { id: 'packed-pcm', filename: 'paged-pcm.mov', bytes: materialize(pcm), duration: pcm.duration, pictures: 0, samples: 24000, entries: ['/'] },
  { id: 'oversized-moov-av1-10-bit', filename: 'paged-av1.mp4', bytes: materialize(padClassicMoov(av1Seed)), duration: 4 / 25, pictures: 4, samples: 0, entries: ['/'] },
];
const target = process.env.UBVE_PAGED_MP4_URL;
const server = target ? null : await preview({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player',
  preview: { host: '127.0.0.1', port: 0, strictPort: true } });
const origin = target ? new URL(target).origin : `http://127.0.0.1:${server.httpServer.address().port}`;
const report = { schema: 'ubve-paged-mp4-browser-v1', qualification: 'NOT_QUALIFIED', origin,
  fixtures: cases.map(fixture => ({ id: fixture.id, sha256: createHash('sha256').update(fixture.bytes).digest('hex'), bytes: fixture.bytes.length, duration: fixture.duration })),
  results: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true, args: ['--disable-gpu'] });
  report.browser = browser.version();
  for (const { fixture, entry } of cases.flatMap(fixture => fixture.entries.map(entry => ({ fixture, entry })))) {
    const seek = Math.max(0, fixture.duration - 0.5);
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const waitState = async state => {
      // Surface a player failure immediately instead of waiting out the watchdog.
      const stopped = await page.waitForFunction(wanted => {
        const state = document.querySelector('.session-state')?.textContent.trim();
        return state === wanted || state === 'Playback issue' ? state : false;
      }, state, { timeout: 30000 });
      assert.equal(await stopped.jsonValue(), state, await page.locator('.stage-error').allTextContents());
    };
    try {
      await page.goto(origin + entry, { timeout: 20000 });
      assert.equal(await page.evaluate(() => crossOriginIsolated), entry === '/isolated/');
      await page.getByLabel('Playback route').selectOption('managed');
      await page.getByLabel('Open media').setInputFiles({ name: fixture.filename, mimeType: fixture.filename.endsWith('.mov') ? 'video/quicktime' : 'video/mp4', buffer: fixture.bytes });
      await waitState('Ready');
      const timeline = page.locator('#seek-position');
      assert.equal(Number(await timeline.getAttribute('max')), fixture.duration);
      await timeline.evaluate((input, time) => {
        input.value = String(time);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, seek);
      await waitState('Paused');
      assert.equal(Number(await timeline.inputValue()), seek);
      await page.locator('.transport-play').click();
      await waitState('Ended');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export diagnostics' }).click()]);
      const diagnostic = JSON.parse(await readFile(await download.path(), 'utf8')), managed = diagnostic.pipeline.managed;
      assert.equal(diagnostic.snapshot.route, 'C1');
      assert.equal(diagnostic.snapshot.time, fixture.duration);
      assert.equal(managed.submittedVideoFrames, fixture.pictures, 'the covering frame and all following pictures were submitted');
      assert.equal(managed.audio?.consumedFrames ?? 0, fixture.samples, 'exact audio tail after seek');
      assert.deepEqual(errors, []);
      report.results.push({ fixture: fixture.id, entry, seek, status: 'PASSED', diagnostic });
      process.stdout.write(`${entry} ${fixture.id} → seek to ${seek}s → ${fixture.pictures} pictures, ${fixture.samples} samples, EOS\n`);
    } catch (error) {
      report.results.push({ fixture: fixture.id, entry, seek, status: 'FAILED', error: String(error), pageErrors: errors, state: await page.locator('.session-state').allTextContents() });
      console.error(fixture.id, entry, error);
      process.exitCode = 1;
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await mkdir('.local/paged-mp4-browser', { recursive: true });
  await writeFile(`.local/paged-mp4-browser/run-${Date.now()}-${process.pid}.json`, JSON.stringify(report, null, 2) + '\n');
}
