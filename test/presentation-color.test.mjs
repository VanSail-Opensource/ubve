import test from 'node:test';
import assert from 'node:assert/strict';
import { rawToRgba } from '../packages/presentation/dist/index.js';
import { compareRgba, scalarToneMap } from './presentation-color-reference.mjs';

function randomFrame(format, range, aligned = false) {
  const codedWidth = 259, codedHeight = 127;
  const visibleRect = { x: 3, y: 5, width: 253, height: 121 };
  const subsampleX = format !== 'I444P16', subsampleY = format === 'I420P10';
  const depth = format === 'I444P16' ? 16 : 10;
  let end = aligned ? 8 : 7;
  const planes = [0, 1, 2].map(index => {
    const width = index && subsampleX ? Math.ceil(codedWidth / 2) : codedWidth;
    const rows = index && subsampleY ? Math.ceil(codedHeight / 2) : codedHeight;
    const offsetBytes = end + (aligned ? 6 : 5), strideBytes = width * 2 + (aligned ? 12 : 11);
    end = offsetBytes + strideBytes * rows;
    return { width, rows, offsetBytes, strideBytes };
  });
  const data = new Uint8Array(end);
  const view = new DataView(data.buffer);
  let state = 0x78c5b91e;
  for (const plane of planes) for (let y = 0; y < plane.rows; y++) for (let x = 0; x < plane.width; x++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    view.setUint16(plane.offsetBytes + plane.strideBytes * y + x * 2, state >>> (32 - depth), true);
  }
  return { format, codedWidth, codedHeight, visibleRect, planes, data,
    color: { transfer: 'pq', primaries: 'bt2020', matrix: 'bt2020-ncl', range } };
}

test('aligned SDR I420P10 fast path exactly matches the generic path across matrices and sampling', () => {
  for (const range of ['limited', 'full']) for (const matrix of ['bt709', 'smpte170m', 'bt470bg']) {
    const input = randomFrame('I420P10', range, true);
    const frame = { ...input, color: { transfer: 'bt709', primaries: 'bt709', matrix, range } };
    const initial = frame.data.slice();
    const odd = new Uint8Array(initial.length + 1).subarray(1); odd.set(initial);
    // Force all three uncommon upper-bit branches inside the first selected pixel.
    for (let plane = 0; plane < frame.planes.length; plane++) {
      const p = frame.planes[plane];
      const row = plane === 0 ? frame.visibleRect.y : Math.floor(frame.visibleRect.y / 2);
      const column = plane === 0 ? frame.visibleRect.x : Math.floor(frame.visibleRect.x / 2);
      const at = p.offsetBytes + row * p.strideBytes + column * 2;
      frame.data[at + 1] = 0x8f; odd[at + 1] = 0x8f;
    }
    const source = frame.data.slice();
    for (const maximumHeight of [121, 85, 1]) {
      const expected = rawToRgba({ ...frame, data: odd }, { maximumHeight });
      const reuse = new Uint8ClampedArray(expected.data.length);
      const actual = rawToRgba(frame, { maximumHeight }, reuse);
      assert.equal(actual.transform, expected.transform);
      assert.equal(actual.width, expected.width); assert.equal(actual.height, expected.height);
      assert.equal(actual.data, reuse);
      assert.deepEqual(actual.data, expected.data);
    }
    assert.deepEqual(frame.data, source);
  }
});

test('reduced RGB8 PQ transfer tables remain within one quantized scalar of independent pow reference', () => {
  let scalars = 0, changed = 0;
  for (const format of ['I420P10', 'I422P10', 'I444P16']) for (const range of ['limited', 'full']) {
    const frame = randomFrame(format, range);
    const initial = frame.data.slice();
    for (const [targetWhiteNits, maximumHeight] of [[80, 121], [203, 87], [500, 101]]) {
      const options = { allowSdrToneMap: true, targetWhiteNits, maximumHeight };
      const reference = scalarToneMap(frame, options);
      const output = rawToRgba(frame, options);
      const diff = compareRgba(reference.data, output.data);
      assert.equal(output.transform, 'pq-bt2020-to-sdr');
      assert.equal(output.width, reference.width); assert.equal(output.height, reference.height);
      assert.ok(diff.maxAbsoluteDelta <= 1);
      scalars += diff.scalars; changed += diff.changed;
    }
    assert.deepEqual(frame.data, initial, 'presentation never mutates source decode planes');
  }
  assert.ok(scalars > 1_000_000);
  assert.ok(changed / scalars < 0.001, `changed ${changed}/${scalars}`);
});

test('RGBA fast path respects visible crop, row padding and independent reusable memory', () => {
  const data = Uint8Array.from({ length: 36 }, (_, i) => i);
  const frame = { format: 'RGBA8', codedWidth: 3, codedHeight: 2, visibleRect: { x: 1, y: 0, width: 2, height: 2 },
    data, planes: [{ offsetBytes: 1, strideBytes: 17, rows: 2 }], color: {} };
  const reuse = new Uint8ClampedArray(16);
  const output = rawToRgba(frame, {}, reuse);
  assert.equal(output.data, reuse);
  assert.deepEqual([...output.data], [...data.slice(5, 13), ...data.slice(22, 30)]);
  const alias = new Uint8ClampedArray(data.buffer, 0, 16);
  assert.notEqual(rawToRgba(frame, {}, alias).data, alias);
  assert.deepEqual(data, Uint8Array.from({ length: 36 }, (_, i) => i));
  assert.throws(() => rawToRgba({ ...frame, color: { transfer: 'pq', primaries: 'bt2020', matrix: 'bt2020-ncl' } }, { allowSdrToneMap: true }), /planar/);
});
