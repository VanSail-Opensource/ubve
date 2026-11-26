import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Exact FFprobe 9.1 positions/sizes for the authored, closed AVC GOP.
// ctts contains the signed offset against *raw* decode order, not the
// additional DTS shift FFprobe applies to its reported timeline.
const videoSpans = [
  [1910, 24], [1934, 12], [1967, 12], [1987, 12], [2007, 18], [2033, 14], [2055, 12], [2075, 18],
  [2101, 14], [2123, 12], [2139, 18], [2165, 14], [2187, 12], [2207, 18], [2233, 14], [2255, 12],
];
export const gopPictures = videoSpans.length;
const seedSha256 = '951137beee59873f2c95f2e16def9596e2d46717eb415fc3a77532dc19b8db65';
const words = (...values) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeUInt32BE(value, i * 4));
  return bytes;
};
const box = (type, ...parts) => Buffer.concat([words(8 + parts.reduce((n, p) => n + p.length, 0)), Buffer.from(type), ...parts]);
const full = (type, ...parts) => box(type, words(0), ...parts);
function children(box) {
  const result = [];
  for (let pos = 8; pos < box.length;) {
    const size = box.readUInt32BE(pos);
    assert.ok(size >= 8 && pos + size <= box.length);
    result.push([box.toString('ascii', pos + 4, pos + 8), box.subarray(pos, pos + size)]);
    pos += size;
  }
  return result;
}
function replace32(source, position, value) {
  const bytes = Buffer.from(source); bytes.writeUInt32BE(value, position); return bytes;
}
async function seedFile() {
  const seed = await readFile(new URL('./paged-mp4-seed.mp4', import.meta.url));
  assert.equal(createHash('sha256').update(seed).digest('hex'), seedSha256);
  const file = new Map(children(Buffer.concat([Buffer.alloc(8), seed])));
  return { seed, file, movie: children(file.get('moov')) };
}

// Extend a real closed GOP and a real encoded AAC silence frame. Every
// repeated packet has its own bytes and its own checked classic-table entry.
// No production demux/index code is used to create this regression source.
export async function largeMp4Fixture({ brokenSizeCount = false } = {}) {
  const { seed, file, movie } = await seedFile();
  const priming = seed.subarray(1946, 1967), audible = seed.subarray(1979, 1983);
  const gops = 9000, audioSamples = 270_001, videoSamples = gops * gopPictures;
  const movieTicks = (audioSamples - 1) * 1024, duration = movieTicks / 48000;
  assert.equal(videoSamples / 25, duration);
  const vChunk = Buffer.concat(videoSpans.map(([start, length]) => seed.subarray(start, start + length)));
  const vData = Buffer.alloc(gops * vChunk.length, vChunk), aData = Buffer.alloc(priming.length + (audioSamples - 1) * audible.length);
  priming.copy(aData);
  // Ensure the repeated pattern starts exactly at the second audio packet.
  aData.fill(audible, priming.length);
  const ftyp = file.get('ftyp'), vStart = ftyp.length + 8, aStart = vStart + vData.length;
  const tracks = movie.filter(([type]) => type === 'trak').map(([, trak], i) => {
    const track = new Map(children(trak)), mdia = new Map(children(track.get('mdia')));
    const minf = new Map(children(mdia.get('minf'))), stbl = new Map(children(minf.get('stbl')));
    const isVideo = i === 0, count = isVideo ? videoSamples : audioSamples, delta = isVideo ? 512 : 1024;
    const chunks = isVideo ? gops : audioSamples, offsets = Buffer.alloc(chunks * 4);
    for (let n = 0; n < chunks; n++) {
      offsets.writeUInt32BE(isVideo ? vStart + n * vChunk.length : n ? aStart + priming.length + (n - 1) * audible.length : aStart, n * 4);
    }
    const sizes = isVideo ? Buffer.alloc(count * 4, words(...videoSpans.map(([, length]) => length))) : Buffer.alloc(count * 4, words(audible.length));
    if (!isVideo) sizes.writeUInt32BE(priming.length, 0);
    let extra;
    if (isVideo) {
      const ctts = stbl.get('ctts'), pattern = ctts.subarray(16);
      assert.equal(ctts.readUInt32BE(8), 0x01000000);
      const keys = Buffer.alloc(gops * 4);
      for (let n = 0; n < gops; n++) keys.writeUInt32BE(n * gopPictures + 1, n * 4);
      extra = [box('ctts', words(0x01000000, gops * (pattern.length / 8)), Buffer.alloc(gops * pattern.length, pattern)),
        full('stss', words(gops), keys)];
    } else extra = [stbl.get('sgpd'), replace32(stbl.get('sbgp'), 20, count)];
    const tables = box('stbl', stbl.get('stsd'), full('stts', words(1, count, delta)), full('stsc', words(1, 1, isVideo ? gopPictures : 1, 1)),
      full('stsz', words(0, !isVideo && brokenSizeCount ? count + 1 : count), sizes), full('stco', words(chunks), offsets), ...extra);
    const edit = replace32(new Map(children(track.get('edts'))).get('elst'), 16, movieTicks);
    return box('trak', replace32(track.get('tkhd'), 28, movieTicks), box('edts', edit),
      box('mdia', replace32(mdia.get('mdhd'), 24, count * delta), mdia.get('hdlr'),
        box('minf', minf.get(isVideo ? 'vmhd' : 'smhd'), minf.get('dinf'), tables)));
  });
  const moov = box('moov', replace32(new Map(movie).get('mvhd'), 24, movieTicks), ...tracks);
  const bytes = Buffer.concat([ftyp, box('mdat', vData, aData), moov]);
  return { bytes, duration, audioSamples, videoSamples, videoPacket: index => {
    const local = index % gopPictures, start = vStart + Math.floor(index / gopPictures) * vChunk.length
      + videoSpans.slice(0, local).reduce((sum, [, length]) => sum + length, 0);
    const [seedAt, length] = videoSpans[local];
    return { start, end: start + length, bytes: seed.subarray(seedAt, seedAt + length) };
  }, audioPacket: index => {
    const bytes = index === 0 ? priming : audible, start = index === 0 ? aStart : aStart + priming.length + (index - 1) * audible.length;
    return { start, end: start + bytes.length, bytes };
  } };
}

export async function fragmentedMp4Fixture({ oversizedFragment = false } = {}) {
  const { seed, file, movie } = await seedFile(), payload = seed.subarray(1979, 1983);
  const track = new Map(children(movie.filter(([type]) => type === 'trak')[1][1]));
  const mdia = new Map(children(track.get('mdia'))), minf = new Map(children(mdia.get('minf'))), stbl = new Map(children(minf.get('stbl')));
  const samplesPerFragment = oversizedFragment ? 270000 : 1800, fragmentCount = oversizedFragment ? 1 : 150;
  const durationTicks = samplesPerFragment * fragmentCount * 1024, id = 2;
  const empty = box('stbl', stbl.get('stsd'), full('stts', words(0)), full('stsc', words(0)), full('stsz', words(0, 0)), full('stco', words(0)));
  const media = box('mdia', replace32(mdia.get('mdhd'), 24, durationTicks), mdia.get('hdlr'), box('minf', minf.get('smhd'), minf.get('dinf'), empty));
  const moov = box('moov', replace32(new Map(movie).get('mvhd'), 24, durationTicks),
    box('trak', replace32(track.get('tkhd'), 28, durationTicks), media), box('mvex', full('trex', words(id, 1, 1024, payload.length, 0))));
  const header = (index, offset) => box('moof', full('mfhd', words(index + 1)),
    box('traf', box('tfhd', words(0x020000, id)), full('tfdt', words(index * samplesPerFragment * 1024)),
      box('trun', words(1, samplesPerFragment, offset))));
  const mdat = box('mdat', Buffer.alloc(samplesPerFragment * payload.length, payload));
  const parts = [file.get('ftyp'), moov], positions = [];
  let at = parts[0].length + moov.length;
  for (let i = 0; i < fragmentCount; i++) {
    positions.push(at);
    const moof = header(i, header(i, 0).length + 8);
    parts.push(moof, mdat); at += moof.length + mdat.length;
  }
  const entries = Buffer.alloc(fragmentCount * 11);
  for (let i = 0; i < fragmentCount; i++) {
    const at = i * 11;
    entries.writeUInt32BE(i * samplesPerFragment * 1024, at);
    entries.writeUInt32BE(positions[i], at + 4);
    entries.fill(1, at + 8, at + 11);
  }
  const tfra = full('tfra', words(id, 0, fragmentCount), entries);
  parts.push(box('mfra', tfra, full('mfro', words(tfra.length + 24))));
  return { bytes: Buffer.concat(parts), fragmentCount, samplesPerFragment, durationTicks, payload };
}

export async function sparsePcmMovie(frames = 2_200_000_000, perChunk = 65536) {
  const { movie } = await seedFile();
  const track = new Map(children(movie.filter(([type]) => type === 'trak')[1][1]));
  const mdia = new Map(children(track.get('mdia'))), minf = new Map(children(mdia.get('minf')));
  const entry = Buffer.alloc(28);
  entry.writeUInt16BE(1, 6); entry.writeUInt16BE(1, 16); entry.writeUInt16BE(16, 18); entry.writeUInt32BE(48000 * 65536, 24);
  const ftyp = box('ftyp', words(0x71742020, 0, 0x71742020));
  const extended = Buffer.alloc(8); extended.writeBigUInt64BE(BigInt(frames * 2 + 16));
  const prefix = Buffer.concat([ftyp, words(1), Buffer.from('mdat'), extended]);
  const count = Math.ceil(frames / perChunk), tail = frames % perChunk;
  const offsets = Buffer.alloc(count * 8);
  for (let i = 0; i < count; i++) offsets.writeBigUInt64BE(BigInt(prefix.length + i * perChunk * 2), i * 8);
  const chunks = count > 1 && tail ? words(2, 1, perChunk, 1, count, tail, 1) : words(1, 1, Math.min(frames, perChunk), 1);
  const stbl = box('stbl', full('stsd', words(1), box('sowt', entry)), full('stts', words(1, frames, 1)),
    full('stsc', chunks), full('stsz', words(2, frames)), full('co64', words(count), offsets));
  const moov = box('moov', replace32(new Map(movie).get('mvhd'), 24, frames),
    box('trak', replace32(track.get('tkhd'), 28, frames), box('mdia', replace32(mdia.get('mdhd'), 24, frames),
      mdia.get('hdlr'), box('minf', minf.get('smhd'), minf.get('dinf'), stbl))));
  const moovAt = prefix.length + frames * 2;
  return { size: moovAt + moov.length, segments: [[0, prefix], [moovAt - 2, Buffer.of(0x12, 0x34)], [moovAt, moov]],
    frames, dataAt: prefix.length, duration: frames / 48000 };
}

// Relocate only moov. All encoded payload positions stay unchanged. The
// sparse free box crosses the metadata-byte threshold without fake samples.
export function padClassicMoov(bytes) {
  let pos = 0;
  for (const [type, part] of children(Buffer.concat([Buffer.alloc(8), bytes]))) {
    if (type === 'moov') {
      const padding = 16 * 1024 * 1024;
      const prefix = Buffer.concat([words(part.length + padding), Buffer.from('moov'), part.subarray(8), words(padding), Buffer.from('free')]);
      return { size: bytes.length + part.length + padding,
        segments: [[0, bytes.subarray(0, pos)], [pos, Buffer.concat([words(part.length), Buffer.from('free')])],
          [pos + part.length, bytes.subarray(pos + part.length)], [bytes.length, prefix]] };
    }
    pos += part.length;
  }
  throw new Error('Fixture has no classic moov');
}
