import test from 'node:test';
import assert from 'node:assert/strict';
import { knownMetadata, unknownMetadata, mergeMetadata, assessPrimaryHdr10, validateMasteringDisplay, validateVideoPixels, validateAudioPCM } from '../packages/core/dist/index.js';

const known = value => knownMetadata(value, 'container');
const rational = (n, d = 1n) => ({ numerator: n, denominator: d });
const xy = (x, y) => ({ x: rational(BigInt(x), 50000n), y: rational(BigInt(y), 50000n) });
const mastering = {
  red: xy(34000, 16000), green: xy(13250, 34500), blue: xy(7500, 3000), white: xy(15635, 16450),
  minimumLuminance: rational(1n, 10000n), maximumLuminance: rational(1000n),
};
const signal = () => ({
  epoch: 0, bitDepth: known(10), chromaSubsampling: known('420'), primaries: known('bt2020'),
  transfer: known('smpte2084'), matrix: known('bt2020-ncl'), range: known('limited'),
  chromaLocation: known('left'), masteringDisplay: known(mastering),
  contentLightLevel: known({ maximumContentLightLevel: 1000, maximumFrameAverageLightLevel: 400 }),
});

test('HDR10 metadata admission preserves unknown and conflicting carrier values', () => {
  assert.equal(assessPrimaryHdr10(signal()).admitted, true);
  const missing = { ...signal(), masteringDisplay: unknownMetadata('carrier omitted mastering display') };
  assert.deepEqual(assessPrimaryHdr10(missing), { admitted: false, reasons: ['masteringDisplay: unknown'] });
  const conflict = mergeMetadata(known('smpte2084'), knownMetadata('bt709', 'bitstream'), (a, b) => a === b);
  assert.equal(conflict.state, 'conflict');
  assert.equal(assessPrimaryHdr10({ ...signal(), transfer: conflict }).admitted, false);
  assert.equal(mergeMetadata(unknownMetadata('absent'), known(10), (a, b) => a === b).value, 10);
});

test('HDR rationals reject invalid denominators, chromaticities and reversed mastering bounds', () => {
  assert.throws(() => validateMasteringDisplay({ ...mastering, minimumLuminance: rational(1n, 0n) }), /rational/);
  assert.throws(() => validateMasteringDisplay({ ...mastering, maximumLuminance: rational(0n) }), /peak/);
  assert.throws(() => validateMasteringDisplay({ ...mastering, minimumLuminance: rational(2000n) }), /reversed/);
  assert.throws(() => validateMasteringDisplay({ ...mastering, red: { x: rational(2n), y: rational(0n) } }), /Chromaticity/);
  assert.equal(assessPrimaryHdr10({ ...signal(), contentLightLevel: known({ maximumContentLightLevel: null, maximumFrameAverageLightLevel: null }) }).admitted, false);
});

const pixels = () => ({
  kind: 'video', format: 'I420P10', codedWidth: 5, codedHeight: 3,
  visibleRect: { x: 0, y: 0, width: 5, height: 3 },
  planes: [{ offsetBytes: 0, strideBytes: 10, rows: 3 }, { offsetBytes: 30, strideBytes: 6, rows: 2 }, { offsetBytes: 42, strideBytes: 6, rows: 2 }],
  data: new Uint8Array(54), color: { primaries: 'bt2020', transfer: 'smpte2084', matrix: 'bt2020-ncl', range: 'limited' },
});
test('I420P10 storage validates odd coded dimensions without truncating chroma', () => {
  validateVideoPixels(pixels());
  assert.throws(() => validateVideoPixels({ ...pixels(), data: new Uint8Array(52) }), /storage/);
  assert.throws(() => validateVideoPixels({ ...pixels(), planes: [pixels().planes[0], { offsetBytes: 28, strideBytes: 6, rows: 2 }, pixels().planes[2]] }), /overlap/);
  assert.throws(() => validateVideoPixels({ ...pixels(), visibleRect: { x: 1, y: 0, width: 5, height: 3 } }), /rectangle/);
  assert.throws(() => validateVideoPixels({ ...pixels(), planes: [pixels().planes[0], { offsetBytes: 31, strideBytes: 6, rows: 2 }, pixels().planes[2]] }), /aligned/);
});

test('integer PCM retains 24-bit words and requires actual channel order and storage', () => {
  const pcm = { kind: 'audio', format: 's32-interleaved', sampleRate: 48000, frames: 2, channelLabels: ['FL', 'FR'], planes: [new Int32Array([0x7fffff, -0x800000, 1, -1])], validBits: 24, alignment: 'least-significant', provenance: 'exact-decoder-pcm' };
  validateAudioPCM(pcm);
  assert.equal(pcm.planes[0][0], 8388607);
  assert.throws(() => validateAudioPCM({ ...pcm, planes: [new Float32Array(4)] }), /storage/);
  assert.throws(() => validateAudioPCM({ ...pcm, channelLabels: ['FL', 'FL'] }), /identities/);
  assert.throws(() => validateAudioPCM({ ...pcm, frames: 3 }), /sample count/);
  validateAudioPCM({ kind: 'audio', format: 'f32-planar', sampleRate: 48000, frames: 2, channelLabels: ['FL', 'FR'], planes: [new Float32Array(2), new Float32Array(2)] });
});
