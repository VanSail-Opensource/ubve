import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferencePlayer, describeInput, mediaElementError, prepareDirectPlayback } from '../packages/browser/src/player.ts';
import { PacketStage } from '../packages/browser/src/packet-stage.ts';
import { managedGpuOptions } from '../packages/browser/src/gpu-admission.ts';

// These are DOM-transport state-machine tests, not native decode or presentation evidence.
class MediaHost extends EventTarget {
  src = ''; playsInline = false; preload = ''; readyState = 0; duration = 8;
  videoWidth = 320; videoHeight = 180; volume = 1; muted = false; playbackRate = 1;
  paused = true; seeking = false; error = null; current = 0;
  buffered = { length: 0, start() { return 0; }, end() { return 0; } };
  get currentTime() { return this.current; }
  set currentTime(value) {
    this.current = value; this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() { if (!this.src) this.readyState = 0; }
}

const file = name => new File([new Uint8Array([1, 2, 3])], name, { type: 'video/webm' });
function prepared(stats, label = 'route') {
  let disposed = false;
  return {
    route: 'N0', description: label, tracks: [],
    async attach(video, signal) { assert.equal(signal.aborted, false); stats.attached++; video.src = label; video.readyState = 1; video.dispatchEvent(new Event('loadedmetadata')); },
    async dispose() { if (!disposed) { disposed = true; stats.disposed++; } },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native quality counts do not report dropped pictures as delivered', async () => {
  const host = new MediaHost();
  host.getVideoPlaybackQuality = () => ({ totalVideoFrames: 12, droppedVideoFrames: 4 });
  const player = new ReferencePlayer({ video: host, prepare: async () => prepared({ attached: 0, disposed: 0 }) });
  try {
    const ready = await player.open(file('counts.webm'));
    assert.equal(ready.telemetry.presentedFrames, 8);
    assert.equal(ready.telemetry.droppedFrames, 4);
  } finally { await player.dispose(); }
});

test('native observation samples the cumulative compositor counter and cancels a pending sampling timer', async context => {
  const host = new MediaHost();
  let scheduleCount = 0, observer;
  host.requestVideoFrameCallback = callback => { observer = callback; return ++scheduleCount; };
  host.cancelVideoFrameCallback = () => { observer = undefined; };
  const player = new ReferencePlayer({ video: host, prepare: async () => prepared({ attached: 0, disposed: 0 }) });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await player.open(file('sample.webm'));
    observer(0, { presentedFrames: 1 });
    assert.equal(scheduleCount, 1);
    context.mock.timers.tick(249); assert.equal(scheduleCount, 1);
    context.mock.timers.tick(1); assert.equal(scheduleCount, 2);
    observer(1_000, { presentedFrames: 61, processingDuration: 0.002 });
    assert.equal(player.snapshot().telemetry.presentedFrames, 61);
    assert.equal(player.snapshot().telemetry.callbackRate, 60);
    assert.equal(player.snapshot().telemetry.processingMs, 2);
    assert.equal(player.diagnostics().native.frameObservationSamples, 2);
    await player.close(); context.mock.timers.tick(250);
    assert.equal(scheduleCount, 2);
    assert.equal(player.diagnostics().native, null);
  } finally { await player.dispose(); }
});

test('finite native play acknowledgement leaves the source paused and retryable', async context => {
  const host = new MediaHost();
  let finishStart;
  host.play = () => { host.paused = false; return new Promise(resolve => { finishStart = resolve; }); };
  const player = new ReferencePlayer({ video: host, prepare: async () => prepared({ attached: 0, disposed: 0 }) });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await player.open(file('stall.webm'));
    const failed = assert.rejects(player.play(), { code: 'DEADLINE_EXCEEDED' });
    context.mock.timers.tick(15_000);
    await failed;
    assert.equal(host.paused, true);
    assert.equal(player.snapshot().state, 'paused');
    assert.equal(player.snapshot().wantsPlayback, false);
    finishStart();
    host.play = MediaHost.prototype.play.bind(host);
    await player.play();
    assert.equal(player.snapshot().state, 'playing');
  } finally { finishStart?.(); await player.dispose(); }
});

test('native network failures are not reported as codec incompatibility', () => {
  const host = new MediaHost(); host.error = { code: 2, message: 'test interruption' };
  assert.equal(mediaElementError(host).code, 'NETWORK');
  host.error = { code: 4, message: '' };
  assert.equal(mediaElementError(host).code, 'UNSUPPORTED_CODEC');
});

test('open prepares without autoplay, snapshots stay serializable, and close disposes its owner', async () => {
  const stats = { attached: 0, disposed: 0 };
  const host = new MediaHost();
  const player = new ReferencePlayer({ video: host, prepare: async () => prepared(stats) });
  try {
    const ready = await player.open(file('one.webm'));
    assert.equal(ready.state, 'ready'); assert.equal(host.paused, true);
    assert.equal(ready.gate, 'NOT_QUALIFIED'); assert.equal(ready.telemetry.hdrOutput, 'unverified');
    assert.doesNotThrow(() => JSON.stringify(ready));
    await player.play(); assert.equal(player.snapshot().state, 'playing');
    await player.pause(); assert.equal(player.snapshot().state, 'paused');
    await player.close(); assert.equal(stats.disposed, 1); assert.equal(host.src, '');
    assert.equal(player.snapshot().state, 'empty');
  } finally { await player.dispose(); }
});

test('a superseding open aborts and disposes the old preparation before attaching a new source', async () => {
  const stats = { attached: 0, disposed: 0 }, trace = [];
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let firstSignal;
  const player = new ReferencePlayer({ video: new MediaHost(), prepare: async (input, signal) => {
    if (input.name === 'first.webm') { firstSignal = signal; trace.push('first-start'); await hold; trace.push('first-release'); }
    const value = prepared(stats, input.name);
    return { ...value, async dispose() { trace.push(`${input.name}-dispose`); await value.dispose(); } };
  } });
  try {
    const first = player.open(file('first.webm')); const firstRejected = assert.rejects(first, { name: 'AbortError' });
    await tick();
    const second = player.open(file('second.webm'));
    await tick(); assert.equal(firstSignal.aborted, true); assert.equal(stats.attached, 0);
    release(); await firstRejected; await second;
    assert.equal(stats.attached, 1); assert.equal(stats.disposed, 1);
    assert.equal(player.snapshot().source.name, 'second.webm');
    assert.ok(trace.indexOf('first.webm-dispose') > trace.indexOf('first-release'));
  } finally { release(); await player.dispose(); }
});

test('dispose waits for a cancelled module preparation and is terminal', async () => {
  const stats = { attached: 0, disposed: 0 };
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const player = new ReferencePlayer({ video: new MediaHost(), prepare: async () => { await hold; return prepared(stats); } });
  const opening = player.open(file('late.webm')); const rejected = assert.rejects(opening, { name: 'AbortError' });
  await tick();
  let disposalCompleted = false;
  const disposal = player.dispose().then(() => { disposalCompleted = true; });
  await tick(); assert.equal(disposalCompleted, false);
  release(); await rejected; await disposal;
  assert.equal(stats.attached, 0); assert.equal(stats.disposed, 1);
  assert.equal(player.snapshot().state, 'disposed');
  await assert.rejects(player.open(file('after.webm')), /disposed/i);
});

test('rapid seeks cancel old intent and a pause during seek remains paused', async () => {
  const stats = { attached: 0, disposed: 0 };
  const player = new ReferencePlayer({ video: new MediaHost(), prepare: async () => prepared(stats) });
  try {
    await player.open(file('seek.webm')); await player.play();
    const first = player.seek(1); const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = player.seek(3); await player.pause();
    await rejected; await second;
    assert.equal(player.snapshot().time, 3); assert.equal(player.snapshot().state, 'paused');
  } finally { await player.dispose(); }
});

test('two hosts have independent source, playback, volume and disposal lifetimes', async () => {
  const left = new ReferencePlayer({ video: new MediaHost(), prepare: async () => prepared({ attached: 0, disposed: 0 }) });
  const right = new ReferencePlayer({ video: new MediaHost(), prepare: async () => prepared({ attached: 0, disposed: 0 }) });
  try {
    await Promise.all([left.open(file('left.webm')), right.open(file('right.webm'))]);
    await left.play(); right.setVolume(.4);
    assert.notEqual(left.snapshot().sessionId, right.snapshot().sessionId);
    assert.equal(left.snapshot().state, 'playing'); assert.equal(right.snapshot().state, 'ready');
    assert.equal(left.snapshot().volume, 1); assert.equal(right.snapshot().volume, .4);
    await left.dispose(); assert.equal(right.snapshot().source.name, 'right.webm');
  } finally { await Promise.all([left.dispose(), right.dispose()]); }
});

test('failed attach releases its owner and retains the first failure', async () => {
  let disposed = 0;
  const host = new MediaHost();
  const player = new ReferencePlayer({ video: host, prepare: async () => ({ route: 'N0', description: 'failed', tracks: [],
    async attach() { throw new Error('decoder initialization failed'); }, async dispose() { disposed++; },
  }) });
  try {
    await assert.rejects(player.open(file('bad.webm')), /decoder initialization failed/);
    assert.equal(disposed, 1); assert.equal(player.snapshot().state, 'failed');
    assert.equal(player.snapshot().error.message, 'decoder initialization failed'); assert.equal(host.src, '');
  } finally { await player.dispose(); }
});

test('direct local-source owner revokes its actual object URL', async () => {
  const controller = new AbortController(), host = new MediaHost();
  const value = await prepareDirectPlayback(file('url.webm'), controller.signal);
  await value.attach(host, controller.signal);
  const url = host.src; assert.ok(url.startsWith('blob:'));
  assert.equal((await fetch(url)).status, 200);
  await value.dispose(); await value.dispose();
  await assert.rejects(fetch(url));
});

test('close racing a new open joins old cleanup without erasing the new source', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const stats = { attached: 0, disposed: 0 };
  const player = new ReferencePlayer({ video: new MediaHost(), prepare: async input => {
    const base = prepared(stats, input.name);
    return { ...base, async dispose() { if (input.name === 'old.webm') await hold; await base.dispose(); } };
  } });
  try {
    await player.open(file('old.webm'));
    const close = player.close(), open = player.open(file('new.webm'));
    await tick(); assert.equal(stats.attached, 1);
    release(); await Promise.all([close, open]);
    assert.equal(player.snapshot().state, 'ready'); assert.equal(player.snapshot().source.name, 'new.webm');
    assert.equal(stats.attached, 2); assert.equal(stats.disposed, 1);
  } finally { release(); await player.dispose(); }
});

test('repeated disposal returns the same completion barrier', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const stats = { attached: 0, disposed: 0 };
  const player = new ReferencePlayer({ video: new MediaHost(), prepare: async () => {
    const base = prepared(stats);
    return { ...base, async dispose() { await hold; await base.dispose(); } };
  } });
  await player.open(file('dispose.webm'));
  const first = player.dispose(), second = player.dispose();
  assert.equal(first, second);
  release(); await Promise.all([first, second]); assert.equal(stats.disposed, 1);
});

test('selected-track staging retains bounded capacity in flight and does not block the other track', () => {
  const video = new PacketStage(2, 6), audio = new PacketStage(2, 4);
  const released = [];
  video.enqueue('v0', 4, () => released.push('v0'));
  video.enqueue('v1', 2, () => released.push('v1'));
  const held = video.take();
  assert.equal(held.value, 'v0');
  assert.equal(video.canEnqueue(1), false);
  assert.equal(video.snapshot().bytes, 6);
  assert.equal(audio.canEnqueue(4), true);
  audio.enqueue('a0', 4, () => released.push('a0'));
  assert.throws(() => video.canEnqueue(7), { code: 'ITEM_TOO_LARGE' });
  assert.throws(() => video.enqueue('overflow', 1, () => released.push('overflow')), { code: 'BACKPRESSURE' });
  held.release(); held.release();
  assert.equal(video.canEnqueue(4), true);
  video.clear(); audio.clear();
  assert.deepEqual(released, ['v0', 'v1', 'a0']);
  assert.equal(video.snapshot().items, 0); assert.equal(audio.snapshot().items, 0);
});

test('superseded prepared seek is cancelled and fully settles before the latest seek mutates the host', async () => {
  const trace = [];
  const player = new ReferencePlayer({ video: new MediaHost(), prepare: async () => ({ ...prepared({ attached: 0, disposed: 0 }),
    async seek(time, signal) {
      trace.push(['start', time]);
      if (time === 1) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      trace.push(['settle', time, signal.aborted]);
    },
  }) });
  try {
    await player.open(file('native.mkv')); await player.play();
    const first = player.seek(1), rejected = assert.rejects(first, { name: 'AbortError' });
    await tick();
    const second = player.seek(2); await player.pause();
    await Promise.all([rejected, second]);
    assert.deepEqual(trace, [['start', 1], ['settle', 1, true], ['start', 2], ['settle', 2, false]]);
    assert.equal(player.snapshot().state, 'paused'); assert.equal(player.snapshot().time, 2);
  } finally { await player.dispose(); }
});

test('native seek-to-end stays ended rather than restarting a previously playing source', async () => {
  const host = new MediaHost();
  const player = new ReferencePlayer({ video: host, prepare: async () => prepared({ attached: 0, disposed: 0 }) });
  try {
    await player.open(file('end.webm')); await player.play(); await player.seek(8);
    assert.equal(player.snapshot().state, 'ended'); assert.equal(player.snapshot().time, 8);
    assert.equal(player.snapshot().wantsPlayback, false); assert.equal(host.paused, true);
  } finally { await player.dispose(); }
});

test('stale managed pause completion cannot pause or rewrite a replacement native source', async () => {
  const host = new MediaHost(), stats = { attached: 0, disposed: 0 };
  let releasePause;
  const managed = { snapshot: () => ({ state: 'playing', duration: 8, time: 0, transforms: [], telemetry: {} }),
    async pause() { return new Promise(resolve => { releasePause = resolve; }); }, async play() {}, setVolume() {}, setQuality() {} };
  const player = new ReferencePlayer({ video: host, prepare: async input => input.name === 'managed.mkv'
    ? { ...prepared(stats), route: 'C1', driver: managed } : prepared(stats) });
  try {
    await player.open(file('managed.mkv'));
    const pause = player.pause(); await tick();
    await player.open(file('replacement.webm')); await player.play();
    releasePause(); await pause;
    assert.equal(host.paused, false); assert.equal(player.snapshot().state, 'playing');
  } finally { releasePause?.(); await player.dispose(); }
});

test('embedded subtitle identity survives opening and differs from an external sidecar', async () => {
  const host = new MediaHost(), seen = [];
  const player = new ReferencePlayer({ video: host, prepare: async () => ({ ...prepared({ attached: 0, disposed: 0 }),
    selectedSubtitle: 'stream-2', subtitleLabel: 'Embedded ASS', setSubtitleEnabled: value => seen.push(value),
  }), subtitles: { async load() {}, setQuality() {}, setOffset() {}, async clear() {}, getStatus: () => ({ requiresOverlay: true }), async dispose() {} } });
  try {
    await player.open(file('subbed.mkv'));
    assert.equal(player.snapshot().selectedSubtitle, 'stream-2');
    await player.loadSubtitle(new File(['WEBVTT'], 'sidecar.vtt'));
    assert.equal(player.snapshot().selectedSubtitle, 'external');
    await player.clearSubtitle();
    assert.equal(player.snapshot().selectedSubtitle, null); assert.deepEqual(seen, [false, false]);
  } finally { await player.dispose(); }
});

test('malformed escape sequences do not make a valid media URL unopenable', () => {
  assert.equal(describeInput({ url: 'https://example.test/%E0%A4%A.webm' }).name, '%E0%A4%A.webm');
  assert.equal(describeInput({ url: 'https://example.test/space%20movie.webm' }).name, 'space movie.webm');
});

test('managed atomic AV1 refuses a standard document before parsing or mounting media', async () => {
  const { preparePlayback } = await import('../packages/browser/dist/index.js');
  assert.notEqual(globalThis.crossOriginIsolated, true);
  await assert.rejects(preparePlayback(file('unreadable.mkv'), new MediaHost(), new AbortController().signal, 'managed'), {
    code: 'UNSUPPORTED_PROFILE', message: /Open the isolated player/,
  });
});

test('managed WebGPU distinguishes a full HDR candidate from an explicit SDR transform', () => {
  const known = value => ({ state: 'known', value, origin: 'decoder' });
  const unknown = { state: 'unknown', reason: 'missing from signal' };
  const xy = (x, y) => ({ x: { numerator: BigInt(x), denominator: 50000n }, y: { numerator: BigInt(y), denominator: 50000n } });
  const mastering = { red: xy(34000, 16000), green: xy(13250, 34500), blue: xy(7500, 3000), white: xy(15635, 16450),
    minimumLuminance: { numerator: 1n, denominator: 10000n }, maximumLuminance: { numerator: 1000n, denominator: 1n } };
  const frame = { kind: 'video', format: 'I420P10', data: new Uint8Array(12), color: { primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020-ncl', range: 'limited' },
    signalMetadata: { epoch: 0, bitDepth: known(10), chromaSubsampling: known('420'), primaries: known('bt2020'), transfer: known('smpte2084'), matrix: known('bt2020-ncl'), range: known('limited'),
      chromaLocation: known('top-left'), masteringDisplay: known(mastering), contentLightLevel: known({ maximumContentLightLevel: 1000, maximumFrameAverageLightLevel: 400 }) } };
  assert.deepEqual(managedGpuOptions(frame, 'full'), { output: 'hdr-candidate', referenceWhiteNits: 203, allowSdrToneMap: false, chromaLocation: 'topleft' });
  const noCll = { ...frame, signalMetadata: { ...frame.signalMetadata, contentLightLevel: unknown } };
  assert.throws(() => managedGpuOptions(noCll, 'full'), /contentLightLevel.*unknown/);
  assert.deepEqual(managedGpuOptions(noCll, 'performance'), { output: 'sdr', referenceWhiteNits: 203, allowSdrToneMap: true, maximumHeight: 720, chromaLocation: 'topleft' });
  assert.throws(() => managedGpuOptions({ ...frame, signalMetadata: { ...frame.signalMetadata, chromaLocation: unknown } }, 'performance'), /Chroma siting/);
  assert.throws(() => managedGpuOptions({ ...frame, color: { ...frame.color, range: 'full' } }, 'full'), /range disagree/);
  assert.throws(() => managedGpuOptions({ ...frame, data: new Uint8Array(new SharedArrayBuffer(12)) }, 'full'), /non-shared/);
});
