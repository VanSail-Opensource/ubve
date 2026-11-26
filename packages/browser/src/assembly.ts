import { EngineError } from '@ubve/core';
import { openMedia, packetSeconds } from '@ubve/io-demux';
import type { MediaSourceSession, MediaTrack } from '@ubve/io-demux';
import { createNativeStream } from '@ubve/native-bridge';
import type { NativeStream } from '@ubve/native-bridge';
import { SubtitleController } from '@ubve/presentation';
import { ReferencePlayer, describeInput, prepareDirectPlayback } from './player.js';
import type { MediaInput, PlayerSourceInfo, PlayerTrack, PreparedPlayback, QualityMode } from './player.js';
import { ManagedPlayback } from './managed.js';
import { isDiscImageName, openBluRayClip } from './disc-input.js';

export type RoutePreference = 'automatic' | 'native' | 'experimental' | 'managed';
export interface ReferencePlayerFactoryOptions {
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLElement;
  readonly routePreference?: () => RoutePreference;
  readonly assetBaseUrl?: string;
  readonly allowStereoFoldDown?: () => boolean;
  readonly preferWebGpu?: () => boolean;
  readonly portableAv1?: boolean;
  readonly tracePerformance?: boolean;
  readonly prefetchCanvas?: boolean;
  /** Opt in to Fetch's same-origin credentials for a readable HTTP source. */
  readonly sameOriginMediaCredentials?: boolean;
  /** Optional document-owned audio context, leased by one managed PCM epoch at a time. */
  readonly contextForPcm?: (sampleRate: number) => AudioContext;
}

/** Builds one source owner and one subtitle renderer for this presentation host. */
export function createReferencePlayer(options: ReferencePlayerFactoryOptions): ReferencePlayer {
  let player: ReferencePlayer;
  const subtitles = new SubtitleController({ video: options.video, overlay: options.overlay, quality: 'full',
    onStatus(status) { if (status.state === 'failed') player?.reportOutputFailure(new EngineError('OUTPUT_UNAVAILABLE', status.diagnostics.at(-1) ?? 'Subtitle output failed')); },
  });
  player = new ReferencePlayer({
    video: options.video,
    subtitles,
    prepare: (input, signal) => preparePlayback(input, options.video, signal, options.routePreference?.() ?? 'automatic', options.assetBaseUrl ?? '/vendor/', subtitles,
      { overlay: options.overlay, quality: player.snapshot().quality, allowStereoFoldDown: options.allowStereoFoldDown?.() ?? false, preferWebGpu: options.preferWebGpu?.() ?? false,
        portableAv1: options.portableAv1 ?? false, tracePerformance: options.tracePerformance ?? false, prefetchCanvas: options.prefetchCanvas ?? false,
        sameOriginMediaCredentials: options.sameOriginMediaCredentials ?? false,
        ...(options.contextForPcm ? { contextForPcm: options.contextForPcm } : {}) }),
  });
  return player;
}

export async function preparePlayback(input: MediaInput, video: HTMLVideoElement, signal: AbortSignal, preference: RoutePreference = 'automatic', assetBaseUrl = '/vendor/', subtitles?: SubtitleController,
  managed?: { readonly overlay: HTMLElement; readonly quality: QualityMode; readonly allowStereoFoldDown: boolean; readonly preferWebGpu?: boolean; readonly portableAv1?: boolean; readonly tracePerformance?: boolean; readonly prefetchCanvas?: boolean; readonly sameOriginMediaCredentials?: boolean; readonly contextForPcm?: (sampleRate: number) => AudioContext }): Promise<PreparedPlayback> {
  describeInput(input);
  assetBaseUrl = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
  if ('url' in input && isDiscImageName(new URL(input.url).pathname)) throw new EngineError('UNSUPPORTED_PROFILE', 'Blu-ray disc images must be opened from a local file');
  if (input instanceof File && isDiscImageName(input.name)) throw new EngineError('UNSUPPORTED_PROFILE', 'Inspect this local disc and explicitly choose a Blu-ray clip');
  if ('disc' in input && preference !== 'automatic' && preference !== 'managed') throw new EngineError('UNSUPPORTED_PROFILE', 'Local Blu-ray clips require Automatic or Managed playback');
  if (preference !== 'managed') subtitles?.followVideo();
  // An opaque native URL need not offer readable CORS byte access. It remains opaque.
  if ('url' in input && (preference === 'automatic' || preference === 'native')) return prepareDirectPlayback(input, signal);
  let media: MediaSourceSession | null = null;
  try {
    if ('disc' in input) {
      const clip = await openBluRayClip(input, signal, assetBaseUrl);
      media = await openMedia(clip.source, { signal });
      clip.validate(media);
    } else media = await openMedia(input, { signal, sameOriginCredentials: managed?.sameOriginMediaCredentials === true });
    if (signal.aborted) throw new DOMException('Open was cancelled', 'AbortError');
    if (media.preflight.dolbyVision.length) {
      const descriptions = media.preflight.dolbyVision.map(({ sampleEntry, profile, compatibilityId }) => {
        if (profile === null) return `${sampleEntry} (profile unavailable)`;
        return `P${profile}${profile === 8 && compatibilityId === 1 ? '.1' : ''}`;
      });
      const first = media.preflight.dolbyVision[0]!;
      throw new EngineError('UNSUPPORTED_PROFILE', `Dolby Vision ${[...new Set(descriptions)].join(', ')} is signaled in this file. Dolby Vision output and an implicit compatibility-base fallback are not admitted by this player.`, 'caller-fix',
        { sampleEntry: first.sampleEntry, dolbyVisionProfile: first.profile, dolbyVisionLevel: first.level, dolbyVisionCompatibilityId: first.compatibilityId });
    }
    const preparedMedia = media;
    const software = (): PreparedPlayback => {
      if (!managed || !subtitles) throw new EngineError('INVALID_ARGUMENT', 'Managed playback requires an output host and subtitle controller');
      return new ManagedPlayback({ media: preparedMedia, video, subtitles, signal, assetBaseUrl, ...managed }).asPrepared();
    };
    if (preference === 'managed' || 'disc' in input) return software();
    if (preference === 'experimental') return prepareNativeCandidate(media, video, signal, assetBaseUrl, subtitles);
    const primaryVideo = selectDefault(media.tracks, 'video'), audio = selectDefault(media.tracks, 'audio');
    const requiredSubtitle = media.tracks.find(track => track.kind === 'subtitle' && (track.forced || track.default));
    const capability = (error: EngineError): PreparedPlayback => {
      if (preference === 'automatic' && managed && subtitles) return software();
      throw error;
    };
    if (audio?.codec === 'truehd') return capability(new EngineError('UNSUPPORTED_PROFILE', 'TrueHD has no admitted native soundtrack path here. Select Managed or Experimental remux / audio bridge.', 'caller-fix'));
    if (audio && ['dts', 'dts-hd'].includes(audio.codec)) return capability(new EngineError('UNSUPPORTED_PROFILE', `${audio.codec.toUpperCase()} has no admitted native soundtrack route here.`, 'caller-fix'));
    if (requiredSubtitle) return capability(new EngineError('UNSUPPORTED_PROFILE', 'The source requires an embedded subtitle track that native direct playback cannot preserve. Select a complete managed/remux route.', 'caller-fix'));
    const mime = media.mimeType;
    const details = { mimeType: mime || null, videoCodec: primaryVideo?.codecString ?? null, audioCodec: audio?.codecString ?? null };
    if (media.preflight.format === 'isobmff' && (!mime.includes('codecs=') || (primaryVideo && !primaryVideo.codecString) || (audio && !audio.codecString))) {
      return capability(new EngineError('UNSUPPORTED_PROFILE', 'The exact selected MP4 codec configuration is unknown. Generic container acceptance does not admit this source.', 'caller-fix', details));
    }
    const nativeProbe = mime ? video.canPlayType(mime) : null;
    if (nativeProbe === '') return capability(new EngineError('UNSUPPORTED_PROFILE', `Native direct playback is not advertised for ${mime} by this browser. Repackaging cannot add a missing decoder.`, 'caller-fix', details));
    const source = describeMedia(media), tracks = mapTracks(media.tracks, false);
    // The element owns the original File during native playback. Retain only
    // the small, inspected metadata projection, not a second byte source/cache.
    await media.dispose(); media = null;
    const direct = await prepareDirectPlayback(input, signal);
    return {
      ...direct, tracks, source,
      selectedAudio: audio?.id ?? null,
      notices: [...direct.notices ?? [], ...(nativeProbe ? [`Native MIME probe: ${mime} (${nativeProbe}).`] : []),
        'Native media buffers are opaque; codec/profile acceptance is not full output qualification.'],
      telemetry: () => ({ explicitBytes: 0 }),
    };
  } catch (error) { await media?.dispose(); throw error; }
}

function prepareNativeCandidate(media: MediaSourceSession, video: HTMLVideoElement, signal: AbortSignal, assetBaseUrl: string, subtitles?: SubtitleController): PreparedPlayback {
  let stream: NativeStream | null = null;
  let disposed = false;
  let audioId = selectDefault(media.tracks, 'audio')?.id;
  const videoId = selectDefault(media.tracks, 'video')?.id;
  const audio = media.tracks.find(track => track.id === audioId);
  const subtitle = selectDefault(media.tracks, 'subtitle');
  let subtitlesEnabled = true;
  let embeddedInitialized = false;
  let subtitleEpoch = 0;
  let runtimeRevision = 0;
  const errors = new Set<(error: unknown) => void>();
  const route = audio?.codec === 'truehd' ? 'N2' : 'N1';
  async function start(time = 0, operationSignal = signal): Promise<void> {
    const runtimeSignal = AbortSignal.any([signal, operationSignal]);
    const ensureActive = (): void => { if (disposed || runtimeSignal.aborted) throw new DOMException('Open was cancelled', 'AbortError'); };
    ensureActive();
    const revision = ++runtimeRevision;
    const previous = stream; stream = null;
    await previous?.dispose(); ensureActive();
    if (subtitle && subtitlesEnabled) {
      if (!subtitles || (subtitle.codec !== 'ass' && subtitle.codec !== 'ssa')) throw new EngineError('UNSUPPORTED_PROFILE', `Embedded ${subtitle.codec} streaming is not admitted for this route.`, 'caller-fix');
      if (!embeddedInitialized) {
        await subtitles.load({ kind: subtitle.codec, data: new TextDecoder().decode(subtitle.codecPrivate), fonts: media.attachments.filter(font => /\.(ttf|otf|woff2?)$/i.test(font.name) || /font|truetype|opentype/i.test(font.mimeType)).map(font => ({ name: font.name, data: font.data })), label: subtitle.name ?? subtitle.codec.toUpperCase() });
        embeddedInitialized = true;
      }
      await subtitles.resetStream(++subtitleEpoch);
    }
    ensureActive();
    const activeSubtitle = subtitlesEnabled ? subtitle : undefined, epoch = subtitleEpoch;
    const selection = { ...(videoId ? { videoTrackId: videoId } : {}), ...(audioId ? { audioTrackId: audioId } : {}), ...(activeSubtitle ? { subtitleTrackId: activeSubtitle.id } : {}) };
    // An exact-end seek is a terminal transport position, not a picture interval.
    // Prime from just before the end, then let the facade set the requested endpoint.
    const startTime = media.duration !== null && time >= media.duration ? Math.max(0, media.duration - 0.25) : time;
    const next = await createNativeStream(media, video, selection, { allowExperimental: true, assetBaseUrl, signal: runtimeSignal, startTime, ...(activeSubtitle && subtitles ? { onSubtitle: async (packet) => {
      if (revision !== runtimeRevision || !subtitlesEnabled) return;
      const timing = packetSeconds(packet);
      await subtitles.addPacket({ kind: activeSubtitle.codec as 'ass' | 'ssa', data: packet.bytes.borrow(), ptsSeconds: timing.timestamp, durationSeconds: timing.duration, epoch });
    } } : {}) });
    try {
      ensureActive(); stream = next;
      void next.completion.catch(error => { if (revision === runtimeRevision && !runtimeSignal.aborted && !disposed) for (const listener of errors) listener(error); });
      await next.ready; ensureActive();
    } catch (error) { await next.dispose(); if (stream === next) stream = null; throw error; }
  }
  return {
    route,
    description: route === 'N2' ? 'TrueHD → exact PCM → FLAC · unchanged video' : 'Stream-copy remux · unchanged encoded tracks',
    tracks: mapTracks(media.tracks, track => track.kind === 'audio' && (track.codec === 'truehd') === (route === 'N2') && media.tracks.filter(candidate => candidate.kind === 'audio' && (candidate.codec === 'truehd') === (route === 'N2')).length > 1), selectedAudio: audioId ?? null,
    selectedSubtitle: subtitle?.id ?? null, subtitleLabel: subtitle ? subtitle.name ?? `Embedded ${subtitle.codec.toUpperCase()}` : null,
    get source() {
      const selected = media.tracks.find(track => track.id === audioId);
      return { ...describeMedia(media), audio: selected ? `${selected.codec.toUpperCase()} · ${selected.channelCount ?? '?'} channels${route === 'N2' ? ' → FLAC bridge' : ''}` : 'No audio track' };
    },
    notices: ['Experimental candidate explicitly selected. Native output, HDR10 fidelity and full 60/120 performance gates remain unqualified.'],
    async attach() { await start(); },
    async seek(seconds, seekSignal) { await start(seconds, seekSignal); },
    setSubtitleEnabled(enabled) { subtitlesEnabled = enabled; },
    async selectAudio(trackId, seconds, trackSignal) {
      const next = media.tracks.find(track => track.kind === 'audio' && track.id === trackId);
      if (!next) throw new EngineError('INVALID_ARGUMENT', 'Requested audio track does not exist');
      if (Boolean(next.codec === 'truehd') !== Boolean(audio?.codec === 'truehd')) throw new EngineError('UNSUPPORTED_PROFILE', 'Switching soundtrack bridge types requires reopening the source');
      audioId = trackId; await start(seconds, trackSignal);
    },
    telemetry: () => ({ explicitBytes: media.snapshot().cache.bytes }),
    subscribeError(listener) { errors.add(listener); return () => errors.delete(listener); },
    async dispose() { if (disposed) return; disposed = true; ++runtimeRevision; errors.clear(); await stream?.dispose(); await media.dispose(); },
  };
}

function selectDefault(tracks: readonly MediaTrack[], kind: MediaTrack['kind']): MediaTrack | undefined {
  return tracks.find(track => track.kind === kind && track.default) ?? tracks.find(track => track.kind === kind);
}
function mapTracks(tracks: readonly MediaTrack[], switchable: false | ((track: MediaTrack) => boolean)): readonly PlayerTrack[] {
  return Object.freeze(tracks.map(track => Object.freeze({
    id: track.id, kind: track.kind, label: track.name ?? `${track.language === 'und' ? '' : `${track.language} · `}${track.codec.toUpperCase()}${track.channelCount ? ` · ${track.channelCount} ch` : ''}`,
    language: track.language, codec: track.codec, channels: track.channelCount,
    selectable: switchable ? switchable(track) : false,
  })));
}
function describeMedia(media: MediaSourceSession): Partial<PlayerSourceInfo> {
  const video = selectDefault(media.tracks, 'video'), audio = selectDefault(media.tracks, 'audio');
  const color = video?.color;
  return {
    mime: media.mimeType || media.container,
    width: video?.width ?? null, height: video?.height ?? null,
    color: color ? `${color.primaries ?? 'unknown primaries'} · ${color.transfer ?? 'unknown transfer'} · output unverified` : 'Color metadata unknown · output unverified',
    audio: audio ? `${audio.codec.toUpperCase()} · ${audio.channelCount ?? '?'} channels · ${audio.sampleRate ?? '?'} Hz` : 'No audio track',
  };
}

/** Full/performance describe transformations; neither setting is an admission verdict. */
export const qualityTarget = (mode: QualityMode): number => mode === 'full' ? 60 : 120;
