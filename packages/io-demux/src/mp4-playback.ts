import { BufferSource, Input, MP4, QTFF } from 'mediabunny';
import { BudgetLedger, EngineError, OwnedLease, byteLength, checkOperation, timeBase, type OperationContext, type TimeBase } from '@ubve/core';
import type { MediaTrack } from './media.js';
import { openClassicAlac, readMp4PlaybackIndex, type Mp4IndexedSample, type Mp4PagedTrack } from './mp4-index.js';
import { browserScheduler } from './operations.js';
import type { SourceCache } from './source.js';

const MAX_PROBE_BYTES = 8 * 1024 * 1024;
const MAX_DESCRIPTION_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const NANOS = 1_000_000_000n;
const MAX_TICKS_AS_NUMBER = BigInt(Number.MAX_SAFE_INTEGER);
const refuse = (message: string): never => { throw new EngineError('UNSUPPORTED_PROFILE', message); };
const invalid = (message: string): never => { throw new EngineError('INVALID_PACKET', message); };

type Classic = Awaited<ReturnType<typeof readMp4PlaybackIndex>>;
type BufferLease = OwnedLease<Uint8Array<ArrayBuffer>>;
type Part = { readonly length: number; write(bytes: Uint8Array, at: number): Promise<void> };
type Timeline = { readonly start: bigint; readonly end: bigint; readonly maxComposition: bigint };
type PackedPcm = ReturnType<Classic['tracks'][number]['index']['packedPcm']>;
type SelectedTrack = { readonly track: MediaTrack; readonly index: Mp4PagedTrack; readonly timeline: Timeline; readonly rollSamples: number; readonly base: TimeBase; readonly pcm: PackedPcm | null };
type PacketSample = Mp4IndexedSample & { readonly count: number };
type IndexedPacket = { readonly track: SelectedTrack; readonly sample: PacketSample };

export interface PagedMp4Media {
  readonly tracks: readonly MediaTrack[];
  readonly duration: number; readonly mimeType: string; readonly container: 'mp4' | 'quicktime';
  readonly statistics: { readonly checkpoints: number; readonly codecProbeBytes: number; readonly samples: number; };
  samples(ids: readonly string[], startSeconds: number, operation: () => OperationContext, preroll: (codec: string) => number): AsyncGenerator<IndexedPacket>;
  release(): void;
}

function boxed(type: string, ...contents: readonly Part[]): Part {
  const length = 8 + contents.reduce((total, part) => total + part.length, 0);
  return { length, async write(bytes, at) {
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, length);
    for (let i = 0; i < 4; i++) bytes[at + 4 + i] = type.charCodeAt(i);
    let body = at + 8;
    for (const part of contents) { await part.write(bytes, body); body += part.length; }
  } };
}

function words(...values: readonly (number | (() => number))[]): Part {
  return { length: 4 * values.length, async write(bytes, at) {
    const data = new DataView(bytes.buffer, bytes.byteOffset);
    for (const value of values) { data.setUint32(at, typeof value === 'number' ? value : value()); at += 4; }
  } };
}

// Mediabunny derives codec parameters, dimensions and color from a compact
// view of the original descriptors. Some codecs need the first access unit.
// This private probe contains one original sample per track and only newly
// generated single-row tables. The real tracks/packets never use this Input.
async function codecProbe(cache: SourceCache, classic: Classic, operation: OperationContext): Promise<BufferLease> {
  const copy = (start: number, end: number): Part => ({
    length: end - start, async write(bytes, at) {
      await cache.readValue(start, end, operation, raw => bytes.set(raw, at));
    },
  });
  const copyBox = (box: Classic['movieHeader'], maximum: number) => {
    if (box.end - box.body > maximum) throw new EngineError('ITEM_TOO_LARGE', `MP4 ${box.type} exceeds the bounded codec metadata probe`);
    return boxed(box.type, copy(box.body, box.end));
  };
  const ftyp = classic.fileType ? copyBox(classic.fileType, 4096) : boxed('ftyp', words(0x69736f6d, 0, 0x69736f6d));
  const payload: Part[] = [], tracks: Part[] = [], offsets: number[] = [];
  for (const { index, kind, metadata } of classic.tracks) {
    const first = await index.sample(0, operation);
    if (kind === 'video' && !first.sync) refuse('Paged MP4 video does not start with a declared sync sample');
    const { start, end } = first.range, length = end - start, slot = payload.length;
    if (length === 0) invalid('MP4 first sample is empty');
    payload.push(copy(start, end));
    const [trackHeader, mediaHeader, handler, sampleDescription] = metadata;
    const stbl = boxed('stbl', copyBox(sampleDescription, MAX_DESCRIPTION_BYTES), boxed('stts', words(0, 1, 1, Number(first.duration))),
      boxed('stsc', words(0, 1, 1, 1, 1)), boxed('stsz', words(0, length, 1)), boxed('stco', words(0, 1, () => offsets[slot]!)));
    tracks.push(boxed('trak', copyBox(trackHeader, 256), boxed('mdia', copyBox(mediaHeader, 256), copyBox(handler, 4096), boxed('minf', stbl))));
  }
  const moov = boxed('moov', copyBox(classic.movieHeader, 256), ...tracks), mdat = boxed('mdat', ...payload);
  const length = ftyp.length + moov.length + mdat.length;
  if (length > MAX_PROBE_BYTES) throw new EngineError('ITEM_TOO_LARGE', 'MP4 decoder configuration probe exceeds 8 MiB');
  let at = ftyp.length + moov.length + 8;
  for (const part of payload) { offsets.push(at); at += part.length; }
  const ledger = new BudgetLedger({ bytes: byteLength(MAX_PROBE_BYTES), items: 1, maxSingleItemBytes: byteLength(MAX_PROBE_BYTES) });
  const reservation = ledger.tryReserve(byteLength(length))!;
  try {
    const result = new Uint8Array(length);
    await ftyp.write(result, 0);
    await moov.write(result, ftyp.length);
    await mdat.write(result, ftyp.length + moov.length);
    checkOperation(operation, browserScheduler);
    return OwnedLease.adopt(reservation, result);
  } catch (error) { reservation.release(); throw error; }
}

function presentation({ index, envelope, kind }: Classic['tracks'][number]): Timeline {
  if (index.timescale > 0x7fff_ffff) refuse('MP4 timescale exceeds the exact decoder time-base boundary');
  const scale = BigInt(index.timescale), edits = index.edits, segment = edits?.segments[0];
  if (edits && (edits.segments.length !== 1 || segment?.mediaStart == null)) refuse('Paged MP4 playback requires one contiguous unit-rate edit');
  const start = segment?.mediaStart ?? 0n;
  if (kind === 'audio' && (envelope.minimumOffset !== 0 || envelope.maximumOffset !== 0)) refuse('Paged MP4 audio composition offsets are not admitted');
  let end = envelope.end;
  if (edits) {
    const movieScale = BigInt(edits.movieTimescale), scaledLength = edits.duration * scale;
    if (kind === 'audio') {
      // A movie timestamp may round to a coarser tick than its audio clock.
      const editedEnd = start + (2n * scaledLength + movieScale) / (2n * movieScale);
      if (editedEnd < end) end = editedEnd;
    } else {
      const scaledEnd = start * movieScale + scaledLength;
      const difference = end * movieScale - scaledEnd;
      if (start !== envelope.firstPts || envelope.lastPts * movieScale >= scaledEnd ||
          difference <= -scale || difference >= scale) refuse('Paged MP4 video edits must cover the original picture interval, within movie-clock rounding');
    }
  }
  if (end <= start || end > MAX_TICKS_AS_NUMBER || index.decodeDuration > MAX_TICKS_AS_NUMBER) refuse('MP4 presentation interval is outside the browser transport clock');
  return { start, end, maxComposition: BigInt(envelope.maximumOffset) };
}

function pagedMedia(entries: readonly SelectedTrack[], duration: number, mimeType: string, container: PagedMp4Media['container'],
  codecProbeBytes: number, leases: readonly BufferLease[]): PagedMp4Media {
  const tracks = entries.map(item => item.track);
  const statistics = Object.freeze({ checkpoints: entries.reduce((n, item) => n + item.index.checkpointCount + (item.index.edits?.segments.length ?? 0), 0),
    codecProbeBytes, samples: entries.reduce((n, item) => n + item.index.sampleCount, 0) });
  return { tracks, duration, mimeType, container, statistics,
    async *samples(ids, startSeconds, operation, preroll) {
      const atNs = BigInt(Math.floor(startSeconds * 1e9));
      const read = async (track: SelectedTrack, position: number): Promise<PacketSample | null> => {
        if (position >= track.index.sampleCount) return null;
        const op = operation(), sample = await track.index.sample(position, op);
        if (track.track.kind === 'audio' && sample.pts >= track.timeline.end) return null;
        if (sample.range.end === sample.range.start) invalid('Empty indexed MP4 access unit');
        return track.pcm ? track.pcm(sample, track.timeline.end, op) : { ...sample, count: 1 };
      };
      const readers: { track: SelectedTrack; next: PacketSample | null }[] = [];
      for (const id of ids) {
        const track = entries.find(item => item.track.id === id)!;
        const { index, timeline, rollSamples } = track;
        const scale = BigInt(index.timescale), prerollNs = BigInt(Math.round(preroll(track.track.codec) * 1e9));
        // This is a conservative decode-time bound, not a DTS-as-PTS seek.
        // Any picture that covers the target with the largest composition
        // offset can be decoded from a sync sample at or before this bound.
        const target = timeline.start + ((atNs > prerollNs ? atNs - prerollNs : 0n) * scale) / NANOS;
        const decode = await index.locateDts(target - timeline.maxComposition, operation());
        const recovery = await index.precedingSync(Math.max(0, (decode ?? 0) - rollSamples), operation());
        readers.push({ track, next: await read(track, recovery ?? 0) });
      }
      for (;;) {
        let first: (typeof readers)[number] | undefined;
        for (const current of readers) {
          if (!current.next) continue;
          if (!first || (current.next.dts - current.track.timeline.start) * first.track.base.denominator <
              (first.next!.dts - first.track.timeline.start) * current.track.base.denominator) first = current;
        }
        if (!first) return;
        const sample = first.next!;
        yield { track: first.track, sample };
        first.next = await read(first.track, sample.index + sample.count);
      }
    },
    release() { for (const lease of leases) lease.release(); },
  };
}

export async function openPagedMp4(cache: SourceCache, operation: OperationContext): Promise<PagedMp4Media> {
  const classic = await readMp4PlaybackIndex(cache, operation);
  const ledger = new BudgetLedger({ bytes: byteLength(MAX_CONFIG_BYTES), items: 32, maxSingleItemBytes: byteLength(MAX_DESCRIPTION_BYTES) });
  const leases: BufferLease[] = [];
  const ownDescription = (description?: AllowSharedBufferSource) => {
    const length = description?.byteLength ?? 0;
    const reservation = ledger.tryReserve(byteLength(length));
    if (!reservation) throw new EngineError('ITEM_TOO_LARGE', 'MP4 retained decoder metadata exceeds its bound');
    try {
      const bytes = !description ? new Uint8Array() : ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice() : new Uint8Array(description).slice();
      leases.push(OwnedLease.adopt(reservation, bytes));
      return bytes;
    } catch (error) { reservation.release(); throw error; }
  };
  let probe: BufferLease | null = null, input: Input | null = null;
  try {
    const only = classic.tracks.length === 1 ? classic.tracks[0] : null;
    if (only?.kind === 'audio' && only.index.descriptions[0] === 'alac') {
      const alac = await openClassicAlac(cache, operation);
      const track: MediaTrack = Object.freeze({ id: 'track:1', kind: 'audio', codec: 'alac', codecString: 'alac', language: 'und', name: null,
        default: true, forced: false, width: null, height: null, channelCount: alac.channels, sampleRate: alac.rate, audioEndSample: alac.end - alac.start,
        videoConfig: null, audioConfig: null, codecPrivate: ownDescription(alac.cookie), color: null, nativeTrack: null, matroskaTrack: null });
      return pagedMedia([{ track, index: alac.index, timeline: { start: alac.start, end: alac.end, maxComposition: 0n }, rollSamples: 0, base: timeBase(1n, BigInt(alac.rate)), pcm: null }],
        Number(alac.end - alac.start) / alac.rate, 'audio/mp4; codecs="alac"', 'mp4', 0, leases);
    }
    const timelines = classic.tracks.map(presentation);
    probe = await codecProbe(cache, classic, operation);
    input = new Input({ source: new BufferSource(probe.borrow()), formats: [MP4, QTFF] });
    const native = await input.getTracks(), entries: SelectedTrack[] = [];
    if (native.length !== classic.tracks.length) refuse('MP4 codec metadata provider did not expose every indexed track');
    for (let i = 0; i < native.length; i++) {
      checkOperation(operation, browserScheduler);
      const reader = native[i]!, item = classic.tracks[i]!, timeline = timelines[i]!;
      if (reader.type !== item.kind || await reader.getInternalCodecId() !== item.index.descriptions[0]) invalid('MP4 codec metadata does not match its indexed track');
      const codec = await reader.getCodec();
      if (!codec) return refuse(`MP4 sample entry ${JSON.stringify(item.index.descriptions[0])} is not admitted for paged packet playback`);
      const video = reader.isVideoTrack() ? await reader.getDecoderConfig() : null;
      const audio = reader.isAudioTrack() ? await reader.getDecoderConfig() : null;
      if (item.kind === 'audio' && audio?.sampleRate !== item.index.timescale) refuse('Paged MP4 audio must use its exact PCM rate as the media timescale');
      if (item.kind === 'video' && (!video?.codedWidth || !video?.codedHeight)) invalid('Invalid indexed MP4 video geometry');
      let pcm: PackedPcm | null = null;
      if (codec.startsWith('pcm-')) {
        const packing = /^pcm-(s16|s24|f32)(?:be)?$/.exec(codec), channels = audio?.numberOfChannels;
        if (!packing || channels === undefined || !Number.isInteger(channels) || channels < 1 || channels > 8) return refuse('Paged MP4 PCM requires 1–8 channels of signed 16/24-bit or float32 samples');
        pcm = item.index.packedPcm(channels * (packing[1] === 's16' ? 2 : packing[1] === 's24' ? 3 : 4));
      }
      const codecPrivate = ownDescription(video?.description ?? audio?.description);
      const { default: defaultTrack, forced } = await reader.getDisposition();
      const videoConfig = video ? { ...video, ...(video.description ? { description: codecPrivate } : {}) } : null;
      const audioConfig = audio ? { ...audio, ...(audio.description ? { description: codecPrivate } : {}) } : null;
      const track: MediaTrack = Object.freeze({ id: `track:${reader.id}`, kind: item.kind, codec,
        codecString: await reader.getCodecParameterString(), language: await reader.getLanguageCode(), name: await reader.getName(), default: defaultTrack, forced,
        width: videoConfig?.codedWidth ?? null, height: videoConfig?.codedHeight ?? null, channelCount: audioConfig?.numberOfChannels ?? null,
        sampleRate: audioConfig?.sampleRate ?? null, audioEndSample: audio ? timeline.end - timeline.start : null,
        videoConfig, audioConfig, codecPrivate, color: reader.isVideoTrack() ? await reader.getColorSpace() : null, nativeTrack: null, matroskaTrack: null });
      entries.push({ track, index: item.index, timeline, rollSamples: item.rollSamples, base: timeBase(1n, BigInt(item.index.timescale)), pcm });
    }
    const container = (await input.getFormat()) === QTFF ? 'quicktime' : 'mp4', mimeType = await input.getMimeType();
    checkOperation(operation, browserScheduler);
    const duration = Math.max(...entries.map(({ index, timeline }) => Number(timeline.end - timeline.start) / index.timescale));
    return pagedMedia(entries, duration, mimeType, container, probe.bytes, leases);
  } catch (error) {
    for (const lease of leases) lease.release();
    if (error instanceof EngineError) throw error;
    throw new EngineError('INVALID_PACKET', 'Could not interpret paged MP4 codec metadata', 'caller-fix', { cause: String(error) });
  } finally { input?.dispose(); probe?.release(); }
}
