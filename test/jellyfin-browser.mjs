import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { caseSatisfiesExpectation, classifyOpenFailure, localFixture, probeFile, probeVersion, sha256, summarizeCadence, validateCases } from './helpers/jellyfin-fixtures.mjs';

const root = process.cwd();
const manifestPath = process.env.UBVE_JELLYFIN_MANIFEST;
assert.ok(manifestPath, 'Set UBVE_JELLYFIN_MANIFEST to the selected fixture manifest');
const mediaRoot = path.resolve(process.env.UBVE_JELLYFIN_MEDIA_ROOT ?? path.dirname(manifestPath));
const out = path.resolve(process.env.UBVE_JELLYFIN_OUTPUT ?? '.local/jellyfin-browser');
const dist = path.resolve(process.env.UBVE_JELLYFIN_DIST ?? 'apps/vue-player/dist');
const selected = (process.env.UBVE_JELLYFIN_CASES ?? '').split(',').map(x => x.trim()).filter(Boolean);
const span = Number(process.env.UBVE_JELLYFIN_CADENCE_SECONDS ?? '1');
assert.ok(Number.isFinite(span) && span >= .25 && span <= 10, 'Cadence observation must be between .25 and 10 media seconds');
const cases = validateCases(JSON.parse(await readFile(manifestPath, 'utf8')), selected);
const stamp = new Date().toISOString().replaceAll(':', '-');
const runDir = path.join(out, stamp);
await mkdir(runDir, { recursive: true });
const profile = 'browser-native-local-file-functional-screening';
const ffprobe = await probeVersion().catch(error => ({ unavailable: error.code ?? error.name }));
const host = { os: platform(), kernel: release(), arch: process.arch, node: process.version, availableParallelism: availableParallelism(), ffprobe,
  checkoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  trackedFilesDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
  manifestSha256: await sha256(manifestPath), staticIndexSha256: await sha256(path.join(dist, 'index.html')).catch(() => null),
  staticProviderManifestSha256: await sha256(path.join(dist, 'vendor/assets-manifest.json')).catch(() => null),
  harnessSha256: await sha256(new URL('./jellyfin-browser.mjs', import.meta.url)),
  helperSha256: await sha256(new URL('./helpers/jellyfin-fixtures.mjs', import.meta.url)),
  headless: process.env.UBVE_JELLYFIN_HEADED !== '1', gpuDisabledFlag: process.env.UBVE_JELLYFIN_NO_GPU === '1',
  explicitExecutable: Boolean(process.env.UBVE_CHROMIUM), inputPath: 'previously hashed/probed OS-local File; no network fetch, not cold-cache', sampleMediaSeconds: span };

const write = async (name, value) => writeFile(path.join(runDir, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
const elapsed = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
const diagnosticCode = value => value?.snapshot?.error?.code ?? null;
const message = error => error instanceof Error ? error.message : String(error);
const bool = condition => condition === true;
const canonicalVideoCodec = codec => ({ avc: 'h264', 'h.264': 'h264', h265: 'hevc', 'h.265': 'hevc' })[codec] ?? codec;

function installBrowserReceipt() {
  const video = document.querySelector('video');
  const input = document.querySelector('input[type=file]');
  const transport = document.querySelector('.transport-play');
  const slider = document.querySelector('#seek-position');
  if (!video || !input || !transport || !slider) throw new Error('Player controls are missing');
  const receipt = { times: {}, events: [], frames: [], file: null, phase: 'opening', error: null, frameDropOverflow: false,
    environment: { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, requestVideoFrameCallback: typeof video.requestVideoFrameCallback === 'function' } };
  const mark = key => { receipt.times[key] ??= performance.now(); };
  const quality = () => typeof video.getVideoPlaybackQuality === 'function' ? (() => {
    const { totalVideoFrames, droppedVideoFrames, corruptedVideoFrames } = video.getVideoPlaybackQuality();
    return { totalVideoFrames, droppedVideoFrames, corruptedVideoFrames: corruptedVideoFrames ?? null };
  })() : null;
  const state = () => ({ label: document.querySelector('.session-state')?.textContent.trim() ?? null,
    route: document.querySelector('.stage-label')?.textContent.trim() ?? null, problem: document.querySelector('.stage-error p')?.textContent.trim() ?? null,
    alert: document.querySelector('[role=alert] p')?.textContent.trim() ?? null, readyState: video.readyState, networkState: video.networkState,
    hasSrcAttribute: video.hasAttribute('src'), sourceObjectAttached: video.srcObject !== null,
    queueCount: document.querySelector('.queue-panel .count')?.textContent.trim() ?? null, paused: video.paused, seeking: video.seeking,
    ended: video.ended, currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null, width: video.videoWidth, height: video.videoHeight,
    muted: video.muted, playbackRate: video.playbackRate, sourceKind: video.currentSrc.startsWith('blob:') ? 'blob' : (video.currentSrc ? 'non-blob' : null), quality: quality() });
  input.addEventListener('change', () => {
    if (input.files?.[0]) {
      mark('fileChange'); const file = input.files[0];
      receipt.file = { name: file.name, bytes: file.size, mimeType: file.type || null };
    }
  }, { capture: true });
  transport.addEventListener('click', () => {
    if (receipt.phase === 'opening') {
      receipt.phase = 'firstPlay'; mark('playClick'); receipt.startQuality = quality();
    } else if (receipt.phase === 'firstPlay') {
      receipt.phase = 'firstPause'; mark('pauseClick'); receipt.endQuality = quality();
    } else if (receipt.phase === 'pausedSeek') {
      receipt.phase = 'resumed'; mark('resumeClick');
    } else if (receipt.phase === 'resumed') {
      receipt.phase = 'finished'; mark('finalPauseClick');
    }
  }, { capture: true });
  slider.addEventListener('change', () => { receipt.phase = 'pausedSeek'; mark('sliderChange'); }, { capture: true });
  for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'ended', 'error']) {
    video.addEventListener(type, () => {
      if (receipt.events.length < 256) receipt.events.push({ type, phase: receipt.phase, at: performance.now(), mediaTime: video.currentTime, readyState: video.readyState });
      if (receipt.phase === 'opening' && ['loadedmetadata', 'loadeddata', 'canplay'].includes(type)) mark(type);
      if (type === 'playing' && receipt.phase === 'firstPlay') mark('firstPlaying');
      if (type === 'seeked' && receipt.phase === 'pausedSeek') mark('seeked');
      if (type === 'error' && video.error) receipt.error ??= { code: video.error.code, message: video.error.message || null };
    });
  }
  for (const [event, target] of [['visibilitychange', document], ['focus', window], ['blur', window]]) {
    target.addEventListener(event, () => {
      if (receipt.events.length < 256) receipt.events.push({ type: event, phase: receipt.phase, at: performance.now(), visibility: document.visibilityState, focus: document.hasFocus() });
    });
  }
  const watch = new MutationObserver(() => {
    if (document.querySelector('.session-state')?.textContent.trim() === 'Ready') mark('readyLabel');
  });
  const stateLabel = document.querySelector('.session-state');
  if (stateLabel) watch.observe(stateLabel, { childList: true, characterData: true, subtree: true });
  if (typeof video.requestVideoFrameCallback === 'function') {
    const frame = (now, metadata) => {
      if (receipt.phase === 'firstPlay' || receipt.phase === 'pausedSeek' || receipt.phase === 'resumed') {
        if (receipt.frames.length < 2048) receipt.frames.push({ phase: receipt.phase, at: now, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
          expectedDisplayTime: metadata.expectedDisplayTime, processingDurationSeconds: metadata.processingDuration ?? null, width: metadata.width, height: metadata.height });
        else receipt.frameDropOverflow = true;
      }
      if (receipt.phase === 'firstPlay') mark('firstPlayFrame');
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  }
  window.__ubveJellyfin = { receipt, state };
}

const readPage = page => page.evaluate(() => ({ probe: window.__ubveJellyfin?.receipt ?? null,
  state: window.__ubveJellyfin?.state() ?? null, visibility: document.visibilityState, focus: document.hasFocus() }));
const waitPlayback = async (page, start, advance, deadline = 15_000) => {
  await page.waitForFunction(({ start, advance }) => {
    const probe = window.__ubveJellyfin, state = probe.state();
    return state.problem || (state.currentTime >= start + advance && (!state.paused || state.ended));
  }, { start, advance }, { timeout: deadline });
  const { state } = await readPage(page);
  assert.ok(!state.problem, state.problem ?? 'Playback failed');
  assert.ok(state.currentTime >= start + advance, 'Media clock did not advance to the observation boundary');
  return state;
};
const pause = async page => {
  await page.locator('.transport-play[aria-label="Pause"]').click();
  await page.waitForFunction(() => {
    const state = window.__ubveJellyfin.state(); return state.paused && state.label === 'Paused';
  }, null, { timeout: 8000 });
};

async function exportDiagnostics(page, filename) {
  const locator = page.locator('.export-button');
  if (!await locator.isVisible() || !await locator.isEnabled()) return null;
  const promise = page.waitForEvent('download', { timeout: 4000 });
  let download;
  try {
    [download] = await Promise.all([promise, locator.click({ timeout: 4000 })]);
    await download.saveAs(filename);
    return JSON.parse(await readFile(filename, 'utf8'));
  } finally {
    if (download) await download.delete().catch(() => {});
  }
}

const probeOneBlobByte = (page, url) => page.evaluate(async blobUrl => {
  try {
    const response = await fetch(blobUrl, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(1500) });
    const observation = { status: response.status, contentRange: response.headers.get('content-range') };
    await response.body?.cancel().catch(() => {});
    return observation;
  } catch (error) {
    return { errorName: error instanceof Error ? error.name : null };
  }
}, url);

function metrics(probe) {
  if (!probe) return null;
  const { times, events, frames, startQuality, endQuality } = probe;
  return { fileToLoadedMetadataMs: elapsed(times.fileChange, times.loadedmetadata), fileToReadyLabelMs: elapsed(times.fileChange, times.readyLabel),
    playClickToPlayingMs: elapsed(times.playClick, times.firstPlaying), playClickToFirstVideoFrameCallbackMs: elapsed(times.playClick, times.firstPlayFrame),
    sliderChangeToSeekedMs: elapsed(times.sliderChange, times.seeked),
    videoFrameCallbacksDuringFirstPlay: summarizeCadence(frames.filter(x => x.phase === 'firstPlay')),
    browserQualityCounterDeltaDuringFirstPlay: { total: elapsed(startQuality?.totalVideoFrames, endQuality?.totalVideoFrames),
      dropped: elapsed(startQuality?.droppedVideoFrames, endQuality?.droppedVideoFrames), corrupted: elapsed(startQuality?.corruptedVideoFrames, endQuality?.corruptedVideoFrames) },
    waitEventsDuringFirstPlay: events.filter(x => x.phase === 'firstPlay' && x.type === 'waiting').length,
    stalledEventsDuringFirstPlay: events.filter(x => x.phase === 'firstPlay' && x.type === 'stalled').length,
    visibilityOrFocusTransitions: events.filter(x => /visibilitychange|focus|blur/.test(x.type)).length };
}

let server, browser;
const work = await mkdtemp(path.join(tmpdir(), 'ubve-jellyfin-'));
const results = [];
try {
  assert.ok((await stat(path.join(dist, 'index.html'))).isFile(), 'Build the static app first');
  server = await preview({ configFile: path.join(root, 'apps/vue-player/vite.config.ts'), root: path.join(root, 'apps/vue-player'),
    build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ ...(process.env.UBVE_CHROMIUM ? { executablePath: process.env.UBVE_CHROMIUM } : {}),
    headless: host.headless, args: host.gpuDisabledFlag ? ['--disable-gpu'] : [] });
  host.browserVersion = browser.version();
  for (const fixture of cases) {
    const pageErrors = [], localPageFailures = [];
    const record = { schema: 'ubve-jellyfin-browser-case-v1', evidenceClass: profile, qualified: false, physicalOutputVerified: null, accelerationVerified: null,
      fixture, checks: [], status: 'STARTED', pageErrors, localPageFailures, metrics: null };
    let context, page, stage = 'file', active;
    try {
      const file = await localFixture(mediaRoot, fixture);
      record.fixtureIdentity = { bytes: file.bytes, sha256: file.sha256 };
      stage = 'ffprobe';
      record.independentSource = await probeFile(file.filename, file.bytes);
      if (fixture.expectedVideoCodec) assert.equal(record.independentSource.video.codec, fixture.expectedVideoCodec);
      record.checks.push('mirror file hash and independent FFprobe stream admission');
      stage = 'browser-navigation';
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', acceptDownloads: true });
      page = await context.newPage();
      page.setDefaultTimeout(18_000);
      page.on('pageerror', error => pageErrors.push(message(error)));
      page.on('requestfailed', request => { if (request.url().startsWith(origin)) localPageFailures.push({ url: new URL(request.url()).pathname, reason: request.failure()?.errorText ?? null }); });
      await page.goto(origin);
      await page.locator('input[type=file]').first().waitFor({ state: 'attached' });
      await page.evaluate(installBrowserReceipt);
      stage = 'open';
      await page.locator('input[type=file]').first().setInputFiles(file.filename, { timeout: 20_000 });
      await page.waitForFunction(() => {
        const state = window.__ubveJellyfin.state(); return state.label === 'Ready' || state.label === 'Playback issue' || state.problem;
      }, null, { timeout: 18_000 });
      const opened = await readPage(page);
      record.open = opened.state;
      assert.equal(opened.probe.file?.bytes, file.bytes, 'Browser File size differs from hashed file');
      assert.equal(opened.probe.file?.name, path.basename(file.filename), 'Browser File name differs');
      if (opened.state.problem) throw new Error(opened.state.problem);
      stage = 'metadata-assertions';
      assert.match(opened.state.route ?? '', /^N0\b/, 'Automatic local file should use the native N0 route');
      assert.equal(opened.state.sourceKind, 'blob');
      assert.equal(opened.state.paused, true, 'Local open must not autoplay');
      assert.equal(opened.state.playbackRate, 1);
      assert.equal(opened.state.width, record.independentSource.video.width, 'Displayed width disagrees with FFprobe');
      assert.equal(opened.state.height, record.independentSource.video.height, 'Displayed height disagrees with FFprobe');
      assert.ok(opened.state.duration > 0 && Math.abs(opened.state.duration - record.independentSource.duration) <= .1,
        `Browser duration ${opened.state.duration} disagrees with FFprobe ${record.independentSource.duration}`);
      record.checks.push('visible native route, local blob, no autoplay, display dimensions and duration');
      stage = 'first-play';
      await page.getByRole('button', { name: 'Mute', exact: true }).click();
      await page.locator('.transport-play[aria-label="Play"]').click();
      const advanced = await waitPlayback(page, opened.state.currentTime, Math.min(span, opened.state.duration / 4));
      assert.equal(advanced.muted, true);
      await pause(page);
      record.checks.push('unpaused user-initiated playback advances the media clock and can pause');
      stage = 'paused-seek';
      const beforeSeek = (await readPage(page)).state.currentTime;
      const target = opened.state.duration * (beforeSeek > opened.state.duration * .45 ? .2 : .6);
      await page.locator('#seek-position').evaluate((slider, seekTarget) => {
        if (slider.disabled) throw new Error('Source did not expose a seekable duration');
        slider.value = String(seekTarget);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }, target);
      await page.waitForFunction(target => {
        const probe = window.__ubveJellyfin, state = probe.state();
        return state.problem || (Boolean(probe.receipt.times.seeked) && state.paused && !state.seeking && Math.abs(state.currentTime - target) <= .1);
      }, target, { timeout: 12_000 });
      const sought = (await readPage(page)).state;
      assert.ok(!sought.problem, sought.problem ?? 'Paused seek failed');
      assert.equal(sought.paused, true);
      assert.ok(Math.abs(sought.currentTime - target) <= .1);
      record.pausedSeek = { beforeSeconds: beforeSeek, requestedSeconds: target, observedSeconds: sought.currentTime };
      record.checks.push('paused seek reaches requested time with actual native seeked event');
      stage = 'resume';
      await page.locator('.transport-play[aria-label="Play"]').click();
      await waitPlayback(page, sought.currentTime, Math.min(.25, opened.state.duration / 10));
      await pause(page);
      record.checks.push('user-initiated resume advances after the seek');
      active = await readPage(page);
      assert.ok(!active.probe.environment.requestVideoFrameCallback || active.probe.frames.some(x => x.phase === 'firstPlay'), 'Clock advanced but no native video frame callback was observed');
      stage = 'export-diagnostics';
      record.diagnostics = await exportDiagnostics(page, path.join(work, `${fixture.id}.json`));
      const sdk = record.diagnostics?.snapshot;
      assert.equal(sdk?.route, 'N0', 'Player diagnostics do not identify the native route');
      assert.equal(sdk.source?.bytes, file.bytes, 'Player diagnostics report different source bytes');
      assert.ok(sdk.tracks.some(track => track.kind === 'video' && canonicalVideoCodec(track.codec) === record.independentSource.video.codec),
        'Player diagnostics disagree with the independently probed video codec');
      record.checks.push('public diagnostics agree with independent video codec and source file bytes');
      stage = 'close';
      const formerBlobUrl = await page.locator('video').evaluate(video => video.currentSrc);
      assert.match(formerBlobUrl, /^blob:/, 'Expected the active native blob URL before close');
      const beforeClose = await probeOneBlobByte(page, formerBlobUrl);
      assert.deepEqual(beforeClose, { status: 206, contentRange: `bytes 0-0/${file.bytes}` }, 'Active local blob did not resolve the exact one-byte range');
      await page.getByRole('button', { name: 'Clear queue', exact: true }).click();
      await page.waitForFunction(() => {
        const state = window.__ubveJellyfin.state();
        // Chromium may retain the previous currentSrc string after detach/revoke.
        return state.label === 'No source' && state.queueCount === '0' && state.route === null &&
          !state.hasSrcAttribute && !state.sourceObjectAttached && state.readyState === 0 && state.paused;
      }, null, { timeout: 8000 });
      const afterClose = await probeOneBlobByte(page, formerBlobUrl);
      record.closed = { element: (await readPage(page)).state, formerBlobRangeBeforeClose: beforeClose, formerBlobRangeAfterClose: afterClose };
      assert.equal(afterClose.errorName, 'TypeError', 'Former blob URL still resolves or its revocation was not established');
      record.checks.push('clear detaches the media element, retires its queue entry and revokes the local blob URL');
      assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
      record.status = 'FUNCTIONAL_PLAYBACK';
    } catch (error) {
      record.failedStage = stage;
      record.failure = message(error);
      if (page) active = await readPage(page).catch(() => active ?? null);
      if (stage === 'open' && page && active?.state?.problem) {
        record.diagnostics = await exportDiagnostics(page, path.join(work, `${fixture.id}.json`)).catch(() => null);
      }
      record.status = stage === 'file' ? (error?.code === 'ENOENT' ? 'FIXTURE_MISSING' : 'FIXTURE_INTEGRITY_FAILED') : stage === 'ffprobe' ? 'FIXTURE_PROBE_FAILED' :
        active?.state?.problem ? classifyOpenFailure(stage, diagnosticCode(record.diagnostics), active.probe?.error?.code, active.state.problem) : 'PLAYBACK_FAILED';
      if (record.status === 'EXPLICIT_UNSUPPORTED_REFUSAL' && pageErrors.length) record.status = 'PLAYBACK_FAILED';
    } finally {
      const browserState = active ?? (page ? await readPage(page).catch(() => null) : null);
      record.browserObservation = browserState;
      record.metrics = metrics(browserState?.probe);
      record.expectationMet = caseSatisfiesExpectation(record.status, fixture.expect);
      await write(`case-${fixture.id}`, record);
      results.push({ id: fixture.id, status: record.status, expectationMet: record.expectationMet, failedStage: record.failedStage ?? null,
        reason: record.failure ?? null, evidence: `case-${fixture.id}.json` });
      await context?.close().catch(() => {});
      console.log(`${fixture.id} ${record.status}${record.expectationMet ? '' : ' (does not meet expectation)'}`);
    }
  }
} catch (error) {
  await write('runner-failure', { schema: 'ubve-jellyfin-browser-runner-failure-v1', evidenceClass: profile, qualified: false, host, results, error: message(error) });
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(work, { recursive: true, force: true });
}
const passes = results.filter(row => bool(row.expectationMet)).length;
await write('cohort', { schema: 'ubve-jellyfin-browser-cohort-v1', evidenceClass: profile, qualification: 'NOT_QUALIFIED', host, results,
  expectationsMet: passes, expectationFailures: results.length - passes, scope: 'Muted headless/browser functional smoke, no audio, HDR/Dolby Vision, scanout, sustained cadence, decoder capacity or HW claim' });
console.log(`Case receipts ${runDir}. Expectations met ${passes}/${results.length}. No qualification claim.`);
if (passes !== results.length) process.exitCode = 1;
