import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openMedia } from '../../packages/io-demux/dist/index.js';

const uint = (value, bytes = 1) => {
  const out = Buffer.alloc(bytes);
  let n = BigInt(value);
  for (let at = bytes - 1; at >= 0; at--) { out[at] = Number(n % 256n); n /= 256n; }
  assert.equal(n, 0n);
  return out;
};
const id = value => uint(value, Math.ceil(value.toString(16).length / 2));
function vint(length) {
  const n = BigInt(length);
  let bytes = 1;
  while (n >= (1n << BigInt(7 * bytes)) - 1n) bytes++;
  return uint(n + (1n << BigInt(7 * bytes)), bytes);
}
const head = (type, length) => Buffer.concat([id(type), vint(length)]);
const element = (type, ...parts) => Buffer.concat([head(type, parts.reduce((n, p) => n + p.length, 0)), ...parts]);
const field = (type, value, bytes) => element(type, uint(value, bytes));
const string = (type, text) => element(type, Buffer.from(text, 'utf8'));
function float(type, number) { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(number); return element(type, bytes); }
function nal(type) {
  // Deliberately synthetic RPU/EL carriage only. It must never reach a decoder.
  return Buffer.of(0, 0, 0, 3, type * 2, 1, 0x80);
}

export async function dolbyBaseCarriage({ profile = 8, sparse = false } = {}) {
  const seed = await readFile(new URL('./modern/hevc-main10-hdr10.mkv', import.meta.url));
  const media = await openMedia(new Blob([seed]));
  try {
    const [track] = media.tracks;
    assert.equal(track.codec, 'hevc');
    assert.equal(track.codecPrivate[21] & 3, 3);
    const clean = [], packets = [];
    const level = 5, lowFlags = profile === 7 ? 7 : 5, compatibilityId = profile === 8 ? 1 : profile === 7 ? 6 : 0;
    for await (const packet of media.packets([track.id])) {
      try {
        const raw = Buffer.from(packet.bytes.borrow());
        clean.push(raw);
        const ticks = Number(packet.ptsTicks / 1_000_000n), timing = Buffer.alloc(3);
        timing.writeInt16BE(ticks, 0); timing[2] = packet.recovery === 'key' ? 128 : 0;
        packets.push(element(0xa3, Buffer.of(0x81), timing, raw, ...(profile == null ? [] : profile === 7 ? [nal(63), nal(62)] : [nal(62)])));
      } finally { packet.bytes.release(); }
    }
    const metadata = profile == null ? [] : [element(0x41e4, field(0x41f0, 2),
      field(0x41e7, profile < 8 ? 0x64766343 : 0x64767643, 4),
      element(0x41ed, Buffer.of(1, 0, profile * 2, level * 8 + lowFlags, compatibilityId * 16)))];
    const tracks = element(0x1654ae6b, element(0xae, field(0xd7, 1), field(0x73c5, 1), field(0x83, 1), string(0x86, 'V_MPEGH/ISO/HEVC'),
      field(0x23e383, track.matroskaTrack.defaultDurationNs, 8), element(0x63a2, Buffer.from(track.codecPrivate)),
      element(0xe0, field(0xb0, track.width, 2), field(0xba, track.height, 2), element(0x55b0, field(0x55b1, 9), field(0x55b9, 1),
        field(0x55ba, 16), field(0x55bb, 9))), ...metadata));
    const ebml = element(0x1a45dfa3, field(0x4286, 1), field(0x42f7, 1), field(0x42f2, 4), field(0x42f3, 8),
      string(0x4282, 'matroska'), field(0x4287, 4), field(0x4285, 2));
    const duration = media.duration, info = element(0x1549a966, field(0x2ad7b1, 1_000_000, 4), float(0x4489, ((sparse ? 1 : 0) + duration) * 1000));
    const cluster = element(0x1f43b675, field(0xe7, 0), ...packets);
    if (!sparse) return { bytes: Buffer.concat([ebml, element(0x18538067, info, tracks, cluster)]), clean, duration };
    const largeGap = 2 ** 32 + 4096, gapHeader = head(0xec, largeGap);
    const cue = offset => element(0x1c53bb6b, element(0xbb, field(0xb3, 1000, 2),
      element(0xb7, field(0xf7, 1), field(0xf1, offset, 8))));
    const relative = info.length + tracks.length + cue(0).length + cluster.length + gapHeader.length + largeGap;
    const tail = element(0x1f43b675, field(0xe7, 1000, 2), ...packets);
    const begin = Buffer.concat([ebml, head(0x18538067, relative + tail.length)]);
    const prefix = Buffer.concat([begin, info, tracks, cue(relative), cluster, gapHeader]);
    return { segments: [[0, prefix], [begin.length + relative, tail]], size: begin.length + relative + tail.length,
      clean, duration: 1 + duration };
  } finally { await media.dispose(); }
}
