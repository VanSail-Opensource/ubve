import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd(), stamp = new Date().toISOString().replaceAll(':', '-');
const evidencePath = path.join(root, 'evidence', `pipeline-browser-${stamp}.json`);
const fixture = JSON.parse(await readFile('test/fixtures/primary/manifest.json', 'utf8'));
assert.equal(createHash('sha256').update(await readFile(fixture.path)).digest('hex'), fixture.sha256);
const server = await createServer({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player', server: { port: 0, strictPort: false } });
let browser, record;
await mkdir('evidence', { recursive: true });
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}), headless: true,
    args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage(), pageErrors = []; page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${address.port}/tests/pipeline.html`);
  await page.locator('#fixture').setInputFiles(path.join(root, fixture.path));
  await page.locator('#run').click();
  await page.waitForFunction(() => ['complete', 'failed'].includes(document.querySelector('#result')?.getAttribute('data-status') ?? ''), null, { timeout: 90000 });
  record = JSON.parse(await page.locator('#result').textContent());
  record.pageErrors = pageErrors;
  record.fixtureManifest = fixture;
  await writeFile(evidencePath, JSON.stringify(record, null, 2) + '\n');
  assert.equal(record.status, 'SHORT_PIPELINE_EXECUTED_NOT_QUALIFIED', JSON.stringify(record.error));
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.equal(record.fixture.sha256, fixture.sha256);
  const eos = record.stages.find(stage => stage.event === 'eos');
  assert.equal(eos.diagnostics.managed.decodedVideoFrames, 48);
  assert.equal(eos.diagnostics.managed.submittedVideoFrames, 48);
  assert.ok(record.stages.some(stage => stage.event === 'disposed'));
  console.log(`Short managed pipeline evidence saved: ${evidencePath}; strict gate remains NOT_QUALIFIED.`);
} catch (error) {
  record ??= { schema: 'ubve-implementation-pipeline-v1', status: 'BLOCKED_OR_FAILED', qualified: false,
    measuredFrames: null, measuredFps: null, physicalOutputVerified: null, reason: String(error), recordedAt: new Date().toISOString() };
  await writeFile(evidencePath, JSON.stringify(record, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await server.close(); }
