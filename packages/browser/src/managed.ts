import { EngineError, compareTime, mediaTime, sessionStamp, timeBase } from '@ubve/core';
import type { AudioPCM, Decoder, EncodedPacket, IntegerAudioPCM, MediaTime, OwnedLease, OwnedOutput, SessionState, VideoPixels } from '@ubve/core';
import { operationContext, packetSeconds } from '@ubve/io-demux';
import type { Hdr10BaseMode, MediaSourceSession, MediaTrack } from '@ubve/io-demux';
import { Av1Decoder, PortableDecoder, TrueHdDecoder, integerPcmToFloat, supportsPortableCodec } from '@ubve/wasm-adapters';
import { CanvasPreconverter, PcmOutput, RawCanvasRenderer, WebGpuRawRenderer, finite, isStreamedTextKind } from '@ubve/presentation';
import type { ConvertedFrame, PcmEvent, StreamedTextKind, SubtitleController } from '@ubve/presentation';
import type { ManagedTransport, ManagedTransportSnapshot, PlayerTrack, PreparedPlayback, QualityMode } from './player.js';
import { PacketStage } from './packet-stage.js';
import { managedGpuOptions } from './gpu-admission.js';
import { PlaybackTrace } from './trace.js';

export interface ManagedPlaybackOptions {
  readonly media: MediaSourceSession;
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLElement;
  readonly subtitles: SubtitleController;
  readonly signal: AbortSignal;
  readonly quality: QualityMode;
  readonly assetBaseUrl: string;
  /** Explicit output policy, never part of exact decoded-source PCM. */
  readonly allowStereoFoldDown?: boolean;
  /** With permission above, preserve the requested channels unless they exceed device capacity. */
  readonly stereoFallbackOnly?: boolean;
  readonly preferWebGpu?: boolean;
  readonly hdr10Base?: { readonly mode: Hdr10BaseMode; readonly label: string };
  readonly portableAv1?: boolean;
  readonly tracePerformance?: boolean;
  readonly prefetchCanvas?: boolean;
  readonly contextForPcm?: (sampleRate: number) => AudioContext;
}

type Frame = OwnedOutput<VideoPixels>;
type Epoch = {
  readonly id: number;
  readonly abort: AbortController;
  readonly target: number;
  readonly firstSample: bigint;
  readonly frames: Frame[];
  readonly tasks: Promise<void>[];
  readonly videoPackets: PacketStage<EncodedPacket>;
  readonly audioPackets: PacketStage<EncodedPacket>;
  video: (Decoder<VideoPixels> & { diagnostics(): unknown }) | null;
  audio: TrueHdDecoder | PortableDecoder<AudioPCM> | null;
  pcm: PcmOutput | null;
  preroll: Frame | null;
  videoPrimed: boolean;
  audioPrimed: boolean;
  videoEos: boolean;
  audioEos: boolean;
  audioOutputEnded: boolean;
  sourceEos: boolean;
  priming: boolean;
  sampleRate: number;
  anchor: { graphFrame: number; sample: number } | null;
  frozenSample: number;
  nextWritten: bigint;
  nextDecoded: bigint;
  pendingPcm: Float32Array | null;
  pendingFrames: number;
  prefetched: { readonly frame: Frame; readonly result: Promise<OwnedLease<ConvertedFrame>> } | null;
};

const stampTime = <T>(output: OwnedOutput<T>): number => Number(output.pts.ticks) * Number(output.pts.timeBase.numerator) / Number(output.pts.timeBase.denominator);
const cancelled = (): DOMException => new DOMException('Managed epoch was cancelled', 'AbortError');
const isCancellation = (error: unknown): boolean => (error instanceof DOMException && error.name === 'AbortError') || (error instanceof EngineError && ['CANCELLED', 'STALE_EPOCH', 'DISPOSED'].includes(error.code));
const stereoLabels = ['fold-left', 'fold-right'] as const;

/** Selected packet-fed software decode, paced by the PCM graph. The independently
 * selected SDR or HDR presentation candidate never qualifies physical output. */
export class ManagedPlayback implements ManagedTransport {
  readonly #options: ManagedPlaybackOptions;
  readonly #videoTrack: MediaTrack | undefined;
  readonly #audioTrack: MediaTrack | undefined;
  readonly #subtitleTrack: MediaTrack | undefined;
  readonly #subtitleKind: StreamedTextKind | undefined;
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: RawCanvasRenderer | null;
  readonly #preconverter: CanvasPreconverter | null;
  #gpuRenderer: WebGpuRawRenderer | null = null;
  readonly #errors = new Set<(error: unknown) => void>();
  readonly #waiters = new Set<() => void>();
  #epoch: Epoch | null = null;
  #epochId = 0;
  #operation = 0;
  #state: SessionState = 'opening';
  #disposed = false;
  #quality: QualityMode;
  #volume = 1;
  #wantPlay = false;
  #frameRequest: number | null = null;
  #rendering = false;
  #renderTask: Promise<void> | null = null;
  #embeddedSubtitlesEnabled = true;
  #logicalTime = 0;
  #wallAnchor: { time: number; performanceMs: number } | null = null;
  #decoded = 0;
  #submitted = 0;
  #late = 0;
  #outsideVideoEdit = 0;
  readonly #videoEditEnd: MediaTime | null;
  #renderMs = 0;
  readonly #trace: PlaybackTrace | null;
  #lastRateAt = 0;
  #lastRateFrames = 0;
  #rate: number | null = null;
  #recoveryTimes: number[] = [];
  #totalRecoveries = 0;
  #lastUnderrun: Readonly<Record<string, unknown>> | null = null;
  #transition: Promise<void> = Promise.resolve();
  #audioChannels = 0;
  #sourceChannels = 0;
  #failure: unknown = null;
  readonly #abortListener: () => void;
  readonly #visibilityListener: () => void;

  constructor(options: ManagedPlaybackOptions) {
    this.#options = options; this.#quality = options.quality;
    this.#trace = options.tracePerformance ? new PlaybackTrace() : null;
    const primary = (kind: MediaTrack['kind']): MediaTrack | undefined => options.media.tracks.find(t => t.kind === kind && t.default) ?? options.media.tracks.find(t => t.kind === kind);
    this.#videoTrack = primary('video'); this.#audioTrack = primary('audio'); this.#subtitleTrack = primary('subtitle');
    const end = this.#videoTrack?.videoEditEnd, nano = 1_000_000_000n;
    // This provider's PTS is rounded to nanoseconds. Map the exact movie
    // boundary into that same observed clock without upgrading PTS provenance.
    this.#videoEditEnd = end ? mediaTime((2n * end.ticks * end.timeBase.numerator * nano + end.timeBase.denominator) / (2n * end.timeBase.denominator), timeBase(1n, nano)) : null;
    if (this.#videoTrack && !supportsPortableCodec('video', this.#videoTrack.codec)) throw new EngineError('UNSUPPORTED_PROFILE', `Managed ${this.#videoTrack.codec} video is not registered in this candidate.`, 'caller-fix');
    if (this.#audioTrack && this.#audioTrack.codec !== 'truehd' && !supportsPortableCodec('audio', this.#audioTrack.codec)) throw new EngineError('UNSUPPORTED_PROFILE', `Managed ${this.#audioTrack.codec} audio is not registered in this candidate.`, 'caller-fix');
    if (this.#audioTrack?.audioEditUnsupported) throw new EngineError('UNSUPPORTED_PROFILE', 'Software audio requires one contiguous admitted MP4 edit');
    if (!this.#videoTrack && !this.#audioTrack) throw new EngineError('UNSUPPORTED_PROFILE', 'No registered managed video or audio track exists.');
    const subtitleCodec = this.#subtitleTrack?.codec;
    if (subtitleCodec !== undefined && !isStreamedTextKind(subtitleCodec)) throw new EngineError('UNSUPPORTED_PROFILE', `Embedded ${subtitleCodec} streaming is not registered in this candidate.`);
    this.#subtitleKind = subtitleCodec;
    const transfer = String(this.#videoTrack?.color?.transfer ?? '');
    const isHdr = !!options.hdr10Base || transfer === 'pq' || transfer === 'smpte2084' || transfer === 'hlg' || transfer === 'arib-std-b67';
    if (isHdr && options.quality === 'full' && !options.preferWebGpu) throw new EngineError('OUTPUT_UNAVAILABLE',
      (options.hdr10Base ? `Dolby Vision ${options.hdr10Base.label} has a supported HDR10 base layer. ` : 'The managed Canvas2D output cannot preserve full HDR. ') +
      'Select Performance for a 720p SDR preview, or explicitly try WebGPU for experimental HDR output.', 'caller-fix');
    if (transfer === 'hlg' || transfer === 'arib-std-b67') throw new EngineError('UNSUPPORTED_PROFILE', 'HLG is not admitted by the managed renderers.', 'caller-fix');
    if (options.preferWebGpu && (!this.#videoTrack || !navigator.gpu)) throw new EngineError('OUTPUT_UNAVAILABLE', 'The selected WebGPU output needs a browser WebGPU API and a supported video track. No fallback was selected.', 'caller-fix');
    this.#canvas = document.createElement('canvas'); this.#canvas.className = 'managed-video-surface';
    this.#canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none';
    this.#canvas.setAttribute('aria-label', 'Managed video presentation');
    this.#renderer = options.preferWebGpu ? null : new RawCanvasRenderer(this.#canvas, { allowSdrToneMap: options.quality === 'performance', ...(options.quality === 'performance' ? { maximumHeight: 720 } : {}) });
    this.#preconverter = options.prefetchCanvas && this.#renderer && this.#videoTrack ? new CanvasPreconverter(options.assetBaseUrl) : null;
    this.#abortListener = () => { this.#epoch?.abort.abort(); this.#wake(); };
    options.signal.addEventListener('abort', this.#abortListener, { once: true });
    this.#visibilityListener = () => { if (document.hidden && this.#state === 'playing') void this.pause().catch(error => this.#fail(error)); };
    document.addEventListener('visibilitychange', this.#visibilityListener);
  }

  async attach(): Promise<void> {
    this.#options.video.style.visibility = 'hidden';
    this.#options.overlay.before(this.#canvas);
    this.#options.subtitles.setExternalClock(true);
    await this.#initializeSubtitles();
    await this.#replaceEpoch(0);
    this.#state = 'ready';
  }

  asPrepared(): PreparedPlayback {
    const self = this, media = this.#options.media;
    const tracks: readonly PlayerTrack[] = media.tracks.map(track => ({ id: track.id, kind: track.kind, label: track.name ?? track.codec.toUpperCase(), codec: track.codec, language: track.language, channels: track.channelCount, selectable: false }));
    return {
      route: 'C1', description: [self.#videoTrack && `${self.#options.hdr10Base ? 'HDR10 base-layer ' : ''}${self.#videoTrack.codec.toUpperCase()} software`, self.#audioTrack && `${self.#audioTrack.codec.toUpperCase()} PCM`,
        self.#videoTrack && (self.#options.preferWebGpu ? 'WebGPU composition' : 'Canvas2D composition')].filter(Boolean).join(' · '), tracks,
      selectedAudio: this.#audioTrack?.id ?? null,
      selectedSubtitle: this.#subtitleTrack?.id ?? null,
      subtitleLabel: this.#subtitleTrack ? `Embedded ${this.#subtitleTrack.codec.toUpperCase()}` : null,
      get source() { return { width: self.#videoTrack?.width ?? null, height: self.#videoTrack?.height ?? null, mime: media.mimeType || media.container,
        color: self.#gpuRenderer?.options.output === 'hdr-candidate' ? 'Original decode → extended linear Display P3 HDR candidate · unverified'
          : self.#quality === 'performance' ? 'Original decode → ≤720p SDR / sRGB' : 'Original decode → SDR / sRGB',
        audio: self.#audioTrack ? `${self.#audioTrack.codec.toUpperCase()} · ${self.#audioTrack.channelCount} source channels${self.#sourceChannels > self.#audioChannels ? ' · explicit stereo index fold-down' : ' · discrete channel output'}` : 'No audio track' }; },
      get notices() { return ['Managed software candidate. Decode, draw submissions and the PCM graph are observed separately; physical output and full 60/120 gates remain unqualified.',
        ...(self.#options.hdr10Base ? [`Dolby Vision ${self.#options.hdr10Base.label} → HDR10-compatible ${self.#options.hdr10Base.mode === 'profile-101' ? 'AV1' : 'HEVC'} base layer only. Dolby Vision metadata and enhancement are not rendered.`] : []),
        ...(self.#options.preferWebGpu ? ['WebGPU presents decoded planes; bitstream decoding is still WASM. Extended linear HDR presentation does not carry static HDR10 metadata into a native media pipeline. No automatic video-output fallback.'] : []),
        'Speaker mapping and output-device routing are unverified.',
        ...(self.#sourceChannels > self.#audioChannels ? ['Explicit stereo output transform: even source channel indices average to left, odd indices average to right. This does not preserve a cinema speaker layout.'] : [])]; },
      driver: this,
      async attach() { await self.attach(); },
      async seek(seconds, signal) { await self.seek(seconds, signal); },
      setSubtitleEnabled(enabled) { self.#embeddedSubtitlesEnabled = enabled; },
      subscribeError(listener) { self.#errors.add(listener); return () => self.#errors.delete(listener); },
      async dispose() { await self.dispose(); },
    };
  }

  snapshot(): ManagedTransportSnapshot {
    const epoch = this.#epoch;
    const time = this.#clock();
    const pendingVideoBytes = epoch?.frames.reduce((total, frame) => total + frame.payload.bytes, 0) ?? 0;
    const transforms = [...(this.#options.hdr10Base ? ['HDR10-compatible base-layer pictures only'] : this.#videoTrack ? [`Original ${this.#videoTrack.codec.toUpperCase()} source pictures decoded`] : []), ...(this.#options.preferWebGpu ? ['Explicit WebGPU decoded-plane composition'] : ['Canvas2D decoded-plane composition']),
      ...(this.#quality === 'performance' ? ['Video output capped at 720p', 'PQ/BT.2020 mapped to SDR/sRGB when required', 'Subtitle raster capped at 1080p']
        : [this.#gpuRenderer?.options.output === 'hdr-candidate' ? 'Original raster · extended linear Display P3 candidate' : 'Original SDR output raster', 'Full subtitle raster']),
      ...(this.#sourceChannels > this.#audioChannels ? ['Explicit channel-index stereo fold-down'] : ['Decoded PCM channel indices retained']), 'No temporal frame dropping'];
    return Object.freeze({ state: this.#state, time, duration: this.#options.media.duration ?? 0, transforms: Object.freeze(transforms), qualityChangeAvailable: !this.#options.preferWebGpu, telemetry: {
      presentedFrames: this.#submitted, droppedFrames: 0, callbackRate: this.#rate, processingMs: this.#renderMs,
      bufferedSeconds: epoch?.pcm ? Math.max(0, Number(epoch.nextWritten) / epoch.sampleRate - time) : Math.max(0, (epoch?.frames.at(-1) ? stampTime(epoch.frames.at(-1)!) : time) - time),
      explicitBytes: this.#options.media.snapshot().cache.bytes + pendingVideoBytes + (epoch?.pcm?.transportBytes ?? 0) +
        (epoch?.videoPackets.snapshot().bytes ?? 0) + (epoch?.audioPackets.snapshot().bytes ?? 0) + (this.#preconverter?.bytes ?? 0),
    } });
  }

  diagnostics(): Readonly<Record<string, unknown>> {
    return { state: this.#state, decodedVideoFrames: this.#decoded, submittedVideoFrames: this.#submitted,
      hdr10Base: this.#options.hdr10Base ?? null,
      lateVideoSubmissions: this.#late, outsideVideoEdit: this.#outsideVideoEdit, deliberateDrops: 0, recoveries: this.#totalRecoveries, lastUnderrun: this.#lastUnderrun,
      audio: this.#epoch?.pcm?.snapshot ?? null, videoDecoder: this.#epoch?.video?.diagnostics() ?? null,
      audioDecoder: this.#epoch?.audio?.diagnostics() ?? null,
      subtitles: this.#options.subtitles.getStatus(),
      stagedPackets: this.#epoch ? { video: this.#epoch.videoPackets.snapshot(), audio: this.#epoch.audioPackets.snapshot() } : null,
      renderer: this.#gpuRenderer ? { api: 'webgpu', output: this.#gpuRenderer.options.output, referenceWhiteNits: this.#gpuRenderer.options.referenceWhiteNits,
        chromaLocation: this.#gpuRenderer.options.chromaLocation, qualification: this.#gpuRenderer.qualification }
        : { api: this.#options.preferWebGpu ? 'webgpu-pending-or-refused' : 'canvas2d', qualification: 'NOT_QUALIFIED' },
      timings: this.#trace?.summary() ?? null,
      conversion: this.#preconverter ? 'one-frame-worker-candidate' : 'inline',
      cadenceEvidence: 'Draw submissions and bounded GPU queue fences when selected; no physical-display qualification', failure: this.#failure instanceof Error ? this.#failure.message : this.#failure,
    };
  }

  async play(): Promise<void> {
    this.#ensureLive(); this.#wantPlay = true;
    if (this.#state === 'playing') return;
    if (this.#state === 'ended') await this.seek(0, this.#options.signal);
    const active = this.#epoch;
    if (!active) throw new EngineError('INVALID_ARGUMENT', 'Managed source is not ready');
    this.#state = 'rebuffering'; active.priming = true; this.#wake();
    await this.#wait(() => this.#primed(active) || !this.#wantPlay, active.abort.signal, 10_000, 'Managed resume priming');
    if (!this.#wantPlay) { active.priming = false; return; }
    if (active.pcm && !active.audioOutputEnded) {
      let event: PcmEvent;
      try { event = await active.pcm.start(); }
      catch (error) { if (!this.#wantPlay || this.#epoch !== active || active.abort.signal.aborted) return; throw error; }
      if (this.#epoch !== active || active.abort.signal.aborted) throw cancelled();
      active.anchor = { graphFrame: event.graphFrame, sample: event.nextMediaSample };
    } else this.#wallAnchor = { time: this.#logicalTime, performanceMs: performance.now() };
    if (!this.#wantPlay) { active.priming = false; await this.pause(); return; }
    active.priming = false; this.#state = 'playing'; this.#wake(); this.#schedule();
  }

  async pause(): Promise<void> {
    this.#ensureLive(); this.#wantPlay = false;
    if (this.#state === 'ended') return;
    const epoch = this.#epoch;
    this.#logicalTime = this.#clock(); this.#state = 'paused'; this.#wallAnchor = null;
    if (this.#frameRequest !== null) cancelAnimationFrame(this.#frameRequest); this.#frameRequest = null;
    if (epoch?.pcm && !epoch.audioOutputEnded) {
      const stopped = await epoch.pcm.pause();
      if (this.#epoch !== epoch || epoch.abort.signal.aborted || this.#wantPlay) return;
      epoch.frozenSample = Number(stopped); epoch.anchor = null; this.#logicalTime = epoch.frozenSample / epoch.sampleRate;
    }
    this.#wake();
  }

  async seek(seconds: number, signal: AbortSignal): Promise<void> {
    this.#ensureLive(); if (signal.aborted) throw cancelled();
    const target = Math.max(0, Math.min(seconds, this.#options.media.duration ?? seconds));
    this.#epoch?.abort.abort(); this.#wake();
    const operation = async (): Promise<void> => {
      if (signal.aborted || this.#disposed) throw cancelled();
      this.#state = 'seeking';
      if (this.#options.media.duration !== null && target === this.#options.media.duration) {
        await this.#retireEpoch();
        if (signal.aborted || this.#disposed) throw cancelled();
        this.#logicalTime = target; this.#state = 'ended'; this.#wantPlay = false;
        if (this.#subtitleKind === 'srt' && this.#embeddedSubtitlesEnabled) await this.#options.subtitles.renderAt(target);
        return;
      }
      await this.#replaceEpoch(target, signal);
      if (signal.aborted) { this.#epoch?.abort.abort(); this.#wake(); throw cancelled(); }
      this.#state = 'paused';
    };
    this.#transition = this.#transition.catch(() => undefined).then(operation);
    return this.#transition;
  }

  setVolume(value: number): void { this.#volume = value; this.#epoch?.pcm?.setVolume(value); }
  setQuality(mode: QualityMode): void {
    if (mode === this.#quality) return;
    if (this.#options.preferWebGpu) throw new EngineError('OUTPUT_UNAVAILABLE', 'Close and reopen the source to change the WebGPU output configuration.', 'caller-fix');
    if (this.#preconverter) throw new EngineError('OUTPUT_UNAVAILABLE', 'Close and reopen the test source to change the prefetched output raster.', 'caller-fix');
    const transfer = String(this.#videoTrack?.color?.transfer ?? '');
    if (mode === 'full' && ['pq', 'smpte2084', 'hlg', 'arib-std-b67'].includes(transfer)) throw new EngineError('OUTPUT_UNAVAILABLE', 'Full HDR output is not available on the managed SDR renderer.', 'caller-fix');
    this.#renderer?.setOptions({ allowSdrToneMap: mode === 'performance', ...(mode === 'performance' ? { maximumHeight: 720 } : {}) });
    this.#quality = mode;
  }

  async #initializeSubtitles(): Promise<void> {
    const subtitle = this.#subtitleTrack, kind = this.#subtitleKind; if (!subtitle || !kind) return;
    await this.#options.subtitles.load({ kind, streaming: true, data: kind === 'srt' ? '' : new TextDecoder().decode(subtitle.codecPrivate), label: subtitle.name ?? subtitle.codec,
      ...(kind === 'srt' ? {} : { fonts: this.#options.media.attachments.filter(font => /\.(ttf|otf|woff2?)$/i.test(font.name) || /font|truetype|opentype/i.test(font.mimeType)).map(font => ({ name: font.name, data: font.data })) }) });
    await this.#options.subtitles.setQuality(this.#quality);
  }

  async #replaceEpoch(target: number, operationSignal?: AbortSignal): Promise<void> {
    await this.#retireEpoch();
    this.#ensureLive();
    if (this.#options.signal.aborted || operationSignal?.aborted) throw cancelled();
    const id = ++this.#epochId, rate = this.#audioTrack?.sampleRate ?? 48000;
    const firstSample = BigInt(Math.floor(target * rate));
    // With one additionally held demux packet, these limits remain within the
    // source's 128-item / 64 MiB packet ledger even at its largest admitted item.
    const epoch: Epoch = { id, abort: new AbortController(), target, firstSample, frames: [], tasks: [],
      videoPackets: new PacketStage(56, 16 * 1024 * 1024), audioPackets: new PacketStage(64, 4 * 1024 * 1024),
      video: null, audio: null, pcm: null, preroll: null, videoPrimed: !this.#videoTrack, audioPrimed: !this.#audioTrack,
      videoEos: !this.#videoTrack, audioEos: !this.#audioTrack, audioOutputEnded: !this.#audioTrack, sourceEos: false, priming: true, sampleRate: rate, anchor: null,
      frozenSample: Number(firstSample), nextWritten: firstSample, nextDecoded: firstSample, pendingPcm: null, pendingFrames: 0, prefetched: null };
    this.#epoch = epoch; this.#logicalTime = target; this.#wallAnchor = null;
    const cancelOperation = (): void => { epoch.abort.abort(); this.#wake(); };
    operationSignal?.addEventListener('abort', cancelOperation, { once: true });
    const stamp = sessionStamp(this.#options.media.stamp.sessionId, id);
    try {
      if (this.#subtitleTrack && this.#embeddedSubtitlesEnabled) await this.#options.subtitles.resetStream(id, target);
      if (this.#videoTrack) {
        const track = this.#videoTrack;
        if (!track.width || !track.height) throw new EngineError('INVALID_PACKET', 'Software video source dimensions are missing');
        const options = { width: track.width, height: track.height, description: track.codecPrivate, stamp, assetBaseUrl: this.#options.assetBaseUrl };
        // The retained four-thread pixel failure is not a container admission rule.
        if (track.codec === 'av1' && !this.#options.portableAv1 && globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined') {
          epoch.video = await Av1Decoder.create({ ...options, threads: 1, outputFrames: 8 });
        } else {
          epoch.video = await PortableDecoder.create({ ...options, kind: 'video', codec: track.codec, color: track.color });
        }
      }
      if (this.#audioTrack) {
        const count = this.#audioTrack.channelCount;
        if (!count || count > 8 || !this.#audioTrack.sampleRate) throw new EngineError('UNSUPPORTED_PROFILE', 'Software audio channel count or sample rate is unavailable');
        const labels = Array.from({ length: count }, (_, index) => `channel-${index + 1}`);
        const stereoAllowed = this.#options.allowStereoFoldDown && count > 2;
        const stereoFallback = stereoAllowed && this.#options.stereoFallbackOnly;
        const borrowedContext = this.#options.contextForPcm?.(rate);
        epoch.pcm = await PcmOutput.create({ sampleRate: rate, channelLabels: stereoAllowed && !stereoFallback ? stereoLabels : labels,
          ...(stereoFallback ? { stereoFallbackLabels: stereoLabels } : {}),
          ...(borrowedContext ? { borrowedContext } : {}),
          firstMediaSample: firstSample, blockFrames: Math.round(rate / 50), poolBlocks: 48, primeMs: 240, onEvent: event => this.#audioEvent(epoch, event) });
        this.#sourceChannels = count;
        this.#audioChannels = epoch.pcm.config.channels;
        epoch.pcm.setVolume(this.#volume);
        epoch.pendingPcm = new Float32Array(epoch.pcm.config.blockFrames * this.#audioChannels);
        const resolution = this.#options.media.audioTimestampResolutionSeconds;
        epoch.audio = this.#audioTrack.codec === 'truehd'
          ? await TrueHdDecoder.create({ sampleRate: rate, channelLabels: labels, stamp, outputFrames: 8, assetBaseUrl: this.#options.assetBaseUrl, timestampResolutionSeconds: resolution })
          : await PortableDecoder.create({ kind: 'audio', codec: this.#audioTrack.codec, channels: count, sampleRate: rate,
            stamp, description: this.#audioTrack.codecPrivate, assetBaseUrl: this.#options.assetBaseUrl,
            timestampToleranceSamples: Math.ceil(resolution * rate), endSample: this.#audioTrack.audioEndSample ?? null });
      }
      if (epoch.abort.signal.aborted || this.#options.signal.aborted) throw cancelled();
      const trackTask = (task: Promise<void>): void => {
        epoch.tasks.push(task);
        void task.catch(error => { if (!epoch.abort.signal.aborted && this.#epoch === epoch) this.#fail(error); });
      };
      if (epoch.video) { trackTask(this.#consumeVideo(epoch)); trackTask(this.#feed(epoch, epoch.videoPackets, epoch.video, 'video')); }
      if (epoch.audio) { trackTask(this.#consumeAudio(epoch)); trackTask(this.#feed(epoch, epoch.audioPackets, epoch.audio, 'audio')); }
      trackTask(this.#produce(epoch));
      await this.#wait(() => this.#primed(epoch), epoch.abort.signal, 15_000, 'Managed source priming');
      epoch.priming = false;
      const first = epoch.frames[0];
      if (first) { const pixels = first.payload.borrow(); await this.#drawVideo(pixels, epoch); await this.#options.subtitles.renderAt(target, pixels.visibleRect.width, pixels.visibleRect.height); }
      this.#prefetch(epoch);
      this.#wake();
    } catch (error) { epoch.abort.abort(); this.#wake(); await this.#retireEpoch(); throw error; }
    finally { operationSignal?.removeEventListener('abort', cancelOperation); }
  }

  #primed(epoch: Epoch): boolean {
    const audio = !epoch.pcm || epoch.audioOutputEnded || Number(epoch.nextWritten - epoch.firstSample) >= epoch.pcm.config.primeFrames || (epoch.audioEos && epoch.nextWritten > epoch.firstSample);
    return epoch.videoPrimed && audio;
  }

  async #produce(epoch: Epoch): Promise<void> {
    const tracks = [this.#videoTrack, this.#audioTrack, this.#embeddedSubtitlesEnabled ? this.#subtitleTrack : undefined].filter((track): track is MediaTrack => Boolean(track));
    const stamp = sessionStamp(this.#options.media.stamp.sessionId, epoch.id);
    let requested = this.#trace ? performance.now() : 0;
    const base = this.#options.hdr10Base?.mode;
    const hevc = this.#videoTrack?.codec === 'hevc' ? { trackId: this.#videoTrack.id, mode: base === 'profile-7' || base === 'profile-81' ? base : 'ordinary' as const } : null;
    for await (const packet of this.#options.media.packets(tracks.map(track => track.id), { startTime: epoch.target, signal: epoch.abort.signal, stamp, ...(hevc ? { hevc } : {}) })) {
      this.#trace?.add('sourcePacketWait', performance.now() - requested);
      let staged = false;
      try {
        await this.#waitForActive(epoch);
        if (packet.discardPaddingNs !== 0n && (packet.trackId !== this.#audioTrack?.id || this.#audioTrack.codec === 'truehd')) throw new EngineError('UNSUPPORTED_PROFILE', 'Selected-track discard padding requires an admitted audio trim');
        if (packet.trackId === this.#subtitleTrack?.id) {
          const timing = packetSeconds(packet);
          if (this.#embeddedSubtitlesEnabled && this.#subtitleKind) await this.#options.subtitles.addPacket({ kind: this.#subtitleKind, data: packet.bytes.borrow(), ptsSeconds: timing.timestamp, durationSeconds: timing.duration, epoch: epoch.id });
        } else {
          const stage = packet.trackId === this.#videoTrack?.id ? epoch.videoPackets : epoch.audioPackets;
          const bytes = packet.bytes.bytes;
          await this.#wait(() => stage.canEnqueue(bytes), epoch.abort.signal, null, 'Compressed track staging');
          stage.enqueue(packet, bytes, () => packet.bytes.release()); staged = true;
          this.#wake();
        }
      } finally { if (!staged) packet.bytes.release(); if (this.#trace) requested = performance.now(); }
    }
    epoch.sourceEos = true;
    this.#wake();
  }

  async #feed(epoch: Epoch, stage: PacketStage<EncodedPacket>, decoder: Pick<Decoder<VideoPixels>, 'trySubmit' | 'flushEndOfStream'>, kind: 'video' | 'audio'): Promise<void> {
    for (;;) {
      const waiting = this.#trace ? performance.now() : 0;
      await this.#wait(() => (!stage.empty && this.#active(epoch)) || (epoch.sourceEos && stage.empty), epoch.abort.signal, null, `${kind} input`);
      this.#trace?.add(kind === 'video' ? 'videoPacketQueueWait' : 'audioPacketQueueWait', performance.now() - waiting);
      const item = stage.take();
      if (!item) break;
      try {
        if (kind === 'video') await this.#wait(() => epoch.frames.length < 6 && this.#active(epoch), epoch.abort.signal, null, 'Video queue capacity');
        const submitted = this.#trace ? performance.now() : 0;
        await this.#submit(decoder, item.value, epoch);
        this.#trace?.add(kind === 'video' ? 'videoInputConsumed' : 'audioInputConsumed', performance.now() - submitted);
      } finally { item.release(); this.#wake(); }
    }
    await decoder.flushEndOfStream(this.#op(epoch, `${kind}-eos`, 15_000));
  }

  async #submit(decoder: Pick<Decoder<VideoPixels>, 'trySubmit'>, packet: EncodedPacket, epoch: Epoch): Promise<void> {
    for (;;) {
      if (epoch.abort.signal.aborted) throw cancelled();
      const result = decoder.trySubmit(packet, this.#op(epoch, 'decode', 10_000));
      if (result.status === 'rejected') throw result.error;
      if (result.status === 'accepted') { await result.inputConsumed; return; }
      await this.#change(epoch.abort.signal, 20);
    }
  }

  async #consumeVideo(epoch: Epoch): Promise<void> {
    const decoder = epoch.video!;
    for (;;) {
      await this.#waitForActive(epoch);
      await this.#wait(() => epoch.frames.length < 6, epoch.abort.signal, null, 'Video presentation queue');
      let output: Frame | null;
      const waiting = this.#trace ? performance.now() : 0;
      try { output = await decoder.readOutput(this.#op(epoch, 'video-output', 15_000)); }
      catch (error) { if (error instanceof EngineError && error.code === 'DEADLINE_EXCEEDED' && !this.#active(epoch)) continue; throw error; }
      this.#trace?.add('videoOutputWait', performance.now() - waiting);
      if (!output) {
        if (epoch.preroll) { epoch.frames.push(epoch.preroll); epoch.preroll = null; epoch.videoPrimed = true; }
        epoch.videoEos = true; this.#wake(); return;
      }
      if (epoch.abort.signal.aborted) { output.payload.release(); throw cancelled(); }
      if (this.#options.hdr10Base) {
        const frame = output.payload.borrow(), signal = frame.signalMetadata;
        const decodedAs = (field: { readonly state: string; readonly origin?: string; readonly value?: string } | undefined, wanted: string) =>
          field?.state === 'known' && field.origin === 'decoder' && field.value === wanted;
        if (frame.format !== 'I420P10' || !decodedAs(signal?.primaries, 'bt2020') || !decodedAs(signal?.transfer, 'smpte2084') ||
            !decodedAs(signal?.matrix, 'bt2020-ncl') || !decodedAs(signal?.range, 'limited')) {
          output.payload.release();
          throw new EngineError('UNSUPPORTED_PROFILE', 'The decoded Dolby Vision base did not confirm limited-range 10-bit BT.2020 PQ. No source-color guess was used.');
        }
      }
      this.#decoded++;
      if (this.#videoEditEnd && compareTime(output.pts, this.#videoEditEnd) >= 0) {
        this.#outsideVideoEdit++;
        output.payload.release();
        continue;
      }
      const time = stampTime(output);
      if (!epoch.videoPrimed) {
        if (time <= epoch.target) { epoch.preroll?.payload.release(); epoch.preroll = output; continue; }
        if (epoch.preroll) { epoch.frames.push(epoch.preroll); epoch.preroll = null; }
        else if (time - epoch.target > .1) { output.payload.release(); throw new EngineError('UNSUPPORTED_PROFILE', 'No decoded picture covers the requested seek target'); }
        epoch.videoPrimed = true;
      }
      epoch.frames.push(output); this.#wake();
    }
  }

  async #consumeAudio(epoch: Epoch): Promise<void> {
    const decoder = epoch.audio!, pcm = epoch.pcm!;
    for (;;) {
      await this.#waitForActive(epoch);
      let output: OwnedOutput<AudioPCM> | OwnedOutput<IntegerAudioPCM> | null;
      const waiting = this.#trace ? performance.now() : 0;
      try { output = await decoder.readOutput(this.#op(epoch, 'audio-output', 15_000)); }
      catch (error) { if (error instanceof EngineError && error.code === 'DEADLINE_EXCEEDED' && !this.#active(epoch)) continue; throw error; }
      this.#trace?.add('audioOutputWait', performance.now() - waiting);
      if (!output) { await this.#flushPcm(epoch); epoch.audioEos = true; await pcm.end(epoch.nextWritten); this.#wake(); return; }
      try {
        const audio = output.payload.borrow();
        if (audio.sampleRate !== epoch.sampleRate || (audio.format !== 's32-interleaved' && audio.format !== 'f32-interleaved')) throw new EngineError('UNSUPPORTED_PROFILE', 'Managed audio configuration changed');
        if (output.pts.timeBase.numerator !== 1n || output.pts.timeBase.denominator !== BigInt(epoch.sampleRate) ||
            !Number.isSafeInteger(Number(output.pts.ticks))) throw new EngineError('UNSUPPORTED_PROFILE', 'Managed audio needs an admitted exact sample position');
        const start = Number(output.pts.ticks);
        const trim = Math.max(0, Number(epoch.nextDecoded) - start);
        if (trim >= audio.frames) continue;
        if (start + trim !== Number(epoch.nextDecoded)) throw new EngineError('UNSUPPORTED_PROFILE', 'Audio sample gap cannot be silently filled');
        const interleaved = audio.format === 's32-interleaved' ? integerPcmToFloat(audio) : audio.planes[0]!;
        if (!(interleaved instanceof Float32Array)) throw new EngineError('INVALID_PACKET', 'Managed audio expected float32 output storage');
        const samples = this.#audioChannels === audio.channelLabels.length ? interleaved : stereoIndexFold(interleaved, audio.channelLabels.length);
        for (let offset = trim; offset < audio.frames;) {
          if (epoch.abort.signal.aborted) throw cancelled();
          const frames = Math.min(pcm.config.blockFrames - epoch.pendingFrames, audio.frames - offset);
          const block = samples.subarray(offset * this.#audioChannels, (offset + frames) * this.#audioChannels);
          epoch.pendingPcm!.set(block, epoch.pendingFrames * this.#audioChannels);
          epoch.pendingFrames += frames; epoch.nextDecoded += BigInt(frames); offset += frames;
          if (epoch.pendingFrames === pcm.config.blockFrames) await this.#flushPcm(epoch);
        }
      } finally { output.payload.release(); }
    }
  }

  async #flushPcm(epoch: Epoch): Promise<void> {
    if (!epoch.pendingFrames || !epoch.pcm || !epoch.pendingPcm) return;
    const frames = epoch.pendingFrames, pcm = epoch.pcm;
    const block = epoch.pendingPcm.subarray(0, frames * this.#audioChannels);
    while (!pcm.tryWrite(block, epoch.nextWritten, frames)) {
      await this.#waitForActive(epoch);
      try { await pcm.waitForCapacity(epoch.abort.signal); }
      catch (error) { if (!this.#active(epoch) && !epoch.abort.signal.aborted) continue; throw error; }
    }
    epoch.nextWritten += BigInt(frames); epoch.pendingFrames = 0;
    epoch.audioPrimed = true; this.#wake();
  }

  #audioEvent(epoch: Epoch, event: PcmEvent): void {
    if (this.#epoch !== epoch || epoch.abort.signal.aborted) return;
    if (event.type === 'progress' || event.type === 'paused') epoch.frozenSample = event.nextMediaSample;
    if (event.type === 'ended') {
      epoch.audioOutputEnded = true;
      epoch.frozenSample = event.nextMediaSample; epoch.anchor = null;
      this.#logicalTime = Math.max(this.#logicalTime, event.nextMediaSample / epoch.sampleRate);
      // A genuinely completed soundtrack may have a video-only tail. Anchor
      // that tail to the exact final media sample, never to an underrun.
      this.#wallAnchor = { time: this.#logicalTime, performanceMs: performance.now() };
      this.#finishIfEnded();
    }
    if (event.type === 'underrun') {
      this.#lastUnderrun = Object.freeze({ mediaSample: event.nextMediaSample, graphFrame: event.graphFrame,
        writtenSample: Number(epoch.nextWritten), decodedSample: Number(epoch.nextDecoded), waitingPictures: epoch.frames.length,
        videoPackets: epoch.videoPackets.snapshot(), audioPackets: epoch.audioPackets.snapshot(), sourceEos: epoch.sourceEos });
      epoch.frozenSample = event.nextMediaSample; epoch.anchor = null; this.#logicalTime = event.nextMediaSample / epoch.sampleRate;
      this.#state = 'rebuffering'; epoch.abort.abort(); this.#wake();
      const now = performance.now(); this.#recoveryTimes = this.#recoveryTimes.filter(at => now - at < 30_000);
      if (this.#recoveryTimes.length >= 2 || this.#totalRecoveries >= 6) { this.#fail(new EngineError('BACKPRESSURE', 'Managed audio underrun recovery budget exhausted')); return; }
      this.#recoveryTimes.push(now); this.#totalRecoveries++;
      const target = this.#logicalTime;
      const recovery = async (): Promise<void> => {
        if (this.#epoch !== epoch || this.#disposed) return;
        await this.#replaceEpoch(target);
        if (this.#wantPlay) await this.play(); else this.#state = 'paused';
      };
      this.#transition = this.#transition.catch(() => undefined).then(recovery);
      void this.#transition.catch(error => this.#fail(error));
    }
    if (event.type === 'error' || event.type === 'rejected') this.#fail(new EngineError('OUTPUT_UNAVAILABLE', event.reason ?? 'PCM output failed'));
    this.#wake();
  }

  #clock(): number {
    const epoch = this.#epoch;
    if (this.#state !== 'playing') return this.#logicalTime;
    if (epoch?.pcm && epoch.anchor) {
      const graphFrame = Math.floor(epoch.pcm.context.currentTime * epoch.sampleRate);
      const next = epoch.anchor.sample + Math.max(0, graphFrame - epoch.anchor.graphFrame);
      return Math.max(this.#logicalTime, Math.min(next, Number(epoch.nextWritten)) / epoch.sampleRate);
    }
    if (this.#wallAnchor) {
      const time = this.#wallAnchor.time + (performance.now() - this.#wallAnchor.performanceMs) / 1000;
      return Math.min(time, this.#options.media.duration ?? time);
    }
    return this.#logicalTime;
  }
  #schedule(): void {
    if (this.#frameRequest !== null || this.#disposed || this.#state !== 'playing') return;
    this.#frameRequest = requestAnimationFrame(() => {
      this.#frameRequest = null;
      const epoch = this.#epoch, task = this.#present(); this.#renderTask = task;
      void task.catch(error => {
        if (this.#epoch === epoch && !epoch?.abort.signal.aborted) this.#fail(error);
      }).finally(() => { if (this.#renderTask === task) this.#renderTask = null; });
    });
  }
  async #drawVideo(pixels: VideoPixels, epoch: Epoch): Promise<number> {
    if (epoch.abort.signal.aborted) throw cancelled();
    if (this.#renderer) {
      const rendered = this.#renderer.present(pixels);
      this.#trace?.add('colorConversion', rendered.conversionMs);
      this.#trace?.add('canvasUpload', rendered.uploadMs);
      return rendered.cpuMs;
    }
    const options = managedGpuOptions(pixels, this.#quality);
    if (!this.#gpuRenderer) {
      let candidate: WebGpuRawRenderer;
      try { candidate = await WebGpuRawRenderer.create(this.#canvas, options); }
      catch (error) { throw new EngineError('OUTPUT_UNAVAILABLE', `WebGPU output was refused: ${error instanceof Error ? error.message : String(error)}. No fallback was selected.`, 'caller-fix'); }
      if (this.#disposed || epoch.abort.signal.aborted) { await candidate.dispose(); throw cancelled(); }
      this.#gpuRenderer = candidate;
    }
    if (epoch.abort.signal.aborted) throw cancelled();
    const renderer = this.#gpuRenderer;
    if (options.output !== renderer.options.output || options.chromaLocation !== renderer.options.chromaLocation) {
      throw new EngineError('UNSUPPORTED_PROFILE', 'WebGPU output type or chroma siting changed; a new output session is required.', 'caller-fix');
    }
    const started = performance.now();
    renderer.device.pushErrorScope('validation');
    let validation: Promise<GPUError | null>;
    try { renderer.present(pixels); }
    finally { validation = renderer.device.popErrorScope(); void validation.catch(() => undefined); }
    const submitted = performance.now() - started;
    // Never let CPU draw submissions accumulate unboundedly in the GPU queue.
    const [gpuError] = await finite(Promise.all([validation, renderer.device.queue.onSubmittedWorkDone()]), 2_000, 'WebGPU draw validation/completion');
    if (gpuError) throw new EngineError('OUTPUT_UNAVAILABLE', `WebGPU draw validation failed: ${gpuError.message}`);
    if (epoch.abort.signal.aborted) throw cancelled();
    return submitted;
  }
  #prefetch(epoch: Epoch): void {
    const next = epoch.frames[0];
    if (!this.#preconverter || !next || epoch.prefetched || epoch.abort.signal.aborted) return;
    const result = this.#preconverter.prepare(next.payload.borrow(), this.#quality === 'performance'
      ? { allowSdrToneMap: true, maximumHeight: 720 } : {}, epoch.abort.signal);
    epoch.prefetched = { frame: next, result };
    void result.catch(() => undefined); // observed on submission or epoch retirement
  }
  async #present(): Promise<void> {
    if (this.#rendering || this.#state !== 'playing' || !this.#epoch) return;
    this.#rendering = true;
    const epoch = this.#epoch;
    let complete = false;
    try {
      const mediaTime = this.#clock();
      const containerTimedText = this.#subtitleKind === 'srt' && this.#embeddedSubtitlesEnabled;
      let subtitleWidth: number | undefined, subtitleHeight: number | undefined;
      // Every eligible output is submitted. Multiple submissions in one display
      // interval do not establish distinct physical presentations.
      while (epoch.frames[0] && stampTime(epoch.frames[0]) <= mediaTime + .001) {
        const frame = epoch.frames.shift()!;
        let retained = false;
        try {
          const pts = stampTime(frame);
          const pixels = frame.payload.borrow();
          const prefetch = epoch.prefetched;
          if (prefetch && prefetch.frame === frame && this.#renderer) {
            epoch.prefetched = null;
            const lease = await prefetch.result;
            try {
              if (epoch.abort.signal.aborted) throw cancelled();
              // Pause may complete while the worker is still preparing the
              // raster. Return ownership to the queue without painting it.
              if (this.#state !== 'playing') {
                epoch.frames.unshift(frame); epoch.prefetched = prefetch; retained = true;
                return;
              }
              const rgba = lease.borrow();
              this.#renderMs = this.#renderer.presentConverted(rgba);
              this.#trace?.add('workerColorConversion', rgba.conversionMs);
              this.#trace?.add('canvasUpload', this.#renderMs);
            } finally { if (!retained) lease.release(); }
          } else this.#renderMs = await this.#drawVideo(pixels, epoch);
          this.#prefetch(epoch);
          const subtitleStarted = this.#trace ? performance.now() : 0;
          if (containerTimedText) { subtitleWidth = pixels.visibleRect.width; subtitleHeight = pixels.visibleRect.height; }
          else await this.#options.subtitles.renderAt(pts, pixels.visibleRect.width, pixels.visibleRect.height);
          this.#trace?.add('subtitleRender', performance.now() - subtitleStarted);
          this.#trace?.add('combinedSubmissionLateness', Math.max(0, (this.#clock() - pts) * 1000));
          this.#submitted++; if (mediaTime - pts > .02) this.#late++;
        } finally { if (!retained) frame.payload.release(); }
        if (epoch.abort.signal.aborted || this.#epoch !== epoch || this.#state !== 'playing') return;
        this.#wake();
      }
      if (containerTimedText) await this.#options.subtitles.renderAt(this.#clock(), subtitleWidth, subtitleHeight);
      // AudioWorklet can finish while a draw awaits subtitles or GPU work.
      // Never overwrite that newer final-sample anchor with this draw's tick.
      this.#logicalTime = Math.max(this.#logicalTime, mediaTime);
      const now = performance.now();
      this.#prefetch(epoch);
      if (now - this.#lastRateAt >= 1000) { this.#rate = (this.#submitted - this.#lastRateFrames) * 1000 / (now - this.#lastRateAt); this.#lastRateFrames = this.#submitted; this.#lastRateAt = now; }
      complete = true;
    } finally {
      this.#rendering = false;
      if (complete) this.#finishIfEnded();
      this.#schedule();
    }
  }
  #finishIfEnded(): void {
    const epoch = this.#epoch; if (!epoch || this.#rendering || this.#state !== 'playing') return;
    if (epoch.videoEos && !epoch.frames.length && epoch.audioOutputEnded) {
      this.#state = 'ended'; this.#wantPlay = false; this.#logicalTime = this.#options.media.duration ?? this.#logicalTime; this.#wake();
      if (this.#subtitleKind === 'srt' && this.#embeddedSubtitlesEnabled) void this.#options.subtitles.renderAt(this.#logicalTime)
        .catch(error => { if (this.#epoch === epoch && !epoch.abort.signal.aborted) this.#fail(error); });
    }
  }
  #active(epoch: Epoch): boolean { return epoch.priming || this.#state === 'playing' || this.#state === 'rebuffering' || this.#state === 'seeking'; }
  async #waitForActive(epoch: Epoch): Promise<void> { await this.#wait(() => this.#active(epoch), epoch.abort.signal, null, 'User playback intent'); }
  #op(epoch: Epoch, label: string, timeout: number) { return operationContext(sessionStamp(this.#options.media.stamp.sessionId, epoch.id), `${label}-${++this.#operation}`, epoch.abort.signal, timeout); }
  #wake(): void { for (const wake of [...this.#waiters]) wake(); }
  async #wait(predicate: () => boolean, signal: AbortSignal, timeout: number | null, label: string): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (signal.aborted) throw cancelled();
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); this.#waiters.delete(check); };
      const abort = (): void => { cleanup(); reject(this.#failure ?? cancelled()); };
      const check = (): void => { if (signal.aborted || this.#failure) abort(); else if (predicate()) { cleanup(); resolve(); } };
      if (timeout !== null) timer = setTimeout(() => { cleanup(); reject(new EngineError('DEADLINE_EXCEEDED', `${label} deadline elapsed`)); }, timeout);
      signal.addEventListener('abort', abort, { once: true }); this.#waiters.add(check); check();
    });
  }
  async #change(signal: AbortSignal, milliseconds: number): Promise<void> {
    if (signal.aborted) throw cancelled();
    await new Promise<void>((resolve, reject) => { const abort = (): void => { clearTimeout(timer); reject(cancelled()); }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds); signal.addEventListener('abort', abort, { once: true }); });
  }
  #fail(error: unknown): void {
    if (this.#disposed || (isCancellation(error) && this.#epoch?.abort.signal.aborted)) return;
    this.#failure ??= error; this.#state = 'failed'; this.#wantPlay = false;
    this.#epoch?.abort.abort(); this.#wake();
    void this.#epoch?.pcm?.pause().catch(() => undefined);
    for (const listener of this.#errors) listener(error);
  }
  #ensureLive(): void { if (this.#disposed) throw new EngineError('DISPOSED', 'Managed playback is disposed'); if (this.#failure) throw this.#failure; }
  async #retireEpoch(): Promise<void> {
    const epoch = this.#epoch; if (!epoch) return;
    epoch.abort.abort(); this.#wake();
    if (this.#frameRequest !== null) cancelAnimationFrame(this.#frameRequest); this.#frameRequest = null;
    this.#epoch = null;
    this.#preconverter?.cancel();
    await this.#renderTask?.catch(() => undefined);
    if (epoch.prefetched) {
      await epoch.prefetched.result.then(lease => lease.release(), () => undefined);
      epoch.prefetched = null;
    }
    for (const frame of epoch.frames) frame.payload.release(); epoch.frames.length = 0;
    epoch.preroll?.payload.release(); epoch.preroll = null;
    epoch.videoPackets.clear(); epoch.audioPackets.clear();
    await Promise.allSettled([epoch.video?.dispose(), epoch.audio?.dispose(), epoch.pcm?.dispose()]);
    await Promise.allSettled(epoch.tasks);
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true; this.#wantPlay = false;
    this.#options.signal.removeEventListener('abort', this.#abortListener);
    document.removeEventListener('visibilitychange', this.#visibilityListener);
    await this.#retireEpoch(); await this.#transition.catch(() => undefined);
    try { this.#renderer?.dispose(); await this.#gpuRenderer?.dispose(); }
    finally {
      this.#canvas.remove(); this.#options.video.style.removeProperty('visibility');
      await this.#options.media.dispose(); this.#state = 'disposed'; this.#errors.clear(); this.#wake();
    }
  }
}

/** Explicit index fold-down, not a claimed cinema speaker-layout conversion. */
export function stereoIndexFold(input: Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 3 || channels > 8 || input.length % channels) throw new EngineError('INVALID_ARGUMENT', 'Invalid stereo fold-down shape');
  const frames = input.length / channels, output = new Float32Array(frames * 2);
  const left = Math.ceil(channels / 2), right = Math.floor(channels / 2);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) output[frame * 2 + channel % 2] = output[frame * 2 + channel % 2]! + input[frame * channels + channel]! / (channel % 2 ? right : left);
  return output;
}
