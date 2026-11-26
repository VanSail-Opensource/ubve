import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.cwd();
const stamp = new Date().toISOString().replaceAll(':', '-');
const outputDirectory = path.resolve(process.env.UBVE_PIPELINE_OUTPUT ?? 'evidence');
const manifestPath = process.env.UBVE_PIPELINE_MANIFEST ?? 'test/fixtures/primary/manifest.json';
const mediaRoot = path.resolve(process.env.UBVE_PIPELINE_MEDIA_ROOT ?? root);
const sha256 = async (file) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const schema = 'ubve-implementation-pipeline-v2';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const cases = Array.isArray(manifest.cases) ? manifest.cases : [{ id: '720p60-primary', ...manifest }];
assert.ok(cases.length > 0 && cases.length <= 32, 'Browser screening must have 1–32 declared cases');
assert.equal(new Set(cases.map(fixture => fixture.id)).size, cases.length, 'Every fixture case needs a distinct ID');
for (const fixture of cases) {
  assert.match(fixture.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.ok(!['runner', 'cohort'].includes(fixture.id), 'Fixture ID collides with runner receipt');
}
await mkdir(outputDirectory, { recursive: true });
const harnessFiles = ['test/pipeline-browser.mjs', 'apps/vue-player/tests/pipeline.ts', 'apps/vue-player/tests/pipeline.html', 'package-lock.json', 'apps/vue-player/public/vendor/assets-manifest.json'];
const environment = {
  os: platform(), kernel: release(), arch: process.arch, node: process.version, cpuModel: cpus()[0]?.model ?? null,
  availableParallelism: availableParallelism(), hostMemoryBytes: totalmem(), headless: true,
  githubActions: process.env.GITHUB_ACTIONS === 'true', githubRunId: process.env.GITHUB_RUN_ID ?? null,
  checkoutCommit: git('rev-parse', 'HEAD'), trackedFilesDirty: Boolean(git('status', '--porcelain', '--untracked-files=no')),
  inputManifestSha256: await sha256(manifestPath),
  harnessInputs: Object.fromEntries(await Promise.all(harnessFiles.map(async (file) => [file, await sha256(file).catch(() => null)]))),
};
const server = await createServer({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player', server: { port: 0, strictPort: false } });
let browser;
const files = [], failures = [];
const writeRecord = async (fixture, record) => {
  const file = `pipeline-browser-${stamp}-${fixture.id}.json`;
  await writeFile(path.join(outputDirectory, file), JSON.stringify(record, null, 2) + '\n');
  return file;
};
function assertShortScreening(record, fixture) {
  assert.equal(record.status, 'SHORT_PIPELINE_EXECUTED_NOT_QUALIFIED', JSON.stringify(record.error));
  assert.equal(record.qualified, false);
  assert.equal(record.pageErrors.length, 0, record.pageErrors.join('\n'));
  assert.equal(record.fixture.sha256, fixture.sha256);
  assert.equal(record.fixture.bytes, fixture.bytes);
  assert.equal(record.environment.crossOriginIsolated, true);
  const stage = (name) => {
    const value = record.stages.find(stage => stage.event === name);
    assert.ok(value, `Missing lifecycle checkpoint ${name}`);
    return value;
  };
  const ready = stage('open-ready');
  assert.equal(ready.snapshot.state, 'ready');
  assert.equal(ready.snapshot.route, 'C1');
  assert.equal(ready.snapshot.quality, 'performance');
  assert.equal(ready.snapshot.rate, 1);
  assert.equal(ready.snapshot.source.width, fixture.video.width);
  assert.equal(ready.snapshot.source.height, fixture.video.height);
  assert.ok(ready.snapshot.tracks.some(track => track.kind === 'video' && track.codec === fixture.video.codec_name));
  assert.ok(ready.snapshot.tracks.some(track => track.kind === 'audio' && track.codec === fixture.audio.codec_name && track.channels === fixture.audio.channels));
  assert.ok(ready.snapshot.tracks.some(track => track.kind === 'subtitle' && track.codec === fixture.subtitle.codec_name));
  assert.equal(ready.output.videoCanvasCount, 1);
  assert.equal(ready.output.subtitleCanvasCount, 1);
  assert.equal(ready.output.nativeSrcPresent, false);
  assert.equal(ready.output.nativeCurrentSrc, null);
  const finish = stage('eos');
  const managed = finish.diagnostics.managed;
  assert.equal(finish.snapshot.state, 'ended');
  assert.equal(managed.decodedVideoFrames, Number(fixture.video.nb_read_frames));
  assert.equal(managed.submittedVideoFrames, Number(fixture.video.nb_read_frames));
  assert.equal(managed.audio.state, 'ended');
  assert.equal(managed.audio.nextMediaSample, fixture.audio.decoded_sample_frames);
  assert.equal(managed.audio.consumedFrames, fixture.audio.decoded_sample_frames);
  assert.equal(managed.audio.underruns, 0);
  assert.equal(managed.recoveries, 0);
  assert.equal(managed.subtitles.state, 'ready');
  assert.equal(managed.subtitles.renderer, 'jassub-2.5.38');
  assert.equal(managed.subtitles.eventCount, Number(fixture.subtitle.nb_read_frames));
  assert.ok(managed.subtitles.fontCount > 0, 'No attached subtitle font was loaded');
  assert.equal(stage('paused-seek').snapshot.state, 'paused');
  assert.equal(stage('seek-eos').snapshot.state, 'ended');
  assert.equal(stage('close').snapshot.state, 'empty');
  assert.equal(stage('close').output.videoCanvasCount, 0);
  assert.notEqual(stage('reopen').snapshot.sessionId, ready.snapshot.sessionId);
  assert.equal(stage('disposed').snapshot.state, 'disposed');
  assert.equal(stage('disposed').output.videoCanvasCount, 0);
  assert.equal(stage('disposed').output.subtitleCanvasCount, 0);
}
async function readPageRecord(page) {
  try {
    const raw = await page.locator('#result').textContent({ timeout: 1500 });
    return JSON.parse(raw);
  } catch { return null; }
}
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}), headless: true,
    args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  for (const fixture of cases) {
    let page, observed;
    const pageErrors = [], failedRequests = [], consoleWarnings = [];
    const record = { schema, recordedAt: new Date().toISOString(), hostEnvironment: { ...environment, browserVersion: browser.version() }, fixtureManifest: fixture,
      evidenceClass: 'browser-short-pipeline-screening', status: 'STARTED', qualified: false, pageErrors, failedRequests, consoleWarnings };
    try {
      const filename = path.resolve(mediaRoot, fixture.path);
      assert.ok(filename.startsWith(mediaRoot + path.sep), 'Fixture path must be inside the declared media root');
      assert.equal(await sha256(filename), fixture.sha256, 'Fixture hash mismatch');
      page = await browser.newPage();
      page.on('pageerror', error => pageErrors.push(String(error)));
      page.on('requestfailed', request => failedRequests.push({ url: request.url(), reason: request.failure()?.errorText ?? null }));
      page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') consoleWarnings.push({ type: message.type(), text: message.text() });
      });
      const query = new URLSearchParams({ trace: process.env.UBVE_PIPELINE_TRACE === '1' ? '1' : '0',
        prefetch: process.env.UBVE_PIPELINE_PREFETCH === '1' ? '1' : '0' });
      await page.goto(`http://127.0.0.1:${address.port}/tests/pipeline.html?${query}`);
      await page.locator('#fixture').setInputFiles(filename);
      await page.locator('#run').click();
      await page.waitForFunction(() => ['complete', 'failed'].includes(document.querySelector('#result')?.getAttribute('data-status') ?? ''), null, { timeout: 90000 });
      observed = await readPageRecord(page);
      assert.ok(observed, 'Browser did not serialize its pipeline evidence');
      Object.assign(record, observed);
      assertShortScreening(record, fixture);
      record.screeningAssertions = 'PASSED_NOT_QUALIFIED';
    } catch (error) {
      if (!observed && page) Object.assign(record, await readPageRecord(page));
      if (!observed) record.status = 'BLOCKED_OR_INCOMPLETE';
      record.screeningAssertions = 'FAILED_NOT_QUALIFIED';
      record.runnerFailure = { name: error.name, message: error.message, stack: error.stack };
      failures.push(`${fixture.id}: ${error.message}`);
    } finally {
      const filename = await writeRecord(fixture, record);
      files.push({ id: fixture.id, file: filename, status: record.status, screeningAssertions: record.screeningAssertions });
      await page?.close();
    }
  }
} catch (error) {
  await writeRecord({ id: 'runner' }, { schema, status: 'BROWSER_LAUNCH_OR_RUNNER_FAILED', qualified: false,
    hostEnvironment: environment, completedCases: files, error: String(error), recordedAt: new Date().toISOString() });
  throw error;
} finally { await browser?.close(); await server.close(); }
await writeRecord({ id: 'cohort' }, { schema, status: failures.length ? 'SCREENING_FAILED_NOT_QUALIFIED' : 'SCREENING_PASSED_NOT_QUALIFIED',
  qualified: false, cases: files, failures, recordedAt: new Date().toISOString() });
if (failures.length) throw new Error(failures.join('\n'));
console.log(`Short managed pipeline screening passed for ${files.length} exact case(s) in ${outputDirectory}; strict gate remains NOT_QUALIFIED.`);
