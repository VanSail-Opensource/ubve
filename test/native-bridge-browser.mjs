import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const fixture = JSON.parse(await readFile(process.env.UBVE_NATIVE_TEST_MANIFEST ?? 'test/fixtures/primary/manifest.json', 'utf8'));
const expected = {
  width: fixture.video.width, height: fixture.video.height, videoFrames: Number(fixture.video.nb_read_frames ?? 48),
  subtitlePackets: Number(fixture.subtitle.nb_read_frames),
  cueDurationsNs: fixture.subtitle.cueDurationsNs ?? ['800000000'],
  pcmFrames: fixture.audio.decodedFrames ?? 38400,
};
const evidenceDirectory = process.env.UBVE_EVIDENCE_DIR ?? 'evidence';
const evidencePath = join(evidenceDirectory, `native-bridge-browser-${new Date().toISOString().replaceAll(':', '-')}.json`);
await mkdir(evidenceDirectory, { recursive: true });
let server, browser, record;
try {
  let origin = process.env.UBVE_TEST_ORIGIN;
  if (!origin) {
    server = await createServer({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player', server: { port: 0, strictPort: false } });
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  browser = process.env.UBVE_CDP_URL ? await chromium.connectOverCDP(process.env.UBVE_CDP_URL) : await chromium.launch({
    ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}),
    headless: true, args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(new URL('/tests/native-bridge.html', origin).href);
  await page.locator('#fixture').setInputFiles(resolve(fixture.path));
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#result')?.getAttribute('data-status') === 'done', null, { timeout: 60000 });
  record = JSON.parse(await page.locator('#result').textContent());
  record.pageErrors = pageErrors;
  assert.equal(record.fixtureSha256, fixture.sha256);
  assert.deepEqual(pageErrors, []);
  assert.equal(record.status, 'SHORT_NATIVE_CANDIDATE_EXECUTED_NOT_QUALIFIED', JSON.stringify(record));
  assert.deepEqual(
    [record.initialPlayback.width, record.initialPlayback.height, record.initialPlayback.forwardedSubtitlePackets, record.initialPlayback.stats.pcmFrames],
    [expected.width, expected.height, expected.subtitlePackets, expected.pcmFrames],
  );
  assert.equal(record.initialPlayback.totalVideoFrames, expected.videoFrames);
  assert.deepEqual(record.initialPlayback.cueDurationsNs, expected.cueDurationsNs);
  assert.equal(record.initialPlayback.stats.heldBytes, 0);
  assert.equal(record.preloadRestored, true);
  console.log(`Native candidate evidence saved at ${evidencePath}; no strict gate, physical output or subtitle-render pass claimed.`);
} catch (error) {
  record ??= { schema: 'ubve-native-bridge-candidate-v1', status: 'BLOCKED_OR_FAILED_NOT_QUALIFIED', qualified: false, physicalOutputVerified: null, reason: error.message };
  throw error;
} finally {
  await writeFile(evidencePath, JSON.stringify(record, null, 2) + '\n');
  await browser?.close(); await server?.close();
}
