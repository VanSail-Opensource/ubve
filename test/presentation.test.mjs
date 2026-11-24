import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { pqToNits, nitsToPq, rawToRgba, validateRawFrame, signed24In32ToFloat, getPresentationEligibility, assessHdrOutput, RecoveryBudget }
  from '../packages/presentation/dist/index.js';

const { outputFiles } = await build({ entryPoints: ['packages/presentation/worklet/pcm-processor.ts'], bundle: true, write: false, format: 'iife', target: 'es2023' });
const processorSource = outputFiles[0].text;

function graph({ channels = 2, primeFrames = 256, firstMediaSample = 0 } = {}) {
  const events = [], releases = [];
  class Base { port = { onmessage: null, postMessage: value => events.push(value) }; }
  let Processor;
  const context = createContext({ AudioWorkletProcessor: Base, sampleRate: 48000, currentFrame: 0,
    ArrayBuffer, Float32Array, Number, Array, Set, Error, Math,
    registerProcessor: (_name, ctor) => { Processor = ctor; } });
  runInContext(processorSource, context);
  const config = { sampleRate: 48000, channels, channelLabels: channels === 2 ? ['FL', 'FR'] : ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
    blockFrames: 256, poolBlocks: 4, primeFrames, epoch: 0, firstMediaSample };
  const processor = new Processor({ processorOptions: config });
  const producer = { onmessage: null, start() {}, postMessage: value => releases.push(value) };
  processor.port.onmessage({ data: { type: 'bind', port: producer, requestId: 1 } });
  const control = data => processor.port.onmessage({ data });
  const block = (id, start, frames = 256, epoch = 0) => {
    const buffer = new ArrayBuffer(256 * channels * 4); const pcm = new Float32Array(buffer);
    for (let i = 0; i < frames; i++) for (let channel = 0; channel < channels; channel++) pcm[i * channels + channel] = (start + i + channel + 1) / 16384;
    producer.onmessage({ data: { type: 'block', id, epoch, startMediaSample: start, frames, channels, buffer } });
  };
  const tick = (frame, quantum = 128) => {
    context.currentFrame = frame;
    const outputs = Array.from({ length: channels }, () => new Float32Array(quantum));
    const alive = processor.process([], [outputs]);
    return { outputs, alive };
  };
  return { events, releases, processor, control, block, tick };
}

test('PCM consumes every channel and exact partial-quantum EOS', () => {
  const g = graph({ channels: 6, primeFrames: 256 });
  g.block(0, 0, 130);
  g.control({ type: 'eos', epoch: 0, finalMediaSample: 130, requestId: 2 });
  g.control({ type: 'start', epoch: 0, startGraphFrame: 16, requestId: 3 });
  assert.equal(g.events.some(e => e.type === 'started'), false);
  const a = g.tick(0).outputs, b = g.tick(128).outputs;
  for (let channel = 0; channel < 6; channel++) {
    for (let i = 0; i < 16; i++) assert.equal(a[channel][i], 0);
    for (let i = 0; i < 112; i++) assert.equal(a[channel][16 + i], (i + channel + 1) / 16384);
    for (let i = 0; i < 18; i++) assert.equal(b[channel][i], (112 + i + channel + 1) / 16384);
    for (let i = 18; i < 128; i++) assert.equal(b[channel][i], 0);
  }
  assert.equal(g.processor.nextSample, 130);
  assert.equal(g.processor.state, 'ended');
  assert.equal(g.processor.underruns, 0);
  assert.equal(g.releases.length, 1);
  assert.equal(g.events.find(e => e.type === 'started').graphFrame, 16);
  assert.equal(g.events.find(e => e.type === 'ended').graphFrame, 146);
});

test('PCM underrun latches at exact missing sample and late data cannot resume', () => {
  const g = graph();
  g.block(0, 0);
  g.control({ type: 'start', epoch: 0, startGraphFrame: 1, requestId: 2 });
  g.tick(0); g.tick(128); g.tick(256);
  assert.equal(g.processor.nextSample, 256);
  assert.equal(g.processor.state, 'starved');
  assert.equal(g.events.filter(e => e.type === 'underrun').length, 1);
  g.block(1, 256); g.tick(384); g.tick(512);
  assert.equal(g.processor.nextSample, 256);
  assert.equal(g.releases.at(-1).reason, 'NOT_ACCEPTING');
  g.control({ type: 'reset', epoch: 1, firstMediaSample: 256, requestId: 3 });
  g.block(2, 256, 256, 0);
  assert.equal(g.releases.at(-1).reason, 'STALE_EPOCH');
  g.block(3, 256, 256, 1);
  g.control({ type: 'start', epoch: 1, startGraphFrame: 600, requestId: 4 });
  g.tick(576);
  assert.equal(g.processor.nextSample, 360);
  assert.equal(g.processor.underruns, 1);
});

test('PCM pause freezes sample clock, reset returns buffers, disposal is terminal', () => {
  const g = graph();
  g.block(0, 0); g.block(1, 256);
  g.control({ type: 'start', epoch: 0, startGraphFrame: 1, requestId: 2 });
  g.tick(0);
  g.control({ type: 'pause', epoch: 0, requestId: 3 });
  g.tick(128); assert.equal(g.processor.nextSample, 127);
  g.control({ type: 'reset', epoch: 1, firstMediaSample: 500, requestId: 4 });
  assert.equal(g.releases.length, 2); assert.equal(g.processor.queued, 0);
  g.block(2, 500, 256, 1);
  g.control({ type: 'dispose', requestId: 5 });
  assert.equal(g.releases.length, 3); assert.equal(g.tick(256).alive, false);
  g.block(3, 756, 256, 1);
  assert.equal(g.processor.accepted, 3); assert.equal(g.releases.at(-1).reason, 'NOT_ACCEPTING');
});

test('PCM rejects discontinuity and enforces item cap without consuming input', () => {
  const g = graph();
  g.block(0, 1); assert.equal(g.processor.queued, 0);
  for (let i = 0; i < 4; i++) g.block(i + 1, i * 256);
  g.block(5, 1024);
  assert.equal(g.processor.queued, 1024);
  assert.equal(g.releases.at(-1).reason, 'CAPACITY');
  assert.equal(g.processor.snapshot().transportBytes, 4 * 256 * 2 * 4);
});

test('pause while start is scheduled cancels the waiter without consuming samples', () => {
  const g = graph(); g.block(0, 0);
  g.control({ type: 'start', epoch: 0, startGraphFrame: 1000, requestId: 8 });
  g.control({ type: 'pause', epoch: 0, requestId: 9 });
  const rejection = g.events.find(event => event.type === 'control-rejected' && event.requestId === 8);
  assert.equal(rejection.reason, 'START_CANCELLED');
  g.tick(1024); assert.equal(g.processor.nextSample, 0); assert.equal(g.processor.state, 'paused');
});

test('24-bit PCM normalization preserves every selected low-bit witness', () => {
  const values = Int32Array.from([-8388608, -8388607, -1, 0, 1, 8388607], x => x * 256);
  const output = new Float32Array(values.length);
  signed24In32ToFloat(values, output);
  assert.deepEqual(Array.from(output, x => x * 2147483648), Array.from(values));
  assert.throws(() => signed24In32ToFloat(Int32Array.of(1), new Float32Array(1)), /32-bit reduction/);
});

test('PQ reference matches ST2084 endpoints and nits round trips', () => {
  assert.ok(pqToNits(0) < 1e-8); assert.ok(Math.abs(pqToNits(1) - 10000) < 1e-6);
  for (const nits of [0.01, 0.1, 1, 100, 203, 1000, 4000, 10000]) assert.ok(Math.abs(pqToNits(nitsToPq(nits)) - nits) < 1e-6);
});

test('I420P10 uses little-endian low bits and refuses hidden HDR reduction', () => {
  const bytes = new Uint8Array(24); const view = new DataView(bytes.buffer);
  for (const at of [0, 2, 8, 10]) view.setUint16(at, 64, true);
  view.setUint16(16, 512, true); view.setUint16(20, 512, true);
  const frame = { format: 'I420P10', codedWidth: 2, codedHeight: 2, visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    planes: [{ offsetBytes: 0, strideBytes: 8, rows: 2 }, { offsetBytes: 16, strideBytes: 4, rows: 1 }, { offsetBytes: 20, strideBytes: 4, rows: 1 }], data: bytes,
    color: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', range: 'limited' } };
  assert.throws(() => rawToRgba(frame), /Full HDR/);
  const result = rawToRgba(frame, { allowSdrToneMap: true });
  assert.equal(result.transform, 'pq-bt2020-to-sdr');
  assert.deepEqual(Array.from(result.data), [0,0,0,255,0,0,0,255,0,0,0,255,0,0,0,255]);
  assert.throws(() => validateRawFrame({ ...frame, data: bytes.subarray(0, 21) }), /exceeds/);
});

test('output modes preserve required overlays and never admit unverified HDR', () => {
  assert.equal(getPresentationEligibility({ mode: 'video-pip', customSubtitles: true }).allowed, false);
  assert.equal(getPresentationEligibility({ mode: 'document-fullscreen', customSubtitles: true }).allowed, true);
  assert.equal(assessHdrOutput({ sourceIsHdr: true, route: 'canvas2d' }).output, 'refused');
  assert.equal(assessHdrOutput({ sourceIsHdr: false, route: 'canvas2d' }).output, 'sdr');
  assert.equal(assessHdrOutput({ sourceIsHdr: true, route: 'webgpu', acceptedExtendedCanvas: true }).qualification, 'DEFERRED_NOT_QUALIFIED');
  const recovery = new RecoveryBudget();
  assert.equal(recovery.request(1), true); assert.equal(recovery.request(2), true); assert.equal(recovery.request(3), false);
  assert.equal(recovery.request(30003), true);
});
