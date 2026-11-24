import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, type InputTrack } from 'mediabunny';
import { BudgetLedger, EngineError, OwnedLease, byteLength, byteRange, sessionStamp, timeBase, type EncodedPacket, type RandomAccessSource, type SessionStamp } from '@ubve/core';
import { BlobSource, SourceCache } from './source.js';
import { HttpRangeSource } from './http.js';
import { operationContext } from './operations.js';
import { preflightMetadata, type MetadataPreflight } from './preflight.js';
import { matroskaPackets, readMatroskaMetadata, type MatroskaMetadata, type MatroskaTrack, type MediaAttachment } from './matroska.js';

export type MediaInput = Blob | { readonly url: string } | RandomAccessSource;
export interface MediaTrack {
  readonly id: string; readonly kind: 'video' | 'audio' | 'subtitle'; readonly codec: string; readonly codecString: string | null;
  readonly language: string; readonly name: string | null; readonly default: boolean; readonly forced: boolean;
  readonly width: number | null; readonly height: number | null; readonly channelCount: number | null; readonly sampleRate: number | null;
  readonly videoConfig: VideoDecoderConfig | null; readonly audioConfig: AudioDecoderConfig | null;
  readonly codecPrivate: Uint8Array; readonly color: VideoColorSpaceInit | null;
  readonly nativeTrack: InputTrack | null; readonly matroskaTrack: MatroskaTrack | null;
}
export interface PacketOptions { readonly startTime?: number; readonly signal?: AbortSignal; readonly stamp?: SessionStamp; }
export interface OpenMediaOptions { readonly signal?: AbortSignal; readonly stamp?: SessionStamp; readonly cacheBytes?: number; }
export interface MediaPacket extends EncodedPacket { readonly discardPaddingNs: bigint; readonly codecDelayNs: bigint; }
export class MediaSourceSession {
  readonly input: Input; readonly source: RandomAccessSource; readonly cache: SourceCache; readonly tracks: readonly MediaTrack[];
  readonly duration: number | null; readonly mimeType: string; readonly container: string;
  readonly attachments: readonly MediaAttachment[]; readonly matroska: MatroskaMetadata | null; readonly preflight: MetadataPreflight;
  readonly stamp: SessionStamp;
  #closed = false; #reading = false; #operation = 0; #abort = new AbortController();
  readonly #packets = new BudgetLedger({ bytes: byteLength(64 * 1024 * 1024), items: 128, maxSingleItemBytes: byteLength(32 * 1024 * 1024) });
  constructor(input: Input, source: RandomAccessSource, cache: SourceCache, tracks: readonly MediaTrack[], duration: number | null, mimeType: string, container: string, matroska: MatroskaMetadata | null, preflight: MetadataPreflight, stamp: SessionStamp) {
    this.input = input; this.source = source; this.cache = cache; this.tracks = Object.freeze(tracks); this.duration = duration; this.mimeType = mimeType; this.container = container; this.matroska = matroska; this.attachments = matroska?.attachments ?? []; this.preflight = preflight; this.stamp = stamp;
  }
  async *packets(trackIds: readonly string[], options: PacketOptions = {}): AsyncGenerator<MediaPacket> {
    if (this.#closed) throw new EngineError('DISPOSED', 'Media source has been disposed');
    if (this.#reading) throw new EngineError('BACKPRESSURE', 'One selected-track packet reader owns this source', 'retry-when-capacity');
    if (new Set(trackIds).size !== trackIds.length || trackIds.length === 0) throw new EngineError('INVALID_ARGUMENT', 'Select distinct media tracks');
    const tracks = trackIds.map(id => { const track = this.tracks.find(track => track.id === id); if (!track) throw new EngineError('INVALID_ARGUMENT', 'Selected track does not exist'); return track; });
    const startTime = options.startTime ?? 0;
    if (startTime < 0 || !Number.isSafeInteger(Math.floor(startTime * 1e9))) throw new EngineError('INVALID_ARGUMENT', 'Seek position exceeds the exact nanosecond input domain');
    this.#reading = true;
    const stamp = options.stamp ?? this.stamp, signal = options.signal ? AbortSignal.any([options.signal, this.#abort.signal]) : this.#abort.signal;
    const operation = () => operationContext(stamp, `packet-${++this.#operation}`, signal, 10000);
    const sequences = new Map<string, number>();
    const allocate = (data: Uint8Array) => {
      const reservation = this.#packets.tryReserve(byteLength(data.byteLength));
      if (!reservation) throw new EngineError('BACKPRESSURE', 'Selected-track packet ownership exceeds bounded capacity', 'retry-when-capacity');
      try { return OwnedLease.adopt<Uint8Array>(reservation, data.slice()); } catch (error) { reservation.release(); throw error; }
    };
    try {
      if (this.matroska) {
        const selected = new Set(tracks.map(track => track.matroskaTrack!.number)), byNumber = new Map(tracks.map(track => [track.matroskaTrack!.number, track]));
        const seekNs = BigInt(Math.floor(startTime * 1e9));
        let offset = this.matroska.firstCluster, recoveryTime = -1n;
        const recoveryTrack = tracks.find(track => track.kind === 'video') ?? tracks.find(track => track.kind === 'audio');
        const selectedPreRoll = tracks.reduce((max, track) => track.matroskaTrack!.seekPreRollNs > max ? track.matroskaTrack!.seekPreRollNs : max, 0n);
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
            dtsTicks: null, durationTicks: raw.durationNs, recovery: raw.key ? 'key' : 'delta', timingProvenance: { kind: 'container-exact', originalPtsSeconds: null, transformDescription: `Cluster ticks × TimecodeScale minus CodecDelay; DiscardPadding=${raw.discardPaddingNs}ns is retained, not applied; presentation must refuse when nonzero until trim is implemented` },
            representation: { kind: 'source-exact' }, sourceSpans: [{ source: this.source.identity, range: byteRange(raw.sourceStart, raw.sourceStart + raw.data.length) }], bytes: allocate(raw.data),
          };
          yield packet;
        }
      } else {
        const readers = await Promise.all(tracks.map(async track => {
          if (!track.nativeTrack) throw new EngineError('UNSUPPORTED_CODEC', 'This track lacks an admitted packet provider');
          const sink = new EncodedPacketSink(track.nativeTrack);
          const first = startTime > 0 ? await sink.getKeyPacket(startTime) : await sink.getFirstPacket();
          return { track, sink, next: first };
        }));
        while (readers.some(reader => reader.next !== null)) {
          if (signal.aborted) throw signal.reason;
          // At most one packet per track is retained. No independent unbounded track scans.
          const current = readers.filter(reader => reader.next).sort((a, b) => a.next!.timestamp - b.next!.timestamp)[0]!;
          const raw = current.next!, sequence = sequences.get(current.track.id) ?? 0; sequences.set(current.track.id, sequence + 1);
          if (raw.byteLength > 32 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'Encoded packet exceeds 32 MiB');
          const packet: MediaPacket = {
            discardPaddingNs: 0n, codecDelayNs: 0n,
            id: `${stamp.sessionId}:${stamp.generation}:${current.track.id}:${sequence}`, stamp, trackId: current.track.id, codecConfigEpoch: 0,
            decodeSequence: sequence, presentationSequence: null, timeBase: timeBase(1n, 1000000000n), ptsTicks: BigInt(Math.round(raw.timestamp * 1e9)), dtsTicks: null,
            durationTicks: BigInt(Math.round(raw.duration * 1e9)), recovery: raw.type, timingProvenance: { kind: 'api-seconds', originalPtsSeconds: raw.timestamp, transformDescription: 'Mediabunny seconds rounded to nanoseconds; original container DTS is unavailable' },
            representation: { kind: 'opaque-adapter', reason: 'Mediabunny packet accessor does not expose original source spans or all repacking operations' }, sourceSpans: null, bytes: allocate(raw.data),
          };
          yield packet;
          current.next = await current.sink.getNextPacket(raw);
        }
      }
    } finally { this.#reading = false; }
  }
  snapshot() { return { cache: this.cache.snapshot(), packets: this.#packets.snapshot(), parserMetadata: this.preflight, parserInternalMemory: 'opaque' as const }; }
  async dispose(): Promise<void> { if (this.#closed) return; this.#closed = true; this.#abort.abort(new EngineError('DISPOSED', 'Media source disposed')); this.input.dispose(); await this.cache.close(); }
}
const MKV_CODECS: Record<string, string> = { V_AV1: 'av1', V_VP9: 'vp9', V_VP8: 'vp8', 'V_MPEG4/ISO/AVC': 'avc', 'V_MPEGH/ISO/HEVC': 'hevc', A_TRUEHD: 'truehd', A_FLAC: 'flac', A_AAC: 'aac', A_OPUS: 'opus', A_AC3: 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ssa', 'S_TEXT/UTF8': 'srt', 'S_TEXT/WEBVTT': 'webvtt', 'S_HDMV/PGS': 'pgs' };

export async function openMedia(value: MediaInput, options: OpenMediaOptions = {}): Promise<MediaSourceSession> {
  const stamp = options.stamp ?? sessionStamp(crypto.randomUUID(), 0), signal = options.signal; let count = 0;
  const op = () => operationContext(stamp, `open-${++count}`, signal, 10000);
  const source = value instanceof Blob ? new BlobSource(value) : 'url' in value ? await HttpRangeSource.open(value.url, op()) : value;
  const cache = new SourceCache(source, options.cacheBytes);
  let input: Input | null = null;
  try {
    const preflight = await preflightMetadata(cache, op());
    const matroska = preflight.format === 'matroska' ? await readMatroskaMetadata(cache, op()) : null;
    input = new Input({ source: new CustomSource({ getSize: () => source.size, read: (start, end) => cache.read(start, end, op()), maxCacheSize: 0, prefetchProfile: 'none' }), formats: ALL_FORMATS });
    const nativeTracks = await input.getTracks(); if (nativeTracks.length > 32) throw new EngineError('ITEM_TOO_LARGE', 'Track count exceeds 32');
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
      const videoConfig = video ? await video.getDecoderConfig() : null, audioConfig = audio ? await audio.getDecoderConfig() : null;
      const disposition = native ? await native.getDisposition() : null;
      const codec = (native ? await native.getCodec() : null) ?? (raw ? MKV_CODECS[raw.codecId] ?? raw.codecId : 'unknown');
      tracks.push(Object.freeze({ id: raw ? `mkv:${raw.number}` : `track:${native!.id}`, kind, codec, codecString: native ? await native.getCodecParameterString() : null,
        language: raw?.language ?? (native ? await native.getLanguageCode() : 'und'), name: raw?.name ?? (native ? await native.getName() : null),
        default: raw?.default ?? disposition?.default ?? false, forced: raw?.forced ?? disposition?.forced ?? false,
        width: video ? await video.getCodedWidth() : raw?.video['width'] ?? null, height: video ? await video.getCodedHeight() : raw?.video['height'] ?? null,
        channelCount: audioConfig?.numberOfChannels ?? raw?.audio['channels'] ?? null, sampleRate: audioConfig?.sampleRate ?? raw?.audio['sampleRate'] ?? null,
        videoConfig, audioConfig, codecPrivate: raw?.codecPrivate ?? descriptionBytes(videoConfig?.description ?? audioConfig?.description), color: video ? await video.getColorSpace() : null, nativeTrack: native, matroskaTrack: raw,
      }));
    }
    const duration = matroska?.duration ?? await input.getDurationFromMetadata();
    let mimeType = ''; try { mimeType = await input.getMimeType(); } catch { /* Exact unsupported codec remains in track descriptor. */ }
    const format = await input.getFormat();
    return new MediaSourceSession(input, source, cache, tracks, duration, mimeType, format.constructor.name.replace('InputFormat', '').toLowerCase(), matroska, preflight, stamp);
  } catch (error) { input?.dispose(); await cache.close(); throw error; }
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
