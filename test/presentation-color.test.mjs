import test from 'node:test';
import assert from 'node:assert/strict';
import { rawToRgba } from '../packages/presentation/dist/index.js';
import { compareRgba, scalarToneMap } from './presentation-color-reference.mjs';

function randomFrame(format, range) {
  const codedWidth = 259, codedHeight = 127;
  const visibleRect = { x: 3, y: 5, width: 253, height: 121 };
  const subsampleX = format !== 'I444P16', subsampleY = format === 'I420P10';
  const depth = format === 'I444P16' ? 16 : 10;
  let end = 7;
  const planes = [0, 1, 2].map(index => {
    const width = index && subsampleX ? Math.ceil(codedWidth / 2) : codedWidth;
    const rows = index && subsampleY ? Math.ceil(codedHeight / 2) : codedHeight;
    const offsetBytes = end + 5, strideBytes = width * 2 + 11;
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
