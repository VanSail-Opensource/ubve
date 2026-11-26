import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePgsRle, PgsDecoder, parsePgsSup, srtToWebVtt, readEmbeddedSrtCue, parseManagedWebVtt, validateAss, validateAssPacket, decodeSubtitleText, readFontFamilyNames, validateSubtitleFonts }
  from '../packages/presentation/dist/index.js';

const be16 = value => [Math.floor(value / 256), value % 256];
const be24 = value => [Math.floor(value / 65536), ...be16(value % 65536)];
const be32 = value => [Math.floor(value / 16777216), ...be24(value % 16777216)];
const pcs = ({ state = 0x80, clear = false, crop = null, x = 0, y = 0 } = {}) => Uint8Array.from([
  ...be16(4), ...be16(2), 0x10, 0, 1, state, 0, 0, clear ? 0 : 1,
  ...(clear ? [] : [0, 1, 0, 0x40 | (crop ? 0x80 : 0), ...be16(x), ...be16(y), ...(crop ? [...be16(crop.x), ...be16(crop.y), ...be16(crop.width), ...be16(crop.height)] : [])]),
]);
const wds = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 4, 0, 2]);
const pds = Uint8Array.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255, 2, 81, 240, 90, 128]);
const rle = Uint8Array.from([1,1,1,1,0,0,2,2,0,2,0,0]);
const ods = Uint8Array.from([0,1,0,0xc0,...be24(rle.length + 4),0,4,0,2,...rle]);
const segment = (type, body, pts = 90000) => Uint8Array.from([0x50,0x47,...be32(pts),...be32(pts),type,...be16(body.length),...body]);
const source = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]));
const basicSup = () => source(segment(0x16, pcs()), segment(0x17, wds), segment(0x14, pds), segment(0x15, ods), segment(0x80, []),
  segment(0x16, pcs({ state: 0, clear: true }), 180000), segment(0x80, [], 180000));

test('Embedded SRT admits the raw UTF-8 cue body and requires exact provided endpoints', () => {
  const packet = { kind: 'srt', ptsSeconds: 1.125, durationSeconds: 0.75, data: Buffer.from('<I>One</I>\r\n二 </unknown>') };
  assert.deepEqual(readEmbeddedSrtCue(packet), { start: 1.125, end: 1.875, align: 'center', text: '<i>One</i>\n二 </unknown>' });
  for (const durationSeconds of [null, 0, NaN]) assert.throws(() => readEmbeddedSrtCue({ ...packet, durationSeconds }), /positive display interval/);
  assert.throws(() => readEmbeddedSrtCue({ ...packet, data: Uint8Array.of(0xff) }), /UTF-8|encoded data/);
  assert.throws(() => readEmbeddedSrtCue({ ...packet, data: Buffer.from('<b><i>unbalanced</b></i>') }), /markup/);
  assert.throws(() => readEmbeddedSrtCue({ ...packet, data: new Uint8Array(256 * 1024 + 1) }), /256 KiB/);
});

test('PGS RLE preserves color/transparent runs and rejects row overflow/truncation', () => {
  assert.deepEqual(Array.from(decodePgsRle(rle, 4, 2)), [1,1,1,1,2,2,0,0]);
  assert.throws(() => decodePgsRle(Uint8Array.from([0,0x85,1,0,0]), 4, 1), /crosses/);
  assert.throws(() => decodePgsRle(Uint8Array.from([0,0x80]), 4, 1), /Truncated/);
  assert.throws(() => decodePgsRle(Uint8Array.from([1]), 4, 1), /Incomplete/);
});

test('PGS SUP reconstructs palette/object/window state, forced flag and clear event', () => {
  const sets = parsePgsSup(basicSup(), 'bt709-limited');
  assert.equal(sets.length, 2); assert.equal(sets[0].ptsSeconds, 1); assert.equal(sets[1].ptsSeconds, 2);
  const rectangle = sets[0].rectangles[0]; assert.equal(rectangle.forced, true); assert.equal(rectangle.width, 4);
  assert.deepEqual(Array.from(rectangle.rgba.slice(0, 16)), [255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255]);
  assert.deepEqual(Array.from(rectangle.rgba.slice(24)), [0,0,0,0,0,0,0,0]);
  assert.equal(sets[1].clear, true); assert.equal(sets[1].rectangles.length, 0);
});

test('PGS fragments require matching object version and complete declared size', () => {
  const d = new PgsDecoder('bt709-limited');
  d.pushSegment(0x16, pcs(), 1); d.pushSegment(0x17, wds, 1); d.pushSegment(0x14, pds, 1);
  d.pushSegment(0x15, Uint8Array.from([0,1,0,0x80,...be24(rle.length + 4),0,4,0,2,...rle.slice(0, 5)]), 1);
  assert.throws(() => d.pushSegment(0x15, Uint8Array.from([0,1,1,0x40,...rle.slice(5)]), 1), /matching/);
  d.pushSegment(0x15, Uint8Array.from([0,1,0,0x40,...rle.slice(5)]), 1);
  const display = d.pushSegment(0x80, new Uint8Array(), 1); assert.equal(display.rectangles[0].rgba.length, 32);
  assert.equal(d.retainedBitmapBytes, 32); d.releaseDisplaySet(display); d.releaseDisplaySet(display); assert.equal(d.retainedBitmapBytes, 0);
});

test('PGS crop, palette update and retained windows are applied to later display sets', () => {
  const d = new PgsDecoder('bt709-limited');
  d.pushSegment(0x16, pcs({ crop: { x: 1, y: 0, width: 2, height: 2 } }), 1);
  d.pushSegment(0x17, wds, 1); d.pushSegment(0x14, pds, 1); d.pushSegment(0x15, ods, 1);
  const a = d.pushSegment(0x80, new Uint8Array(), 1); assert.equal(a.rectangles[0].width, 2); assert.equal(a.rectangles[0].rgba.length, 16);
  d.pushSegment(0x16, pcs({ state: 0 }), 2); d.pushSegment(0x14, Uint8Array.from([0,1,1,16,128,128,255]), 2);
  const b = d.pushSegment(0x80, new Uint8Array(), 2); assert.deepEqual(Array.from(b.rectangles[0].rgba.slice(0,4)), [0,0,0,255]);
  assert.throws(() => d.pushSegment(0x80, new Uint8Array(), 2), /open composition/);
});

test('PGS 90 kHz timestamp wrap is extended without 32-bit signed offsets', () => {
  const bytes = source(segment(0x16, pcs({ clear: true }), 0xfffffff0), segment(0x80, [], 0xfffffff0),
    segment(0x16, pcs({ state: 0, clear: true }), 0x20), segment(0x80, [], 0x20));
  const sets = parsePgsSup(bytes, 'bt709-limited');
  assert.ok(Math.abs((sets[1].ptsSeconds - sets[0].ptsSeconds) - 48/90000) < 1e-10);
  assert.ok(sets[1].ptsSeconds > 2 ** 32 / 90000);
});

test('PGS rejects missing acquisition state, unknown colors and malformed packet lengths', () => {
  const d = new PgsDecoder('bt709-limited'); d.pushSegment(0x16, pcs(), 0);
  assert.throws(() => d.pushSegment(0x80, new Uint8Array(), 0), /missing/);
  assert.throws(() => parsePgsSup(basicSup().slice(0, 18), 'bt709-limited'), /length/);
  d.reset(); d.pushSegment(0x16, pcs(), 0); d.pushSegment(0x17, wds, 0); d.pushSegment(0x14, pds.slice(0, 7), 0); d.pushSegment(0x15, ods, 0);
  assert.throws(() => d.pushSegment(0x80, new Uint8Array(), 0), /undefined palette/);
});

test('PGS rejects incomplete sidecars and retires partial output on a late packet error', () => {
  assert.throws(() => parsePgsSup(segment(0x16, pcs()), 'bt709-limited'), /complete display-set/);
  const decoder = new PgsDecoder('bt709-limited');
  const oversized = pcs({ clear: true }); oversized.set([...be16(8192), ...be16(4320)]);
  assert.throws(() => decoder.pushSegment(0x16, oversized, 0), /raster budget/);
  assert.throws(() => decoder.pushPacket(source(basicSup(), segment(0x99, []))), /Unsupported PGS/);
  assert.equal(decoder.retainedBitmapBytes, 0);
  decoder.reset(); decoder.pushSegment(0x16, pcs(), 0);
  assert.throws(() => decoder.pushSegment(0x16, pcs(), 1), /previous END/);
  assert.equal(decoder.hasOpenDisplaySet, true);
});

test('malformed PGS object replacement or continuation leaves the admitted fragments intact', () => {
  const decoder = new PgsDecoder('bt709-limited');
  decoder.pushSegment(0x16, pcs(), 1); decoder.pushSegment(0x17, wds, 1); decoder.pushSegment(0x14, pds, 1);
  decoder.pushSegment(0x15, Uint8Array.from([0,1,0,0x80,...be24(rle.length + 4),0,4,0,2,...rle.slice(0, 5)]), 1);
  assert.throws(() => decoder.pushSegment(0x15, Uint8Array.from([0,1,1,0xc0,...be24(rle.length + 4),0,4,0,2,1]), 1), /first object fragment/);
  assert.throws(() => decoder.pushSegment(0x15, Uint8Array.from([0,1,0,0x40,1]), 1), /final object size/);
  decoder.pushSegment(0x15, Uint8Array.from([0,1,0,0x40,...rle.slice(5)]), 1);
  assert.equal(decoder.pushSegment(0x80, new Uint8Array(), 1).rectangles[0].rgba.length, 32);
});

test('SRT timing/basic markup maps to WebVTT and unsupported styling is refused', () => {
  const vtt = srtToWebVtt('1\r\n00:00:01,250 --> 00:00:03,500\r\n<b>Hello</b>\r\nworld\r\n');
  assert.match(vtt, /00:00:01\.250 --> 00:00:03\.500/);
  const cues = parseManagedWebVtt(vtt); assert.equal(cues[0].start, 1.25); assert.equal(cues[0].end, 3.5); assert.equal(cues[0].text, '<b>Hello</b>\nworld');
  assert.throws(() => srtToWebVtt('1\n00:00:01,000 --> 00:00:02,000\n<font color="red">red</font>'), /without losing/);
  assert.throws(() => parseManagedWebVtt('WEBVTT\n\n00:01.000 --> 00:02.000 line:20%\nPlaced'), /positioning/);
  assert.throws(() => parseManagedWebVtt('WEBVTT\n\n00:01.000 --> 00:02.000\n<script>test</script>'), /markup/);
  assert.throws(() => parseManagedWebVtt('WEBVTT\n\n00:01.000 --> 99999999999999:00:02.000\nToo far'), /millisecond range/);
});

test('ASS packet duration is required, milliseconds are explicit and UTF decoding is strict', () => {
  const packet = { kind: 'ass', data: new TextEncoder().encode('2,0,Default,,0,0,0,,Hello'), ptsSeconds: 1.25, durationSeconds: 2.5 };
  assert.deepEqual(validateAssPacket(packet), { content: '2,0,Default,,0,0,0,,Hello', timeMs: 1250, durationMs: 2500 });
  assert.throws(() => validateAssPacket({ ...packet, durationSeconds: null }), /duration/);
  assert.throws(() => validateAssPacket({ ...packet, durationSeconds: 0.0001 }), /millisecond/);
  assert.throws(() => validateAssPacket({ ...packet, ptsSeconds: 1.2501 }), /millisecond/);
  assert.equal(validateAssPacket({ ...packet, ptsSeconds: 32.767 }).timeMs, 32767);
  assert.throws(() => decodeSubtitleText(Uint8Array.from([0xff,0x80])), /valid UTF/);
  assert.equal(decodeSubtitleText(Uint8Array.from([0xff,0xfe,0x41,0,0x42,0])), 'AB');
});

test('ASS preflight counts indented events and requires managed font/graphic attachments', () => {
  const header = '[Script Info]\n[V4+ Styles]\n  Format: Name, Fontname\n\tStyle: Default, Fixture Font\n[Events]\n';
  assert.deepEqual(validateAss(`${header}\tDialogue: 0,test\n`), { events: 1, requestedFonts: ['Fixture Font'] });
  assert.throws(() => validateAss(`${header}\t[Fonts] \nfontname: blob.ttf`), /bounded attachment/);
  assert.throws(() => validateAss(`${header}  Dialogue: 0,test\n`.concat('  Dialogue: 0,test\n'.repeat(50_000))), /50,000/);
});

test('OpenType name table family identity is bounded, not inferred from filename', () => {
  const bytes = new Uint8Array(80); const v = new DataView(bytes.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, 1); v.setUint32(12, 0x6e616d65); v.setUint32(20, 28); v.setUint32(24, 30);
  v.setUint16(30, 1); v.setUint16(32, 18); v.setUint16(34, 3); v.setUint16(40, 1); v.setUint16(42, 8); v.setUint16(44, 0);
  for (let i = 0; i < 4; i++) v.setUint16(46 + i * 2, 'Test'.charCodeAt(i));
  assert.deepEqual(readFontFamilyNames(bytes), ['Test']);
  v.setUint32(20, 0xfffffff0); assert.deepEqual(readFontFamilyNames(bytes), []);
  assert.throws(() => validateSubtitleFonts(Array.from({ length: 33 }, (_, i) => ({ name: String(i), data: Uint8Array.of(1) }))), /32 fonts/);
});

export { basicSup };
