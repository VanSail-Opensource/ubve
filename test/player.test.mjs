import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferencePlayer, prepareDirectPlayback } from '../packages/browser/src/player.ts';

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
