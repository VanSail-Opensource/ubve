import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmOutput } from '../packages/presentation/dist/index.js';

function defer() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mockGraph(t, { resume = Promise.resolve(), initialStartsRejected = 0 } = {}) {
  const controls = [];
  const firstResume = defer(), firstStart = defer();
  let graph;
  class Context {
    currentTime = 0;
    state = 'suspended';
    audioWorklet = { addModule: async () => {} };
    destination = { maxChannelCount: 8 };
    constructor({ sampleRate }) { this.sampleRate = sampleRate; }
    createGain() { return { connect() {}, disconnect() {}, gain: { setTargetAtTime() {} } }; }
    async resume() { firstResume.resolve(); await resume; this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  class Node {
    constructor(_context, _name, { processorOptions: config }) {
      let epoch = config.epoch, primed = 0, first = config.firstMediaSample, starts = 0;
      let producer;
      const send = (type, requestId, reason) => this.port.onmessage?.({ data: {
        type, reason, requestId, epoch, graphFrame: 0, nextMediaSample: first,
        snapshot: { epoch, queuedFrames: primed, nextMediaSample: first, finalMediaSample: null },
      } });
      this.port = {
        postMessage: msg => queueMicrotask(() => {
          controls.push(msg);
          if (msg.type === 'bind') {
            producer = msg.port;
            producer.onmessage = event => { primed += event.data.frames; send('queued'); };
            producer.start(); send('bound', msg.requestId);
          } else if (msg.type === 'pause') send('paused', msg.requestId);
          else if (msg.type === 'reset') { epoch = msg.epoch; first = msg.firstMediaSample; primed = 0; send('reset', msg.requestId); }
          else if (msg.type === 'start') {
            firstStart.resolve();
            if (starts++ < initialStartsRejected) send('control-rejected', msg.requestId, 'LATE_ANCHOR');
            else send('started', msg.requestId);
          } else if (msg.type === 'dispose') { producer.close(); send('disposed', msg.requestId); }
        }),
        close() {},
      };
      graph = this;
    }
    connect() {}
    disconnect() {}
  }
  const contextBefore = globalThis.AudioContext, nodeBefore = globalThis.AudioWorkletNode;
  globalThis.AudioContext = Context; globalThis.AudioWorkletNode = Node;
  t.after(() => { globalThis.AudioContext = contextBefore; globalThis.AudioWorkletNode = nodeBefore; });
  return { controls, firstResume: firstResume.promise, firstStart: firstStart.promise, processorError: () => graph.onprocessorerror() };
}

const create = (options = {}) => PcmOutput.create({ sampleRate: 48000, channelLabels: ['FL', 'FR'], blockFrames: 256, poolBlocks: 2, primeMs: 4, ...options });
const block = new Float32Array(512);

test('pause cancels a start awaiting AudioContext.resume before the graph can receive it', async t => {
  const resumed = defer(); const graph = mockGraph(t, { resume: resumed.promise });
  const pcm = await create(); t.after(() => pcm.dispose());
  const playback = pcm.start(); await graph.firstResume;
  assert.equal(pcm.start(), playback, 'duplicate callers share one start');
  const rejected = assert.rejects(playback, { name: 'AbortError' });
  assert.equal(await pcm.pause(), 0n); await rejected;
  resumed.resolve(); await Promise.resolve();
  assert.equal(graph.controls.filter(control => control.type === 'start').length, 0);
  assert.equal(pcm.tryWrite(block, 0n), true);
  assert.equal((await pcm.start()).type, 'started');
  assert.equal(graph.controls.filter(control => control.type === 'start').length, 1);
});

test('reset cancels a priming start, prevents overlapping epochs and accepts the new exact sample', async t => {
  const graph = mockGraph(t); const pcm = await create(); t.after(() => pcm.dispose());
  const playback = pcm.start(); await graph.firstResume; await Promise.resolve();
  const rejected = assert.rejects(playback, { name: 'AbortError' });
  const reset = pcm.reset(77n);
  const overlapping = assert.rejects(pcm.reset(88n), /resetting/);
  assert.throws(() => pcm.tryWrite(block, 0n), /resetting/);
  await reset; await rejected; await overlapping;
  assert.equal(pcm.epoch, 1); assert.equal(pcm.nextWrittenSample, 77n);
  assert.equal(pcm.tryWrite(block, 77n), true);
  const started = await pcm.start();
  assert.equal(started.epoch, 1); assert.equal(started.nextMediaSample, 77);
  assert.equal(graph.controls.filter(control => control.type === 'start').length, 1);
});

test('a graph-rejected late anchor retries once, and repeated misses stay visible', async t => {
  const graph = mockGraph(t, { initialStartsRejected: 3 });
  const pcm = await create(); t.after(() => pcm.dispose());
  assert.equal(pcm.tryWrite(block, 0n), true);
  await assert.rejects(pcm.start(), /LATE_ANCHOR/);
  assert.equal(graph.controls.filter(control => control.type === 'start').length, 2);
  assert.equal((await pcm.start()).type, 'started');
  assert.equal(graph.controls.filter(control => control.type === 'start').length, 4);
});

test('processor failures interrupt capacity waiters, surface a terminal event, and dispose once', async t => {
  const graph = mockGraph(t); const events = [];
  const pcm = await create({ onEvent: event => events.push(event) });
  assert.equal(pcm.tryWrite(block, 0n), true); assert.equal(pcm.tryWrite(block, 256n), true);
  const waiting = assert.rejects(pcm.waitForCapacity(), /AudioWorklet processor failed/);
  graph.processorError(); await waiting;
  assert.equal(pcm.snapshot.state, 'failed');
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  await assert.rejects(pcm.start(), /AudioWorklet processor failed/);
  const disposal = pcm.dispose();
  assert.equal(pcm.dispose(), disposal); await disposal;
  assert.equal(graph.controls.filter(control => control.type === 'dispose').length, 1);
  assert.equal(pcm.context.state, 'closed');
});
