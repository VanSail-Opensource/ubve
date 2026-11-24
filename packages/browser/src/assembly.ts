import { EngineError } from '@ubve/core';
import { openMedia, packetSeconds } from '@ubve/io-demux';
import type { MediaSourceSession, MediaTrack } from '@ubve/io-demux';
import { createNativeStream } from '@ubve/native-bridge';
import type { NativeStream } from '@ubve/native-bridge';
import { SubtitleController } from '@ubve/presentation';
import { ReferencePlayer, describeInput, prepareDirectPlayback } from './player.js';
import type { MediaInput, PlayerSourceInfo, PlayerTrack, PreparedPlayback, QualityMode } from './player.js';
import { ManagedPlayback } from './managed.js';

export type RoutePreference = 'automatic' | 'native' | 'experimental' | 'managed';
export interface ReferencePlayerFactoryOptions {
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLElement;
  readonly routePreference?: () => RoutePreference;
  readonly assetBaseUrl?: string;
  readonly allowStereoFoldDown?: () => boolean;
  readonly preferWebGpu?: () => boolean;
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
      { overlay: options.overlay, quality: player.snapshot().quality, allowStereoFoldDown: options.allowStereoFoldDown?.() ?? false, preferWebGpu: options.preferWebGpu?.() ?? false }),
  });
  return player;
}

export async function preparePlayback(input: MediaInput, video: HTMLVideoElement, signal: AbortSignal, preference: RoutePreference = 'automatic', assetBaseUrl = '/vendor/', subtitles?: SubtitleController,
  managed?: { readonly overlay: HTMLElement; readonly quality: QualityMode; readonly allowStereoFoldDown: boolean; readonly preferWebGpu?: boolean }): Promise<PreparedPlayback> {
  describeInput(input);
  assetBaseUrl = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
  if (preference !== 'managed') subtitles?.followVideo();
  // An opaque native URL need not offer readable CORS byte access. It remains opaque.
  if (!(input instanceof File) && (preference === 'automatic' || preference === 'native')) return prepareDirectPlayback(input, signal);
  let media: MediaSourceSession | null = null;
  try {
    media = await openMedia(input, { signal });
    if (signal.aborted) throw new DOMException('Open was cancelled', 'AbortError');
    if (preference === 'managed') {
      if (!managed || !subtitles) throw new EngineError('INVALID_ARGUMENT', 'Managed playback requires an output host and subtitle controller');
      return new ManagedPlayback({ media, video, subtitles, signal, assetBaseUrl, ...managed }).asPrepared();
    }
    if (preference === 'experimental') return prepareNativeCandidate(media, video, signal, assetBaseUrl, subtitles);
    const audio = selectDefault(media.tracks, 'audio');
    const requiredSubtitle = media.tracks.find(track => track.kind === 'subtitle' && (track.forced || track.default));
    if (audio && ['truehd', 'dts', 'dts-hd'].includes(audio.codec)) throw new EngineError('UNSUPPORTED_PROFILE', `${audio.codec.toUpperCase()} has no admitted native soundtrack path here. Select Experimental remux / audio bridge to try the lossless candidate.`, 'caller-fix');
    if (requiredSubtitle) throw new EngineError('UNSUPPORTED_PROFILE', 'The source requires an embedded subtitle track that native direct playback cannot preserve. Select a complete managed/remux route or add an external subtitle track.', 'caller-fix');
    if (media.mimeType && !video.canPlayType(media.mimeType)) throw new EngineError('UNSUPPORTED_PROFILE', `The browser does not advertise support for ${media.mimeType}. Select an experimental candidate to try stream-copy remux.`, 'caller-fix');
    const direct = await prepareDirectPlayback(input, signal);
    const owner = media;
    return {
      ...direct, tracks: mapTracks(owner.tracks, false), source: describeMedia(owner),
      selectedAudio: audio?.id ?? null,
      notices: [...direct.notices ?? [], 'Native media buffers are opaque; codec/profile acceptance is not full output qualification.'],
      telemetry: () => ({ explicitBytes: owner.snapshot().cache.bytes }),
      async dispose() { await direct.dispose(); await owner.dispose(); },
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
