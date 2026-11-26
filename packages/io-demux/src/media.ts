import { ADTS, ALL_FORMATS, CustomSource, EncodedPacketSink, HLS, Input, MP3, MPEG_TS, OGG, QTFF, type InputTrack } from 'mediabunny';
import { BudgetLedger, EngineError, OwnedLease, byteLength, byteRange, sessionStamp, timeBase, type EncodedPacket, type MediaTime, type RandomAccessSource, type SessionStamp } from '@ubve/core';
import { BlobSource, SourceCache } from './source.js';
import { HttpRangeSource } from './http.js';
import { abortForOperation, operationContext } from './operations.js';
import { hdr10BaseMode, hevcPacketFilter, type HevcCopyPlan, type HevcPacketMode } from './dolby-vision.js';
import { preflightForPlayback, type MetadataPreflight } from './preflight.js';
import { matroskaPackets, readMatroskaMetadata, type MatroskaMetadata, type MatroskaTrack, type MediaAttachment } from './matroska.js';
import { mp4AudioEditEnd, mp4VideoEditEnd, openClassicAlac } from './mp4-index.js';
import { openPagedMp4, type PagedMp4Media } from './mp4-playback.js';
import { mp3AudioEnd, oggAudioEnd } from './audio-end.js';
import { openPcmFile, type PcmFile } from './pcm-file.js';
import { openTransportProfile, validateTransportRead, type TransportProfile } from './mpegts.js';

export type MediaInput = Blob | { readonly url: string } | RandomAccessSource;
export interface MediaTrack {
  readonly id: string; readonly kind: 'video' | 'audio' | 'subtitle'; readonly codec: string; readonly codecString: string | null;
  readonly language: string; readonly name: string | null; readonly default: boolean; readonly forced: boolean;
  readonly width: number | null; readonly height: number | null; readonly channelCount: number | null; readonly sampleRate: number | null;
  readonly videoConfig: VideoDecoderConfig | null; readonly audioConfig: AudioDecoderConfig | null;
  readonly codecPrivate: Uint8Array; readonly color: VideoColorSpaceInit | null;
  readonly nativeTrack: InputTrack | null; readonly matroskaTrack: MatroskaTrack | null;
  readonly audioEndSample?: bigint | null;
  readonly videoEditEnd?: MediaTime;
  readonly audioEditUnsupported?: boolean;
  readonly transportPid?: number;
}
export interface PacketOptions { readonly startTime?: number; readonly signal?: AbortSignal; readonly stamp?: SessionStamp;
  /** Only the managed HEVC decoder requests inspection or base-layer extraction. */
  readonly hevc?: { readonly trackId: string; readonly mode: HevcPacketMode };
}
export interface OpenMediaOptions { readonly signal?: AbortSignal; readonly stamp?: SessionStamp; readonly cacheBytes?: number; readonly sameOriginCredentials?: boolean; }
export interface MediaPacket extends EncodedPacket { readonly discardPaddingNs: bigint; readonly codecDelayNs: bigint; }
type Alac = Awaited<ReturnType<typeof openClassicAlac>>;
const preroll = (codec: string) => codec === 'opus' ? .08 : codec === 'mp3' || codec === 'vorbis' || codec === 'aac' ? .2 : 0;
const packedPcm = /^pcm-(s16|s24|f32)(?:be)?$/;
const apiSecondsTicks = (time: number): bigint => {
  const scaled = Math.round(time * 1e9);
  if (!Number.isSafeInteger(scaled)) throw new EngineError('INVALID_PACKET', 'Provider timestamp exceeds the nanosecond conversion boundary');
  return BigInt(scaled);
};
const SMALL_DURATION_PROBE_BYTES = 8 * 1024 * 1024;
export class MediaSourceSession {
  readonly input: Input | null; readonly source: RandomAccessSource; readonly cache: SourceCache; readonly tracks: readonly MediaTrack[];
  readonly duration: number | null; readonly mimeType: string; readonly container: string;
  readonly attachments: readonly MediaAttachment[]; readonly matroska: MatroskaMetadata | null; readonly preflight: MetadataPreflight;
  readonly stamp: SessionStamp;
  readonly audioTimestampResolutionSeconds: number;
  #closed = false; #reading = false; #operation = 0; #abort = new AbortController();
  readonly #packets = new BudgetLedger({ bytes: byteLength(64 * 1024 * 1024), items: 128, maxSingleItemBytes: byteLength(32 * 1024 * 1024) });
  readonly #alac: Alac | null;
  readonly #pcmFile: PcmFile | null;
  readonly #timestampOrigin: number;
  readonly #pagedMp4: PagedMp4Media | null;
  constructor(input: Input | null, source: RandomAccessSource, cache: SourceCache, tracks: readonly MediaTrack[], duration: number | null, mimeType: string, container: string, matroska: MatroskaMetadata | null, preflight: MetadataPreflight, stamp: SessionStamp, alac: Alac | null = null, pcmFile: PcmFile | null = null, timestampOrigin = 0, pagedMp4: PagedMp4Media | null = null) {
    this.input = input; this.source = source; this.cache = cache; this.tracks = Object.freeze(tracks); this.duration = duration; this.mimeType = mimeType; this.container = container; this.matroska = matroska; this.attachments = matroska?.attachments ?? []; this.preflight = preflight; this.stamp = stamp;
    this.#alac = alac; this.#pcmFile = pcmFile; this.#timestampOrigin = timestampOrigin;
    this.#pagedMp4 = pagedMp4;
    this.audioTimestampResolutionSeconds = container === 'mpegts' ? 1 / 90000 : Number(matroska?.timecodeScaleNs ?? 0n) / 1e9;
  }
  async *packets(trackIds: readonly string[], options: PacketOptions = {}): AsyncGenerator<MediaPacket> {
    if (this.#closed) throw new EngineError('DISPOSED', 'Media source has been disposed');
    if (this.#reading) throw new EngineError('BACKPRESSURE', 'One selected-track packet reader owns this source', 'retry-when-capacity');
    if (new Set(trackIds).size !== trackIds.length || trackIds.length === 0) throw new EngineError('INVALID_ARGUMENT', 'Select distinct media tracks');
    const tracks = trackIds.map(id => { const track = this.tracks.find(track => track.id === id); if (!track) throw new EngineError('INVALID_ARGUMENT', 'Selected track does not exist'); return track; });
    const startTime = options.startTime ?? 0;
    if (startTime < 0 || !Number.isSafeInteger(Math.floor(startTime * 1e9))) throw new EngineError('INVALID_ARGUMENT', 'Seek position exceeds the exact nanosecond input domain');
    const hevcTrack = options.hevc && tracks.find(track => track.id === options.hevc!.trackId);
    let filter: ReturnType<typeof hevcPacketFilter> | null = null;
    if (options.hevc) {
      if (!hevcTrack || hevcTrack.kind !== 'video' || hevcTrack.codec !== 'hevc') throw new EngineError('INVALID_ARGUMENT', 'HEVC packet inspection needs one selected HEVC video track');
      const declared = hevcTrack.matroskaTrack?.dolbyVision ?? (this.preflight.dolbyVision.length === 1 ? this.preflight.dolbyVision[0] : undefined);
      if (options.hevc.mode === 'ordinary' && (declared || this.preflight.dolbyVision.length !== 0))
        throw new EngineError('UNSUPPORTED_PROFILE', 'A signaled Dolby Vision track cannot be treated as ordinary HEVC by the managed decoder.');
      if (options.hevc.mode !== 'ordinary' && (this.tracks.filter(track => track.kind === 'video').length !== 1 ||
          !declared || hdr10BaseMode(declared) !== options.hevc.mode)) throw new EngineError('UNSUPPORTED_PROFILE', 'A unique HDR10-compatible Dolby Vision declaration is required');
      filter = hevcPacketFilter(options.hevc.mode, hevcTrack.codecPrivate);
    }
    this.#reading = true;
    const stamp = options.stamp ?? this.stamp, signal = options.signal ? AbortSignal.any([options.signal, this.#abort.signal]) : this.#abort.signal;
    const operation = () => operationContext(stamp, `packet-${++this.#operation}`, signal, 10000);
    const sequences = new Map<string, number>();
    const allocate = (data: Uint8Array, plan?: HevcCopyPlan | null) => {
      const reservation = this.#packets.tryReserve(byteLength(plan?.bytes ?? data.byteLength));
      if (!reservation) throw new EngineError('BACKPRESSURE', 'Selected-track packet ownership exceeds bounded capacity', 'retry-when-capacity');
      try {
        const output = plan ? new Uint8Array(plan.bytes) : data.slice();
        plan?.write(output);
        return OwnedLease.adopt<Uint8Array>(reservation, output);
      } catch (error) { reservation.release(); throw error; }
    };
    const packetData = (track: MediaTrack, data: Uint8Array, original: EncodedPacket['representation']): Pick<EncodedPacket, 'bytes' | 'representation'> => {
      const plan = track === hevcTrack ? filter?.(data) : null;
      const representation: EncodedPacket['representation'] = plan ? { kind: 'repacked', transformations: [
        options.hevc?.mode === 'profile-7' ? 'Removed Dolby Vision RPU and HEVC enhancement layer' : 'Removed Dolby Vision RPU',
      ] } : original;
      return { bytes: allocate(data, plan), representation };
    };
    try {
      if (this.#pcmFile) {
        const { rate, frameBytes, frames, start } = this.#pcmFile, track = tracks[0]!;
        const target = Math.min(frames, Math.floor(startTime * rate));
        if (target === frames) return;
        // The first packet may start before the rounded presentation target.
        for (let first = Math.floor(target / 8192) * 8192, index = 0; first < frames; first += 8192, index++) {
          if (signal.aborted) throw signal.reason;
          const count = Math.min(frames - first, 8192), range = byteRange(start + first * frameBytes, start + (first + count) * frameBytes);
          const bytes = await this.cache.readValue(range.start, range.end, operation(), data => allocate(data));
          yield { id: `${stamp.sessionId}:${stamp.generation}:${track.id}:${index}`, stamp, trackId: track.id,
            decodeSequence: index, presentationSequence: index, codecConfigEpoch: 0, timeBase: timeBase(1n, BigInt(rate)),
            ptsTicks: BigInt(first), dtsTicks: BigInt(first), durationTicks: BigInt(count), recovery: 'key', discardPaddingNs: 0n, codecDelayNs: 0n,
            representation: { kind: 'source-exact' }, sourceSpans: [{ source: this.source.identity, range }],
            timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: 'PCM byte frame index at the declared exact file sample rate' }, bytes };
        }
      } else if (this.#pagedMp4) {
        for await (const { track: { track, timeline, base }, sample } of this.#pagedMp4.samples(trackIds, startTime, operation, preroll)) {
          const { range, index } = sample;
          const payload = await this.cache.readValue(range.start, range.end, operation(), data => packetData(track, data, { kind: 'source-exact' }));
          if (signal.aborted) { payload.bytes.release(); throw signal.reason; }
          yield { id: `${stamp.sessionId}:${stamp.generation}:${track.id}:${index}`, stamp, trackId: track.id,
            decodeSequence: index, presentationSequence: null, codecConfigEpoch: 0, timeBase: base,
            ptsTicks: sample.pts - timeline.start, dtsTicks: sample.dts - timeline.start, durationTicks: sample.duration,
            recovery: sample.sync ? 'key' : 'delta', discardPaddingNs: 0n, codecDelayNs: 0n,
            sourceSpans: [{ source: this.source.identity, range }],
            timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: 'Paged MP4 stts/ctts ticks minus the unit-rate media edit start' }, ...payload };
        }
      } else if (this.#alac) {
        const { index, start, end, rate } = this.#alac, track = tracks[0]!;
        const first = await index.locateDts(start + BigInt(Math.floor(startTime * rate)), operation()) ?? 0;
        for (let i = first; i < index.sampleCount; i++) {
          if (signal.aborted) throw signal.reason;
          const item = await index.sample(i, operation()), range = item.range;
          if (item.pts >= end) break;
          if (item.descriptionIndex !== 1 || item.pts !== item.dts) throw new EngineError('UNSUPPORTED_PROFILE', 'ALAC sample configuration or composition order changed');
          const bytes = await this.cache.readValue(range.start, range.end, operation(), data => allocate(data));
          yield { id: `${stamp.sessionId}:${stamp.generation}:${track.id}:${i}`, stamp, trackId: track.id,
            decodeSequence: i, presentationSequence: i, codecConfigEpoch: 0, timeBase: timeBase(1n, BigInt(rate)),
            ptsTicks: item.pts - start, dtsTicks: item.dts - start, durationTicks: item.duration, recovery: 'key',
            discardPaddingNs: 0n, codecDelayNs: 0n, representation: { kind: 'source-exact' }, sourceSpans: [{ source: this.source.identity, range }],
            timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: 'Classic MP4 audio sample clock minus the unit-rate edit start' }, bytes };
        }
      } else if (this.matroska) {
        const selected = new Set(tracks.map(track => track.matroskaTrack!.number)), byNumber = new Map(tracks.map(track => [track.matroskaTrack!.number, track]));
        const seekNs = BigInt(Math.floor(startTime * 1e9));
        let offset = this.matroska.firstCluster, recoveryTime = -1n;
        const recoveryTrack = tracks.find(track => track.kind === 'video') ?? tracks.find(track => track.kind === 'audio');
        const selectedPreRoll = tracks.reduce((max, track) => {
          const declared = track.matroskaTrack!.seekPreRollNs, required = BigInt(Math.round(preroll(track.codec) * 1e9));
          return [declared, required, max].reduce((a, b) => a > b ? a : b);
        }, 0n);
        for (const cue of this.matroska.cues) {
          if (cue.timeNs > seekNs - selectedPreRoll || cue.timeNs <= recoveryTime || (recoveryTrack ? cue.track !== recoveryTrack.matroskaTrack!.number : !selected.has(cue.track))) continue;
          recoveryTime = cue.timeNs; offset = cue.position;
        }
        for await (const raw of matroskaPackets(this.cache, this.matroska, selected, operation, offset)) {
          if (signal.aborted) throw signal.reason;
          const track = byNumber.get(raw.trackNumber)!, sequence = sequences.get(track.id) ?? 0; sequences.set(track.id, sequence + 1);
          const packet: MediaPacket = {
            discardPaddingNs: raw.discardPaddingNs, codecDelayNs: track.matroskaTrack!.codecDelayNs,
            id: `${stamp.sessionId}:${stamp.generation}:${track.id}:${sequence}`, stamp, trackId: track.id, codecConfigEpoch: 0,
            decodeSequence: sequence, presentationSequence: null, timeBase: timeBase(1n, 1000000000n), ptsTicks: raw.ptsNs,
            dtsTicks: null, durationTicks: raw.durationNs, recovery: raw.key ? 'key' : 'delta', timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: `Cluster ticks × TimecodeScale minus CodecDelay; DiscardPadding=${raw.discardPaddingNs}ns is retained for selected-route trim` },
            sourceSpans: [{ source: this.source.identity, range: byteRange(raw.sourceStart, raw.sourceStart + raw.data.length) }],
            ...packetData(track, raw.data, { kind: 'source-exact' }),
          };
          yield packet;
        }
      } else {
        const readers = await Promise.all(tracks.map(async track => {
          if (!track.nativeTrack) throw new EngineError('UNSUPPORTED_CODEC', 'This track lacks an admitted packet provider');
          const sink = new EncodedPacketSink(track.nativeTrack);
          const seek = startTime - preroll(track.codec);
          const key = seek > 0 ? await sink.getKeyPacket(this.#timestampOrigin + seek) : null;
          const first = key ?? await sink.getFirstPacket();
          return { track, sink, next: first };
        }));
        while (readers.some(reader => reader.next !== null)) {
          if (signal.aborted) throw signal.reason;
          // At most one packet per track is retained. No independent unbounded track scans.
          const current = readers.filter(reader => reader.next).sort((a, b) => a.next!.timestamp - b.next!.timestamp)[0]!;
          const raw = current.next!, track = current.track;
          if (raw.byteLength > 32 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'Encoded packet exceeds 32 MiB');
          // Some MOV files declare a single contiguous PCM packet for the
          // entire track. Split on sample boundaries before codec admission.
          const pcm = packedPcm.exec(track.codec);
          if (pcm && track.sampleRate && track.channelCount) {
            const rate = track.sampleRate, block = (pcm[1] === 's16' ? 2 : pcm[1] === 's24' ? 3 : 4) * track.channelCount;
            const position = raw.timestamp * rate, first = Math.round(position);
            if (raw.byteLength % block !== 0 || !Number.isSafeInteger(first) || Math.abs(first - position) > .001) {
              throw new EngineError('UNSUPPORTED_PROFILE', 'PCM packet is not aligned to an integral audio sample');
            }
            for (let at = 0; at < raw.byteLength; at += 8192 * block) {
              const end = Math.min(at + 8192 * block, raw.byteLength);
              const sequence = sequences.get(track.id) ?? 0; sequences.set(track.id, sequence + 1);
              yield { id: `${stamp.sessionId}:${stamp.generation}:${track.id}:${sequence}`, stamp, trackId: track.id,
                codecConfigEpoch: 0, decodeSequence: sequence, presentationSequence: null, timeBase: timeBase(1n, BigInt(rate)),
                ptsTicks: BigInt(first) + BigInt(at / block), dtsTicks: null, durationTicks: BigInt((end - at) / block), recovery: 'key',
                timingProvenance: { kind: 'api-seconds', originalPtsSeconds: raw.timestamp, transformDescription: 'PCM sample-aligned slice of the provider packet; original container DTS unavailable' },
                representation: { kind: 'opaque-adapter', reason: 'Provider PCM packet sliced into bounded whole-sample blocks' }, sourceSpans: null,
                discardPaddingNs: 0n, codecDelayNs: 0n, bytes: allocate(raw.data.subarray(at, end)) };
            }
            current.next = await current.sink.getNextPacket(raw);
            continue;
          }
          const sequence = sequences.get(track.id) ?? 0; sequences.set(track.id, sequence + 1);
          const packet: MediaPacket = {
            discardPaddingNs: 0n, codecDelayNs: 0n,
            id: `${stamp.sessionId}:${stamp.generation}:${current.track.id}:${sequence}`, stamp, trackId: current.track.id, codecConfigEpoch: 0,
            decodeSequence: sequence, presentationSequence: null, timeBase: timeBase(1n, 1000000000n), ptsTicks: apiSecondsTicks(raw.timestamp - this.#timestampOrigin), dtsTicks: null,
            durationTicks: apiSecondsTicks(raw.duration), recovery: raw.type, timingProvenance: { kind: 'api-seconds', originalPtsSeconds: raw.timestamp,
              transformDescription: this.container === 'mpegts' ? 'Mediabunny seconds minus the common transport origin, rounded to nanoseconds; original container DTS is unavailable' :
                'Mediabunny seconds rounded to nanoseconds; original container DTS is unavailable' },
            sourceSpans: null,
            ...packetData(track, raw.data, { kind: 'opaque-adapter', reason: 'Mediabunny packet accessor does not expose original source spans or all repacking operations' }),
          };
          yield packet;
          current.next = await current.sink.getNextPacket(raw);
        }
      }
    } finally { this.#reading = false; }
  }
  snapshot() { return { cache: this.cache.snapshot(), packets: this.#packets.snapshot(), parserMetadata: this.preflight,
    ...(this.#pagedMp4 ? { pagedMp4: this.#pagedMp4.statistics } : {}), parserInternalMemory: 'opaque' as const }; }
  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort(new EngineError('DISPOSED', 'Media source disposed'));
    try { this.input?.dispose(); }
    finally {
      try { await this.cache.close(); }
      finally { this.#pagedMp4?.release(); }
    }
  }
}
const MKV_CODECS: Record<string, string> = { V_AV1: 'av1', V_VP9: 'vp9', V_VP8: 'vp8', 'V_MPEG4/ISO/AVC': 'avc', 'V_MPEGH/ISO/HEVC': 'hevc', A_TRUEHD: 'truehd', A_FLAC: 'flac', A_AAC: 'aac', A_OPUS: 'opus', A_VORBIS: 'vorbis', A_AC3: 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ssa', 'S_TEXT/UTF8': 'srt', 'S_TEXT/WEBVTT': 'webvtt', 'S_HDMV/PGS': 'pgs' };

export async function openMedia(value: MediaInput, options: OpenMediaOptions = {}): Promise<MediaSourceSession> {
  const stamp = options.stamp ?? sessionStamp(crypto.randomUUID(), 0), signal = options.signal; let count = 0;
  const op = () => operationContext(stamp, `open-${++count}`, signal, 10000);
  const source = value instanceof Blob ? new BlobSource(value) : 'url' in value
    ? await HttpRangeSource.open(value.url, op(), { credentials: options.sameOriginCredentials ? 'same-origin' : 'omit' }) : value;
  const cache = new SourceCache(source, options.cacheBytes);
  let input: Input | null = null;
  try {
    const preflight = await preflightForPlayback(cache, op());
    const declaration = preflight.dolbyVision.length === 1 ? preflight.dolbyVision[0] : null;
    const dvSampleEntry = !!declaration && ['dvh1', 'dvhe'].includes(declaration.sampleEntry) && hdr10BaseMode(declaration) !== null;
    if (preflight.requiresPaged || dvSampleEntry) {
      cache.releaseLocalMetadata();
      const paged = await openPagedMp4(cache, op(), dvSampleEntry);
      return new MediaSourceSession(null, source, cache, paged.tracks, paged.duration, paged.mimeType, paged.container, null, preflight, stamp, null, null, 0, paged);
    }
    if (preflight.format === 'other') {
      const pcm = await openPcmFile(cache, op());
      if (pcm) {
        const track: MediaTrack = Object.freeze({ id: 'track:1', kind: 'audio', codec: pcm.codec, codecString: null, language: 'und',
          name: null, default: true, forced: false, width: null, height: null, channelCount: pcm.channels, sampleRate: pcm.rate,
          audioEndSample: BigInt(pcm.frames), videoConfig: null, audioConfig: null, codecPrivate: new Uint8Array(), color: null, nativeTrack: null, matroskaTrack: null });
        return new MediaSourceSession(null, source, cache, [track], pcm.frames / pcm.rate, pcm.mime, pcm.container, null, preflight, stamp, null, pcm);
      }
    }
    const matroska = preflight.format === 'matroska' ? await readMatroskaMetadata(cache, op()) : null;
    let localMp4Metadata = preflight.format === 'isobmff' && source instanceof BlobSource && source.size > cache.pageBytes;
    let transport: TransportProfile | null = null;
    input = new Input({ source: new CustomSource({ getSize: () => source.size,
      read: (start, end) => cache.readProviderStream(start, end, op(), localMp4Metadata,
        transport ? (bytes, at) => validateTransportRead(bytes, at, transport!) : undefined), maxCacheSize: 0, prefetchProfile: 'none' }), formats: ALL_FORMATS });
    // The pinned provider returns its public singleton, even in a minified bundle.
    const providerFormat = await input.getFormat();
    if (providerFormat === HLS) throw new EngineError('UNSUPPORTED_PROFILE', 'An HLS playlist is not a self-contained media file. Use a browser-supported HLS URL.');
    if (providerFormat === MPEG_TS) transport = await openTransportProfile(cache, op());
    const nativeTracks = await input.getTracks(); if (nativeTracks.length > 32) throw new EngineError('ITEM_TOO_LARGE', 'Track count exceeds 32');
    if (transport && transport.tracks.length !== nativeTracks.length) throw new EngineError('UNSUPPORTED_PROFILE', 'Transport provider did not expose every declared stream');
    const format = providerFormat === QTFF ? 'quicktime' : providerFormat === MPEG_TS ? 'mpegts' : providerFormat.name.toLowerCase();
    const timestampOrigin = providerFormat === MPEG_TS ? await input.getFirstTimestamp(nativeTracks) : 0;
    apiSecondsTicks(timestampOrigin);
    const alac = preflight.format === 'isobmff' && nativeTracks.length === 1 && await nativeTracks[0]!.getInternalCodecId() === 'alac'
      ? await openClassicAlac(cache, op()) : null;
    const tracks: MediaTrack[] = [];
    const rawTracks: (MatroskaTrack | null)[] = matroska ? matroska.tracks : nativeTracks.map(() => null);
    for (let i = 0; i < rawTracks.length; i++) {
      const raw = rawTracks[i] ?? null;
      // Mediabunny IDs are public list positions, not Matroska TrackNumbers. Associate only
      // an exactly preserved kind-relative container order, then validate the original CodecID.
      const kindRaw = raw ? matroska!.tracks.filter(track => track.type === raw.type) : [];
      const kindNative = raw ? nativeTracks.filter(track => track.type === raw.type) : [];
      let native = raw ? (kindRaw.length === kindNative.length ? kindNative[kindRaw.indexOf(raw)] ?? null : null) : nativeTracks[i] ?? null;
      if (raw?.type === 'subtitle') native = null;
      if (raw && native && await native.getInternalCodecId() !== raw.codecId) native = null;
      const kind = raw?.type ?? native?.type; if (!kind) continue;
      const video = native?.isVideoTrack() ? native : null, audio = native?.isAudioTrack() ? native : null;
      const videoConfig = video ? await video.getDecoderConfig() : null, audioConfig = audio && !alac ? await audio.getDecoderConfig() : null;
      const disposition = native ? await native.getDisposition() : null;
      const codec = alac ? 'alac' : (native ? await native.getCodec() : null) ?? (raw ? MKV_CODECS[raw.codecId] ?? raw.codecId : 'unknown');
      const transportTrack = transport?.tracks[i];
      if (transportTrack && (kind !== transportTrack.kind || codec !== transportTrack.codec)) throw new EngineError('UNSUPPORTED_PROFILE', 'Transport provider stream order/configuration differs from the program map');
      const rate = alac?.rate ?? audioConfig?.sampleRate ?? raw?.audio['outputSampleRate'] ?? raw?.audio['sampleRate'] ?? null;
      const description = alac?.cookie ?? raw?.codecPrivate ?? descriptionBytes(videoConfig?.description ?? audioConfig?.description);
      const edit = preflight.format === 'isobmff' && codec === 'aac' && Number.isSafeInteger(rate) && rate! > 0
        ? await mp4AudioEditEnd(cache, i, nativeTracks.length, rate!, op()) : null;
      const videoEditEnd = preflight.format === 'isobmff' && !preflight.fragments && video
        ? await mp4VideoEditEnd(cache, i, nativeTracks.length, op()) : null;
      const end = alac ? alac.end - alac.start : providerFormat === OGG && nativeTracks.length === 1 && (codec === 'opus' || codec === 'vorbis')
        ? await oggAudioEnd(cache, codec, description, op()) : providerFormat === MP3 && codec === 'mp3' ? await mp3AudioEnd(cache, op()) : edit?.end ?? null;
      tracks.push(Object.freeze({ id: raw ? `mkv:${raw.number}` : `track:${native!.id}`, kind, codec, codecString: alac ? 'alac' : native ? await native.getCodecParameterString() : null,
        language: raw?.language ?? (native ? await native.getLanguageCode() : 'und'), name: raw?.name ?? (native ? await native.getName() : null),
        default: raw?.default ?? disposition?.default ?? false, forced: raw?.forced ?? disposition?.forced ?? false,
        width: video ? await video.getCodedWidth() : raw?.video['width'] ?? null, height: video ? await video.getCodedHeight() : raw?.video['height'] ?? null,
        channelCount: alac?.channels ?? audioConfig?.numberOfChannels ?? raw?.audio['channels'] ?? null, sampleRate: rate, audioEndSample: end, audioEditUnsupported: edit?.unsupported ?? false,
        videoConfig, audioConfig, codecPrivate: description, color: video ? await video.getColorSpace() : null, nativeTrack: native, matroskaTrack: raw,
        ...(videoEditEnd ? { videoEditEnd } : {}),
        ...(transportTrack ? { transportPid: transportTrack.pid } : {}),
      }));
    }
    const only = tracks.length === 1 ? tracks[0] : null;
    let duration: number | null;
    if (only?.audioEndSample != null && only.sampleRate) duration = Number(only.audioEndSample) / only.sampleRate;
    else if (tracks.some(track => track.videoEditEnd)) {
      // Use the exact movie interval where mapped, but retain other tracks'
      // duration evidence instead of overwriting the whole source duration.
      const durations = await Promise.all(tracks.map(track => track.videoEditEnd
        ? Number(track.videoEditEnd.ticks) / Number(track.videoEditEnd.timeBase.denominator)
        : track.audioEndSample != null && track.sampleRate ? Number(track.audioEndSample) / track.sampleRate
          : track.nativeTrack ? input!.getDurationFromMetadata([track.nativeTrack]) : null));
      const known = durations.filter(value => value !== null);
      duration = known.length ? Math.max(...known) : null;
    } else duration = matroska?.duration ?? await input.getDurationFromMetadata();
    // These formats may carry no declared duration. Small inputs can probe the
    // packet tail. Never scan a whole large file just to populate its duration.
    if (duration === null && source.size <= SMALL_DURATION_PROBE_BYTES && (providerFormat === MPEG_TS || providerFormat === ADTS || preflight.format === 'isobmff')) {
      const elapsed = await probeDuration(input, nativeTracks, op()) - timestampOrigin;
      if (Number.isFinite(elapsed) && elapsed > 0) duration = elapsed;
    }
    let mimeType = ''; try { mimeType = await input.getMimeType(); } catch { /* Exact unsupported codec remains in track descriptor. */ }
    localMp4Metadata = false;
    cache.releaseLocalMetadata();
    return new MediaSourceSession(input, source, cache, tracks, duration, mimeType, format, matroska, preflight, stamp, alac, null, timestampOrigin);
  } catch (error) { input?.dispose(); await cache.close(); throw error; }
}

async function probeDuration(input: Input, tracks: InputTrack[], context: ReturnType<typeof operationContext>): Promise<number> {
  const operation = abortForOperation(context);
  let abort = (): void => {};
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      abort = () => reject(operation.signal.reason);
      if (operation.signal.aborted) abort();
      else operation.signal.addEventListener('abort', abort, { once: true });
    });
    return await Promise.race([input.computeDuration(tracks), expired]);
  } finally { operation.signal.removeEventListener('abort', abort); operation.cleanup(); }
}
function descriptionBytes(description?: AllowSharedBufferSource): Uint8Array {
  if (!description) return new Uint8Array();
  return ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice() : new Uint8Array(description).slice();
}

/** Pure bridge helper; conversion keeps source provenance in the original packet. */
export function packetSeconds(packet: EncodedPacket): { timestamp: number; duration: number } {
  const scale = Number(packet.timeBase.numerator) / Number(packet.timeBase.denominator);
  return { timestamp: Number(packet.ptsTicks) * scale, duration: packet.durationTicks === null ? 0 : Number(packet.durationTicks) * scale };
}
