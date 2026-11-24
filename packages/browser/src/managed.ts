import { EngineError, sessionStamp } from '@ubve/core';
import type { Decoder, EncodedPacket, IntegerAudioPCM, OwnedOutput, SessionState, VideoPixels } from '@ubve/core';
import { operationContext, packetSeconds } from '@ubve/io-demux';
import type { MediaSourceSession, MediaTrack } from '@ubve/io-demux';
import { Av1Decoder, TrueHdDecoder, integerPcmToFloat } from '@ubve/wasm-adapters';
import { PcmOutput, RawCanvasRenderer } from '@ubve/presentation';
import type { PcmEvent, SubtitleController } from '@ubve/presentation';
import type { ManagedTransport, ManagedTransportSnapshot, PlayerTrack, PreparedPlayback, QualityMode } from './player.js';

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
}

type Frame = OwnedOutput<VideoPixels>;
type Epoch = {
  readonly id: number;
  readonly abort: AbortController;
  readonly target: number;
  readonly firstSample: bigint;
  readonly frames: Frame[];
  readonly tasks: Promise<void>[];
  video: Av1Decoder | null;
  audio: TrueHdDecoder | null;
  pcm: PcmOutput | null;
  preroll: Frame | null;
  videoPrimed: boolean;
  audioPrimed: boolean;
  videoEos: boolean;
  audioEos: boolean;
  sourceEos: boolean;
  priming: boolean;
  sampleRate: number;
  anchor: { graphFrame: number; sample: number } | null;
  frozenSample: number;
  nextWritten: bigint;
  nextDecoded: bigint;
  pendingPcm: Float32Array | null;
  pendingFrames: number;
};

const stampTime = <T>(output: OwnedOutput<T>): number => Number(output.pts.ticks) * Number(output.pts.timeBase.numerator) / Number(output.pts.timeBase.denominator);
const cancelled = (): DOMException => new DOMException('Managed epoch was cancelled', 'AbortError');
const isCancellation = (error: unknown): boolean => (error instanceof DOMException && error.name === 'AbortError') || (error instanceof EngineError && ['CANCELLED', 'STALE_EPOCH', 'DISPOSED'].includes(error.code));

/** Actual AV1/TrueHD/ASS software candidate, paced by the PCM graph.
 * Output remains an explicitly named SDR transform and never passes an HDR gate. */
export class ManagedPlayback implements ManagedTransport {
  readonly #options: ManagedPlaybackOptions;
  readonly #videoTrack: MediaTrack | undefined;
  readonly #audioTrack: MediaTrack | undefined;
  readonly #subtitleTrack: MediaTrack | undefined;
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: RawCanvasRenderer;
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
  #renderMs = 0;
  #lastRateAt = 0;
  #lastRateFrames = 0;
  #rate: number | null = null;
  #recoveryTimes: number[] = [];
  #totalRecoveries = 0;
  #transition: Promise<void> = Promise.resolve();
  #audioChannels = 0;
  #sourceChannels = 0;
  #failure: unknown = null;
  readonly #abortListener: () => void;
  readonly #visibilityListener: () => void;

  constructor(options: ManagedPlaybackOptions) {
    this.#options = options; this.#quality = options.quality;
    const primary = (kind: MediaTrack['kind']): MediaTrack | undefined => options.media.tracks.find(t => t.kind === kind && t.default) ?? options.media.tracks.find(t => t.kind === kind);
    this.#videoTrack = primary('video'); this.#audioTrack = primary('audio'); this.#subtitleTrack = primary('subtitle');
    if (this.#videoTrack && this.#videoTrack.codec !== 'av1') throw new EngineError('UNSUPPORTED_PROFILE', `Managed ${this.#videoTrack.codec} video is not registered in this candidate.`, 'caller-fix');
    if (this.#audioTrack && this.#audioTrack.codec !== 'truehd') throw new EngineError('UNSUPPORTED_PROFILE', `Managed ${this.#audioTrack.codec} audio is not registered in this candidate.`, 'caller-fix');
    if (!this.#videoTrack && !this.#audioTrack) throw new EngineError('UNSUPPORTED_PROFILE', 'No registered managed video or audio track exists.');
    if (this.#subtitleTrack && !['ass', 'ssa'].includes(this.#subtitleTrack.codec)) throw new EngineError('UNSUPPORTED_PROFILE', `Embedded ${this.#subtitleTrack.codec} streaming is not registered in this candidate.`);
    const transfer = String(this.#videoTrack?.color?.transfer ?? '');
    const isHdr = transfer === 'pq' || transfer === 'smpte2084' || transfer === 'hlg' || transfer === 'arib-std-b67';
    if (isHdr && options.quality === 'full') throw new EngineError('OUTPUT_UNAVAILABLE', 'The managed Canvas2D output cannot preserve full HDR. Select Performance for the explicitly declared 720p SDR transform.', 'caller-fix');
    if (transfer === 'hlg' || transfer === 'arib-std-b67') throw new EngineError('UNSUPPORTED_PROFILE', 'HLG tone mapping is not admitted by the managed SDR renderer.', 'caller-fix');
    this.#canvas = document.createElement('canvas'); this.#canvas.className = 'managed-video-surface';
    this.#canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none';
    this.#canvas.setAttribute('aria-label', 'Managed video presentation');
    this.#renderer = new RawCanvasRenderer(this.#canvas, { allowSdrToneMap: options.quality === 'performance', ...(options.quality === 'performance' ? { maximumHeight: 720 } : {}) });
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
      route: 'C1', description: 'AV1 dav1d WASM + TrueHD PCM + subtitle composition', tracks,
      selectedAudio: this.#audioTrack?.id ?? null,
      selectedSubtitle: this.#subtitleTrack?.id ?? null,
      subtitleLabel: this.#subtitleTrack ? `Embedded ${this.#subtitleTrack.codec.toUpperCase()}` : null,
      source: { width: this.#videoTrack?.width ?? null, height: this.#videoTrack?.height ?? null, mime: media.mimeType || media.container,
        color: this.#quality === 'performance' ? 'Original decode → ≤720p SDR / sRGB' : 'Original decode → SDR / sRGB',
        audio: this.#audioTrack ? `TrueHD · ${this.#audioTrack.channelCount} source channels${this.#options.allowStereoFoldDown ? ' · explicit stereo index fold-down' : ' · discrete channel output'}` : 'No audio track' },
      notices: ['Managed software candidate. Decode, draw submissions and the PCM graph are observed separately; physical output and full 60/120 gates remain unqualified.',
        'Channel-index identity is retained. Speaker mapping and output-device routing are unverified.',
        ...(this.#options.allowStereoFoldDown ? ['Explicit stereo output transform: even source channel indices average to left, odd indices average to right. This does not preserve a cinema speaker layout.'] : [])],
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
    const transforms = ['Original AV1 source pictures decoded', ...(this.#quality === 'performance' ? ['Video output capped at 720p', 'PQ/BT.2020 mapped to SDR/sRGB when required', 'Subtitle raster capped at 1080p'] : ['Original SDR output raster', 'Full subtitle raster']),
      ...(this.#sourceChannels > this.#audioChannels ? ['Explicit channel-index stereo fold-down'] : ['Decoded PCM channel indices retained']), 'No temporal frame dropping'];
    return Object.freeze({ state: this.#state, time, duration: this.#options.media.duration ?? 0, transforms: Object.freeze(transforms), telemetry: {
      presentedFrames: this.#submitted, droppedFrames: 0, callbackRate: this.#rate, processingMs: this.#renderMs,
      bufferedSeconds: epoch?.pcm ? Math.max(0, Number(epoch.nextWritten) / epoch.sampleRate - time) : Math.max(0, (epoch?.frames.at(-1) ? stampTime(epoch.frames.at(-1)!) : time) - time),
      explicitBytes: this.#options.media.snapshot().cache.bytes + pendingVideoBytes + (epoch?.pcm?.transportBytes ?? 0),
    } });
  }

  diagnostics(): Readonly<Record<string, unknown>> {
    return { state: this.#state, decodedVideoFrames: this.#decoded, submittedVideoFrames: this.#submitted,
      lateVideoSubmissions: this.#late, deliberateDrops: 0, recoveries: this.#totalRecoveries,
      audio: this.#epoch?.pcm?.snapshot ?? null, videoDecoder: this.#epoch?.video?.diagnostics() ?? null,
      audioDecoder: this.#epoch?.audio?.diagnostics() ?? null,
      cadenceEvidence: 'Canvas submissions; no physical-display qualification', failure: this.#failure instanceof Error ? this.#failure.message : this.#failure,
    };
  }

  async play(): Promise<void> {
    this.#ensureLive(); this.#wantPlay = true;
    const epoch = this.#epoch; if (!epoch) throw new EngineError('INVALID_ARGUMENT', 'Managed source is not ready');
    if (this.#state === 'playing') return;
    if (this.#state === 'ended') await this.seek(0, this.#options.signal);
    const active = this.#epoch!;
    this.#state = 'rebuffering'; active.priming = true; this.#wake();
    await this.#wait(() => this.#primed(active) || !this.#wantPlay, active.abort.signal, 10_000, 'Managed resume priming');
    if (!this.#wantPlay) { active.priming = false; return; }
    if (active.pcm) {
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
    const epoch = this.#epoch;
    this.#logicalTime = this.#clock(); this.#state = 'paused'; this.#wallAnchor = null;
    if (this.#frameRequest !== null) cancelAnimationFrame(this.#frameRequest); this.#frameRequest = null;
    if (epoch?.pcm) { epoch.frozenSample = Number(await epoch.pcm.pause()); epoch.anchor = null; this.#logicalTime = epoch.frozenSample / epoch.sampleRate; }
    this.#wake();
  }

  async seek(seconds: number, signal: AbortSignal): Promise<void> {
    this.#ensureLive(); if (signal.aborted) throw cancelled();
    const target = Math.max(0, Math.min(seconds, this.#options.media.duration ?? seconds));
    this.#epoch?.abort.abort(); this.#wake();
    const operation = async (): Promise<void> => {
      if (signal.aborted || this.#disposed) throw cancelled();
      this.#state = 'seeking'; await this.#replaceEpoch(target);
      if (signal.aborted) { this.#epoch?.abort.abort(); this.#wake(); throw cancelled(); }
      this.#state = 'paused';
    };
    this.#transition = this.#transition.catch(() => undefined).then(operation);
    return this.#transition;
  }

  setVolume(value: number): void { this.#volume = value; this.#epoch?.pcm?.setVolume(value); }
  setQuality(mode: QualityMode): void {
    const transfer = String(this.#videoTrack?.color?.transfer ?? '');
    if (mode === 'full' && ['pq', 'smpte2084', 'hlg', 'arib-std-b67'].includes(transfer)) throw new EngineError('OUTPUT_UNAVAILABLE', 'Full HDR output is not available on the managed SDR renderer.', 'caller-fix');
    this.#renderer.setOptions({ allowSdrToneMap: mode === 'performance', ...(mode === 'performance' ? { maximumHeight: 720 } : {}) });
    this.#quality = mode;
  }

  async #initializeSubtitles(): Promise<void> {
    const subtitle = this.#subtitleTrack; if (!subtitle) return;
    await this.#options.subtitles.load({ kind: subtitle.codec as 'ass' | 'ssa', data: new TextDecoder().decode(subtitle.codecPrivate), label: subtitle.name ?? subtitle.codec,
      fonts: this.#options.media.attachments.filter(font => /\.(ttf|otf|woff2?)$/i.test(font.name) || /font|truetype|opentype/i.test(font.mimeType)).map(font => ({ name: font.name, data: font.data })) });
    await this.#options.subtitles.setQuality(this.#quality);
  }

  async #replaceEpoch(target: number): Promise<void> {
    await this.#retireEpoch();
    this.#ensureLive();
    if (this.#options.signal.aborted) throw cancelled();
    const id = ++this.#epochId, rate = this.#audioTrack?.sampleRate ?? 48000;
    const firstSample = BigInt(Math.floor(target * rate));
    const epoch: Epoch = { id, abort: new AbortController(), target, firstSample, frames: [], tasks: [],
      video: null, audio: null, pcm: null, preroll: null, videoPrimed: !this.#videoTrack, audioPrimed: !this.#audioTrack,
      videoEos: !this.#videoTrack, audioEos: !this.#audioTrack, sourceEos: false, priming: true, sampleRate: rate, anchor: null,
      frozenSample: Number(firstSample), nextWritten: firstSample, nextDecoded: firstSample, pendingPcm: null, pendingFrames: 0 };
    this.#epoch = epoch; this.#logicalTime = target; this.#wallAnchor = null;
    const stamp = sessionStamp(this.#options.media.stamp.sessionId, id);
    try {
      if (this.#subtitleTrack && this.#embeddedSubtitlesEnabled) await this.#options.subtitles.resetStream(id);
      if (this.#videoTrack) {
        const track = this.#videoTrack;
        if (!track.width || !track.height) throw new EngineError('INVALID_PACKET', 'AV1 source dimensions are missing');
        epoch.video = await Av1Decoder.create({ width: track.width, height: track.height, description: track.codecPrivate, stamp, threads: crossOriginIsolated ? 4 : 1, assetBaseUrl: this.#options.assetBaseUrl, outputFrames: 8 });
      }
      if (this.#audioTrack) {
        const count = this.#audioTrack.channelCount;
        if (!count || count > 8 || !this.#audioTrack.sampleRate) throw new EngineError('UNSUPPORTED_PROFILE', 'TrueHD channel count or sample rate is unavailable');
        const labels = Array.from({ length: count }, (_, index) => `channel-${index + 1}`);
        this.#sourceChannels = count;
        this.#audioChannels = this.#options.allowStereoFoldDown && count > 2 ? 2 : count;
        epoch.pcm = await PcmOutput.create({ sampleRate: rate, channelLabels: this.#audioChannels === count ? labels : ['fold-left', 'fold-right'],
          firstMediaSample: firstSample, blockFrames: 960, poolBlocks: 12, primeMs: 40, onEvent: event => this.#audioEvent(epoch, event) });
        epoch.pcm.setVolume(this.#volume);
        epoch.pendingPcm = new Float32Array(epoch.pcm.config.blockFrames * this.#audioChannels);
        epoch.audio = await TrueHdDecoder.create({ sampleRate: rate, channelLabels: labels, stamp, outputFrames: 8, assetBaseUrl: this.#options.assetBaseUrl,
          timestampResolutionSeconds: this.#options.media.matroska ? Number(this.#options.media.matroska.timecodeScaleNs) / 1e9 : 0 });
      }
      if (epoch.abort.signal.aborted || this.#options.signal.aborted) throw cancelled();
      const trackTask = (task: Promise<void>): void => {
        epoch.tasks.push(task);
        void task.catch(error => { if (!epoch.abort.signal.aborted && this.#epoch === epoch) this.#fail(error); });
      };
      if (epoch.video) trackTask(this.#consumeVideo(epoch));
      if (epoch.audio) trackTask(this.#consumeAudio(epoch));
      trackTask(this.#produce(epoch));
      await this.#wait(() => this.#primed(epoch), epoch.abort.signal, 15_000, 'Managed source priming');
      epoch.priming = false;
      const first = epoch.frames[0];
      if (first) { const pixels = first.payload.borrow(); this.#renderer.present(pixels); await this.#options.subtitles.renderAt(target, pixels.visibleRect.width, pixels.visibleRect.height); }
      this.#wake();
    } catch (error) { epoch.abort.abort(); this.#wake(); await this.#retireEpoch(); throw error; }
  }

  #primed(epoch: Epoch): boolean {
    const audio = !epoch.pcm || Number(epoch.nextWritten - epoch.firstSample) >= epoch.pcm.config.primeFrames || (epoch.audioEos && epoch.nextWritten > epoch.firstSample);
    return epoch.videoPrimed && audio;
  }

  async #produce(epoch: Epoch): Promise<void> {
    const tracks = [this.#videoTrack, this.#audioTrack, this.#subtitleTrack].filter((track): track is MediaTrack => Boolean(track));
    const stamp = sessionStamp(this.#options.media.stamp.sessionId, epoch.id);
    for await (const packet of this.#options.media.packets(tracks.map(track => track.id), { startTime: epoch.target, signal: epoch.abort.signal, stamp })) {
      try {
        await this.#waitForActive(epoch);
        if (packet.discardPaddingNs !== 0n) throw new EngineError('UNSUPPORTED_PROFILE', 'Selected-track discard padding requires sample-accurate trim before managed admission');
        if (packet.trackId === this.#subtitleTrack?.id) {
          const timing = packetSeconds(packet);
          if (this.#embeddedSubtitlesEnabled) await this.#options.subtitles.addPacket({ kind: this.#subtitleTrack.codec as 'ass' | 'ssa', data: packet.bytes.borrow(), ptsSeconds: timing.timestamp, durationSeconds: timing.duration, epoch: epoch.id });
        } else {
          const decoder = packet.trackId === this.#videoTrack?.id ? epoch.video : epoch.audio;
          if (!decoder) throw new EngineError('INTERNAL', 'Selected packet has no decoder');
          if (decoder === epoch.video) await this.#wait(() => epoch.frames.length < 6 && (!epoch.videoPrimed || this.#active(epoch)), epoch.abort.signal, null, 'Video queue capacity');
          await this.#submit(decoder, packet, epoch);
        }
      } finally { packet.bytes.release(); }
    }
    epoch.sourceEos = true;
    await Promise.all([epoch.video?.flushEndOfStream(this.#op(epoch, 'video-eos', 15_000)), epoch.audio?.flushEndOfStream(this.#op(epoch, 'audio-eos', 15_000))]);
    this.#wake();
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
      try { output = await decoder.readOutput(this.#op(epoch, 'video-output', 15_000)); }
      catch (error) { if (error instanceof EngineError && error.code === 'DEADLINE_EXCEEDED' && !this.#active(epoch)) continue; throw error; }
      if (!output) {
        if (epoch.preroll) { epoch.frames.push(epoch.preroll); epoch.preroll = null; epoch.videoPrimed = true; }
        epoch.videoEos = true; this.#wake(); return;
      }
      if (epoch.abort.signal.aborted) { output.payload.release(); throw cancelled(); }
      this.#decoded++;
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
      let output: OwnedOutput<IntegerAudioPCM> | null;
      try { output = await decoder.readOutput(this.#op(epoch, 'audio-output', 15_000)); }
      catch (error) { if (error instanceof EngineError && error.code === 'DEADLINE_EXCEEDED' && !this.#active(epoch)) continue; throw error; }
      if (!output) { await this.#flushPcm(epoch); epoch.audioEos = true; await pcm.end(epoch.nextWritten); this.#wake(); return; }
      try {
        const audio = output.payload.borrow();
        if (audio.sampleRate !== epoch.sampleRate || audio.format !== 's32-interleaved') throw new EngineError('UNSUPPORTED_PROFILE', 'Managed audio configuration changed');
        const start = Math.round(stampTime(output) * epoch.sampleRate);
        const trim = Math.max(0, Number(epoch.nextDecoded) - start);
        if (trim >= audio.frames) continue;
        if (start + trim !== Number(epoch.nextDecoded)) throw new EngineError('UNSUPPORTED_PROFILE', 'Audio sample gap cannot be silently filled');
        const interleaved = integerPcmToFloat(audio);
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
    if (event.type === 'ended') { epoch.frozenSample = event.nextMediaSample; epoch.anchor = null; this.#logicalTime = event.nextMediaSample / epoch.sampleRate; this.#finishIfEnded(); }
    if (event.type === 'underrun') {
      epoch.frozenSample = event.nextMediaSample; epoch.anchor = null; this.#logicalTime = event.nextMediaSample / epoch.sampleRate;
      this.#state = 'rebuffering'; epoch.abort.abort(); this.#wake();
      const now = performance.now(); this.#recoveryTimes = this.#recoveryTimes.filter(at => now - at < 30_000);
      if (this.#recoveryTimes.length >= 2 || this.#totalRecoveries >= 6) { this.#fail(new EngineError('BACKPRESSURE', 'Managed audio underrun recovery budget exhausted')); return; }
      this.#recoveryTimes.push(now); this.#totalRecoveries++;
      const target = this.#logicalTime;
      const recovery = async (): Promise<void> => { await this.#replaceEpoch(target); if (this.#wantPlay) await this.play(); else this.#state = 'paused'; };
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
    if (this.#wallAnchor) return this.#wallAnchor.time + (performance.now() - this.#wallAnchor.performanceMs) / 1000;
    return this.#logicalTime;
  }
  #schedule(): void {
    if (this.#frameRequest !== null || this.#disposed || this.#state !== 'playing') return;
    this.#frameRequest = requestAnimationFrame(() => { this.#frameRequest = null; const task = this.#present(); this.#renderTask = task; void task.catch(error => this.#fail(error)).finally(() => { if (this.#renderTask === task) this.#renderTask = null; }); });
  }
  async #present(): Promise<void> {
    if (this.#rendering || this.#state !== 'playing' || !this.#epoch) return;
    this.#rendering = true;
    const epoch = this.#epoch;
    try {
      const mediaTime = this.#clock();
      // Every eligible output is submitted. Multiple submissions in one display
      // interval do not establish distinct physical presentations.
      while (epoch.frames[0] && stampTime(epoch.frames[0]) <= mediaTime + .001) {
        const frame = epoch.frames.shift()!;
        try {
          const pts = stampTime(frame);
          const pixels = frame.payload.borrow();
          const rendered = this.#renderer.present(pixels);
          this.#renderMs = rendered.cpuMs;
          await this.#options.subtitles.renderAt(pts, pixels.visibleRect.width, pixels.visibleRect.height);
          this.#submitted++; if (mediaTime - pts > .02) this.#late++;
        } finally { frame.payload.release(); }
        if (epoch.abort.signal.aborted || this.#epoch !== epoch) return;
        this.#wake();
      }
      this.#logicalTime = mediaTime;
      const now = performance.now();
      if (now - this.#lastRateAt >= 1000) { this.#rate = (this.#submitted - this.#lastRateFrames) * 1000 / (now - this.#lastRateAt); this.#lastRateFrames = this.#submitted; this.#lastRateAt = now; }
      this.#finishIfEnded();
    } finally { this.#rendering = false; this.#schedule(); }
  }
  #finishIfEnded(): void {
    const epoch = this.#epoch; if (!epoch) return;
    if (epoch.videoEos && !epoch.frames.length && (!epoch.pcm || epoch.pcm.snapshot?.state === 'ended')) {
      this.#state = 'ended'; this.#wantPlay = false; this.#logicalTime = this.#options.media.duration ?? this.#logicalTime; this.#wake();
    }
  }
  #active(epoch: Epoch): boolean { return epoch.priming || this.#state === 'playing' || this.#state === 'rebuffering' || this.#state === 'seeking'; }
  async #waitForActive(epoch: Epoch): Promise<void> { await this.#wait(() => this.#active(epoch), epoch.abort.signal, null, 'User playback intent'); }
  #op(epoch: Epoch, label: string, timeout: number) { return operationContext(sessionStamp(this.#options.media.stamp.sessionId, epoch.id), `${label}-${++this.#operation}`, epoch.abort.signal, timeout); }
  #wake(): void { for (const wake of [...this.#waiters]) wake(); }
  async #wait(predicate: () => boolean, signal: AbortSignal, timeout: number | null, label: string): Promise<void> {
    if (signal.aborted) throw cancelled();
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); this.#waiters.delete(check); };
      const abort = (): void => { cleanup(); reject(cancelled()); };
      const check = (): void => { if (signal.aborted) abort(); else if (this.#failure) { cleanup(); reject(this.#failure); } else if (predicate()) { cleanup(); resolve(); } };
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
    await this.#renderTask?.catch(() => undefined);
    for (const frame of epoch.frames) frame.payload.release(); epoch.frames.length = 0;
    epoch.preroll?.payload.release(); epoch.preroll = null;
    await Promise.allSettled([epoch.video?.dispose(), epoch.audio?.dispose(), epoch.pcm?.dispose()]);
    await Promise.allSettled(epoch.tasks);
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true; this.#wantPlay = false;
    this.#options.signal.removeEventListener('abort', this.#abortListener);
    document.removeEventListener('visibilitychange', this.#visibilityListener);
    await this.#retireEpoch(); await this.#transition.catch(() => undefined);
    this.#renderer.dispose(); this.#canvas.remove(); this.#options.video.style.removeProperty('visibility');
    await this.#options.media.dispose(); this.#state = 'disposed'; this.#errors.clear(); this.#wake();
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
