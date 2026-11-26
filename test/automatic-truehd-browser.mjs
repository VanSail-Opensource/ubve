import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const fixture = JSON.parse(await readFile(new URL('./fixtures/primary/manifest.json', import.meta.url), 'utf8'));
assert.equal(createHash('sha256').update(await readFile(fixture.path)).digest('hex'), fixture.sha256);
const playerUrl = process.env.UBVE_TRUEHD_PLAYER_URL;
const server = playerUrl ? null : await preview({ configFile: 'apps/vue-player/vite.config.ts', root: 'apps/vue-player',
  preview: { host: '127.0.0.1', port: 0, strictPort: true } });
const origin = playerUrl ? new URL(playerUrl).origin : `http://127.0.0.1:${server.httpServer.address().port}`;
const report = { origin, fixtureSha256: fixture.sha256, qualification: 'NOT_QUALIFIED', state: 'FAILED', checks: [], devices: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true, args: ['--disable-gpu'] });
  report.browser = browser.version();
  const page = await browser.newPage({ locale: 'en-US' });
  page.on('pageerror', error => report.errors.push(String(error)));
  // Narrow admission to stereo for a deterministic regression on multichannel
  // machines. Never advertise more channels than the real browser audio graph.
  await page.addInitScript(() => {
    const original = Object.getOwnPropertyDescriptor(AudioDestinationNode.prototype, 'maxChannelCount');
    window.realAudioCaps = [];
    Object.defineProperty(AudioDestinationNode.prototype, 'maxChannelCount', { ...original, get() {
      const count = original.get.call(this);
      window.realAudioCaps.push(count);
      return Math.min(2, count);
    } });
  });

  const route = page.locator('select').filter({ has: page.locator('option[value="automatic"]') });
  const stereo = page.getByRole('checkbox', { name: /Allow stereo output when needed/ });
  const media = page.getByLabel('Open media');
  const message = page.locator('.stage-error p');
  const waitState = async expected => {
    const hit = await page.waitForFunction(wanted => {
      const state = document.querySelector('.session-state')?.textContent.trim();
      return state === wanted || state === 'Playback issue' ? state : false;
    }, expected, { timeout: 45000 });
    assert.equal(await hit.jsonValue(), expected, (await message.allTextContents()).join(' '));
  };
  const verifyPlayback = async () => {
    await waitState('Ready');
    assert.equal(await route.inputValue(), 'automatic');
    await page.locator('.first-play button').click();
    await waitState('Ended');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export diagnostics' }).click()]);
    const { snapshot, pipeline } = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(snapshot.route, 'C1');
    assert.equal(snapshot.quality, 'performance');
    assert.equal(snapshot.requiresOverlay, true);
    const selected = snapshot.tracks.find(track => track.id === snapshot.selectedAudio && track.kind === 'audio');
    assert.equal(selected.codec, 'truehd');
    assert.equal(selected.channels, fixture.audio.channels);
    assert.match(snapshot.source.audio, /explicit stereo index fold-down/);
    assert.ok(snapshot.transforms.includes('Explicit channel-index stereo fold-down'));
    assert.equal(pipeline.managed.submittedVideoFrames, Number(fixture.video.nb_read_frames));
    assert.equal(pipeline.managed.audio.consumedFrames, fixture.audio.decoded_sample_frames);
    assert.equal(pipeline.managed.audio.underruns, 0);
    const caps = await page.evaluate(() => window.realAudioCaps);
    assert.ok(caps.length > 0 && caps.every(channels => channels >= 2));
    report.devices.push({ path: new URL(page.url()).pathname, realAudioCaps: caps, diagnostic: { snapshot, pipeline } });
  };

  await page.goto(origin + '/', { timeout: 20000 });
  assert.equal(await route.inputValue(), 'automatic');
  assert.equal(await stereo.isChecked(), false, 'Stereo needs explicit permission');
  await page.getByRole('button', { name: 'Performance', exact: true }).click();
  await media.setInputFiles(fixture.path);
  await waitState('Playback issue');
  assert.match(await message.innerText(), /supports 2 channels, but the track needs 6\..*stereo/i);
  report.checks.push('Automatic reaches managed output admission and refuses a silent downmix');

  await stereo.check();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await verifyPlayback();
  report.checks.push('Same local MKV retried in Automatic through real TrueHD PCM and played to EOS');

  await page.goto(origin + '/isolated/', { timeout: 20000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(await stereo.isChecked(), true, 'Explicit stereo permission survives navigation');
  await media.setInputFiles(fixture.path);
  await verifyPlayback();
  report.checks.push('Saved permission handles the next file automatically on the isolated document');

  await page.reload({ timeout: 20000 });
  assert.equal(await stereo.isChecked(), true);
  await route.selectOption('native');
  await media.setInputFiles(fixture.path);
  await waitState('Playback issue');
  assert.match(await message.innerText(), /TrueHD has no admitted native soundtrack path here/);
  report.checks.push('Explicit Native direct does not start software playback');
  assert.deepEqual(report.errors, []);
  report.state = 'PASSED';
  console.log(`Automatic TrueHD used C1 on both documents, retaining ${fixture.audio.channels} source channels and consuming ${fixture.audio.decoded_sample_frames} PCM sample frames with explicit stereo output.`);
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await mkdir('.local/automatic-truehd-browser', { recursive: true });
  await writeFile(`.local/automatic-truehd-browser/run-${Date.now()}-${process.pid}.json`, JSON.stringify(report, null, 2) + '\n');
}
