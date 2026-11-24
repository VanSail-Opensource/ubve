import { CancellationController, EngineError, EpochController, checkOperation, mediaTime, timeBase } from '@ubve/core';
import type { OperationContext, Session, SessionSnapshot, SessionState, SourceDescriptor } from '@ubve/core';
import type { BrowserPlayer, CreatePlayer, OpenOptions } from './index.js';

/** The original injected facade remains usable by independent adapter authors. */
export const createPlayer: CreatePlayer = (options): BrowserPlayer => {
  let active: Session | null = null;
  let disposed = false;
  let opening = 0;
  let openingCancellation: CancellationController | null = null;
  const running = new Set<Promise<SessionSnapshot>>();
  const runOpen = async (source: SourceDescriptor, request: OpenOptions, pending: readonly Promise<SessionSnapshot>[]): Promise<SessionSnapshot> => {
    if (disposed) throw new EngineError('DISPOSED', 'Player is disposed', 'new-session');
    const intent = ++opening;
    openingCancellation?.abort(new EngineError('CANCELLED', 'Open was superseded'));
    const cancellation = new CancellationController();
    openingCancellation = cancellation;
    const unsubscribe = request.cancellation.subscribe(reason => cancellation.abort(reason));
    let cancelDeadline = (): void => {};
    try {
      const previous = active; active = null;
      await previous?.dispose();
      await Promise.allSettled(pending);
      const epochs = new EpochController(`session-${crypto.randomUUID()}`);
      const operation: OperationContext = { stamp: epochs.capture(), operationId: `open-${intent}`,
        deadlineMs: request.deadlineMs, cancellation: cancellation.signal };
      checkOperation(operation, options.adapters.scheduler);
      cancelDeadline = options.adapters.scheduler.at(request.deadlineMs, () => cancellation.abort(new EngineError('DEADLINE_EXCEEDED', 'Open deadline elapsed')));
      if (disposed || intent !== opening) throw new EngineError('CANCELLED', 'Open was superseded');
      const session = await options.adapters.openSession(source, operation, options.policy);
      if (disposed || intent !== opening || cancellation.signal.aborted) {
        await session.dispose();
        throw cancellation.signal.reason ?? new EngineError('CANCELLED', 'Open was superseded');
      }
      try { checkOperation(operation, options.adapters.scheduler); }
      catch (error) { await session.dispose(); throw error; }
      active = session;
      return session.snapshot();
    } finally {
      unsubscribe(); cancelDeadline();
      if (openingCancellation === cancellation) openingCancellation = null;
    }
  };
  return {
    open(source, request) {
      const task = runOpen(source, request, [...running]);
      running.add(task);
      void task.then(() => running.delete(task), () => running.delete(task));
      return task;
    },
    currentSession: () => active,
    async dispose() {
      if (disposed) return;
      disposed = true; ++opening;
      openingCancellation?.abort(new EngineError('DISPOSED', 'Player was disposed'));
      openingCancellation = null;
      const previous = active; active = null;
      await previous?.dispose();
      await Promise.allSettled([...running]);
    },
  };
};

export type QualityMode = 'full' | 'performance';
export type PlaybackRoute = 'N0' | 'N1' | 'N2' | 'N3' | 'C0' | 'C1';
export type MediaInput = File | { readonly url: string; readonly label?: string };

export interface PlayerTrack {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly label: string;
  readonly language: string | null;
  readonly codec: string | null;
  readonly channels: number | null;
  readonly selectable: boolean;
}

export interface PlayerSourceInfo {
  readonly name: string;
  readonly kind: 'local' | 'url';
  readonly bytes: number | null;
  readonly mime: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly color: string;
  readonly audio: string;
}

export interface PlayerTelemetry {
  /** Browser-observed delivery; these counters do not prove physical scanout. */
  readonly presentedFrames: number | null;
  readonly droppedFrames: number | null;
  readonly callbackRate: number | null;
  readonly processingMs: number | null;
  readonly bufferedSeconds: number;
  readonly explicitBytes: number | null;
  readonly acceleration: 'unknown';
  readonly hdrOutput: 'unverified';
}

export interface PlayerSnapshot {
  readonly sessionId: string | null;
  readonly state: SessionState | 'empty';
  readonly source: PlayerSourceInfo | null;
  readonly time: number;
  readonly duration: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly rate: number;
  readonly wantsPlayback: boolean;
  readonly quality: QualityMode;
  readonly qualityChangeAvailable: boolean;
  readonly route: PlaybackRoute | null;
  readonly routeDescription: string;
  readonly tracks: readonly PlayerTrack[];
  readonly selectedAudio: string | null;
  readonly selectedSubtitle: string | null;
  readonly subtitleLabel: string | null;
  readonly subtitleOffset: number;
  readonly requiresOverlay: boolean;
  readonly transforms: readonly string[];
  readonly telemetry: PlayerTelemetry;
  readonly gate: 'NOT_QUALIFIED';
  readonly notices: readonly string[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** A preparation owns its media resources until dispose, including failed opens. */
export interface PreparedPlayback {
  readonly route: PlaybackRoute;
  readonly description: string;
  readonly tracks: readonly PlayerTrack[];
  readonly source?: Partial<PlayerSourceInfo>;
  readonly selectedAudio?: string | null;
  readonly selectedSubtitle?: string | null;
  readonly subtitleLabel?: string | null;
  readonly notices?: readonly string[];
  readonly driver?: ManagedTransport;
  attach(video: HTMLVideoElement, signal: AbortSignal): Promise<void>;
  seek?(seconds: number, signal: AbortSignal): Promise<void>;
  selectAudio?(trackId: string, seconds: number, signal: AbortSignal): Promise<void>;
  setSubtitleEnabled?(enabled: boolean): void;
  telemetry?(): Partial<PlayerTelemetry>;
  subscribeError?(listener: (error: unknown) => void): () => void;
  dispose(): Promise<void>;
}

export interface ManagedTransportSnapshot {
  readonly state: SessionState;
  readonly time: number;
  readonly duration: number;
  readonly transforms: readonly string[];
  readonly telemetry: Partial<PlayerTelemetry>;
  readonly qualityChangeAvailable?: boolean;
}
export interface ManagedTransport {
  snapshot(): ManagedTransportSnapshot;
  play(): Promise<void>;
  pause(): Promise<void>;
  setVolume(value: number): void;
  setQuality(mode: QualityMode): void;
  diagnostics?(): Readonly<Record<string, unknown>>;
}

export type PreparePlayback = (input: MediaInput, signal: AbortSignal) => Promise<PreparedPlayback>;
export interface SubtitleAdapter {
  load(input: { kind: 'ass' | 'ssa' | 'vtt' | 'srt' | 'ttml' | 'pgs'; data: string | Uint8Array; label?: string; pgsPalette?: 'bt709-limited' | 'bt601-limited' }): Promise<void>;
  setQuality(mode: QualityMode): Promise<void> | void;
  setOffset(seconds: number): void;
  clear(): Promise<void> | void;
  getStatus(): { requiresOverlay: boolean; diagnostics?: readonly string[] };
  dispose(): Promise<void>;
}

export interface ReferencePlayerOptions {
  readonly video: HTMLVideoElement;
  readonly prepare?: PreparePlayback;
  readonly subtitles?: SubtitleAdapter;
  readonly onSnapshot?: (snapshot: PlayerSnapshot) => void;
}

const nativeDescriptions: Readonly<Record<PlaybackRoute, string>> = {
  N0: 'Browser media pipeline', N1: 'Stream-copy remux · browser media pipeline',
  N2: 'Lossless audio bridge · browser media pipeline', N3: 'Native video + managed PCM',
  C0: 'Browser decoder + custom presentation', C1: 'Managed decode + custom presentation',
};
const abortError = (): DOMException => new DOMException('Operation was superseded', 'AbortError');
const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';
const finiteTime = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;
const toMediaTime = (seconds: number) => mediaTime(BigInt(Math.round(finiteTime(seconds) * 1_000_000)), timeBase(1n, 1_000_000n));

/** Uses native currentTime as API-derived seconds; never claims recovered container ticks. */
export class ReferencePlayer {
  readonly video: HTMLVideoElement;
  readonly #prepare: PreparePlayback;
  readonly #subtitles: SubtitleAdapter | undefined;
  readonly #listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  #sessionAbort: AbortController | null = null;
  #seekAbort: AbortController | null = null;
  #transportTask: Promise<void> | null = null;
  #transportKind: 'seek' | 'audio' | null = null;
  #playAttempt: { readonly intent: number; readonly done: Promise<void> } | null = null;
  #playIntent = 0;
  #prepared: PreparedPlayback | null = null;
  #preparedErrorUnsubscribe: (() => void) | null = null;
  #epochs: EpochController | null = null;
  #generation = 0;
  readonly #openingTasks = new Set<Promise<PlayerSnapshot>>();
  #retiring: Promise<void> = Promise.resolve();
  readonly #retired = new WeakMap<PreparedPlayback, Promise<void>>();
  #disposal: Promise<void> | null = null;
  #disposed = false;
  #state: PlayerSnapshot['state'] = 'empty';
  #source: PlayerSourceInfo | null = null;
  #error: PlayerSnapshot['error'] = null;
  #quality: QualityMode = 'full';
  #subtitleLabel: string | null = null;
  #selectedSubtitle: string | null = null;
  #subtitleOffset = 0;
  #subtitleGeneration = 0;
  #selectedAudio: string | null = null;
  #desiredPlaying = false;
  #callbackId: number | null = null;
  #lastCallbackTime: number | null = null;
  #lastPresented: number | null = null;
  #callbackRate: number | null = null;
  #processingMs: number | null = null;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #events: { type: string; listener: EventListener }[] = [];

  constructor(options: ReferencePlayerOptions) {
    this.video = options.video;
    this.video.playsInline = true;
    this.video.preload = 'metadata';
    this.#prepare = options.prepare ?? prepareDirectPlayback;
    this.#subtitles = options.subtitles;
    if (options.onSnapshot) this.#listeners.add(options.onSnapshot);
    this.#listen('play', () => {
      if (this.#prepared && !this.#prepared.driver && !this.video.paused && !['seeking', 'failed', 'opening'].includes(this.#state)) this.#desiredPlaying = true;
    });
    this.#listen('playing', () => { if (this.#prepared && this.#desiredPlaying && this.#state !== 'seeking') this.#state = 'playing'; });
    this.#listen('pause', () => {
      if (this.#prepared && !this.#prepared.driver && this.video.paused && !['seeking', 'ended', 'failed', 'opening'].includes(this.#state)) {
        this.#state = 'paused'; this.#desiredPlaying = false; ++this.#playIntent;
      }
    });
    this.#listen('waiting', () => { if (this.#desiredPlaying && this.#state === 'playing') this.#state = 'rebuffering'; });
    this.#listen('ended', () => { if (this.#prepared && this.video.ended && this.#state !== 'seeking') { this.#state = 'ended'; this.#desiredPlaying = false; } });
    this.#listen('error', () => { if (this.#prepared && this.#state !== 'opening') this.#fail(mediaElementError(this.video)); });
    for (const type of ['loadedmetadata', 'durationchange', 'volumechange', 'ratechange', 'seeked']) this.#listen(type, () => {});
    this.#timer = setInterval(() => this.#emit(), 250);
    this.#emit();
  }

  #listen(type: string, callback: () => void): void {
    const listener = (): void => { if (!this.#disposed) { callback(); this.#emit(); } };
    this.video.addEventListener(type, listener);
    this.#events.push({ type, listener });
  }

  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  snapshot(): PlayerSnapshot {
    const video = this.video;
    const managed = this.#prepared?.driver?.snapshot();
    const playback = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
    let bufferedSeconds = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) bufferedSeconds = video.buffered.end(i) - video.currentTime;
    }
    const subtitleStatus = this.#subtitles?.getStatus();
    const outputSource = this.#prepared?.source;
    const source = this.#source === null ? null : Object.freeze({ ...this.#source, ...outputSource,
      width: outputSource?.width ?? (video.videoWidth || this.#source.width), height: outputSource?.height ?? (video.videoHeight || this.#source.height),
    });
    const state = this.#state === 'opening' || this.#state === 'seeking' || this.#state === 'failed' ? this.#state : managed?.state ?? this.#state;
    return Object.freeze({
      sessionId: this.#epochs?.capture().sessionId ?? null, state, source,
      time: managed?.time ?? finiteTime(video.currentTime), duration: managed?.duration ?? finiteTime(video.duration),
      volume: video.volume, muted: video.muted, rate: managed ? 1 : video.playbackRate, quality: this.#quality,
      qualityChangeAvailable: managed?.qualityChangeAvailable ?? true,
      wantsPlayback: this.#desiredPlaying && !['ended', 'failed', 'disposed'].includes(state),
      route: this.#prepared?.route ?? null,
      routeDescription: this.#prepared?.description ?? 'No source selected',
      tracks: this.#prepared?.tracks ?? [], selectedAudio: this.#selectedAudio,
      selectedSubtitle: this.#selectedSubtitle, subtitleLabel: this.#subtitleLabel,
      subtitleOffset: this.#subtitleOffset, requiresOverlay: subtitleStatus?.requiresOverlay ?? false,
      transforms: managed?.transforms ?? Object.freeze(this.#quality === 'full' ? ['Original source raster', 'Full subtitle raster', 'Browser output mapping'] :
        ['Original source decode retained', 'Subtitle raster capped at 1080p', 'No temporal frame dropping']),
      telemetry: Object.freeze({ presentedFrames: playback?.totalVideoFrames ?? this.#lastPresented,
        droppedFrames: playback?.droppedVideoFrames ?? null, callbackRate: this.#callbackRate,
        processingMs: this.#processingMs, bufferedSeconds, explicitBytes: null,
        ...this.#prepared?.telemetry?.(), ...managed?.telemetry, acceleration: 'unknown', hdrOutput: 'unverified',
      }),
      gate: 'NOT_QUALIFIED',
      notices: Object.freeze([...(this.#prepared?.notices ?? []), ...(subtitleStatus?.diagnostics ?? [])]),
      error: this.#error,
    });
  }

  open(input: MediaInput): Promise<PlayerSnapshot> {
    const pending = [...this.#openingTasks];
    const task = this.#open(input, pending);
    this.#openingTasks.add(task);
    void task.then(() => this.#openingTasks.delete(task), () => this.#openingTasks.delete(task));
    return task;
  }

  async #open(input: MediaInput, pending: readonly Promise<PlayerSnapshot>[]): Promise<PlayerSnapshot> {
    this.#assertLive();
    const sourceInfo = describeInput(input);
    const generation = ++this.#generation;
    await this.#closeSource();
    await Promise.allSettled(pending);
    if (generation !== this.#generation || this.#disposed) throw abortError();
    const controller = new AbortController();
    this.#sessionAbort = controller;
    this.#epochs = new EpochController(crypto.randomUUID());
    this.#state = 'opening'; this.#error = null; this.#desiredPlaying = false;
    this.#source = sourceInfo;
    this.#emit();
    let prepared: PreparedPlayback | null = null;
    try {
      prepared = await this.#prepare(input, controller.signal);
      if (controller.signal.aborted || generation !== this.#generation) throw abortError();
      this.#prepared = prepared;
      this.#preparedErrorUnsubscribe = prepared.subscribeError?.(error => { if (generation === this.#generation && !controller.signal.aborted) this.#fail(error); }) ?? null;
      this.#source = { ...this.#source, ...prepared.source };
      this.#selectedAudio = prepared.selectedAudio ?? prepared.tracks.find(track => track.kind === 'audio')?.id ?? null;
      this.#subtitleLabel = prepared.subtitleLabel ?? null;
      this.#selectedSubtitle = prepared.selectedSubtitle ?? null;
      await prepared.attach(this.video, controller.signal);
      if (!prepared.driver) await waitForMedia(this.video, 'loadedmetadata', () => this.video.readyState >= 1, controller.signal, 15_000);
      if (controller.signal.aborted || generation !== this.#generation) throw abortError();
      if (this.#error) throw new EngineError('OUTPUT_UNAVAILABLE', (this.#error as NonNullable<PlayerSnapshot['error']>).message);
      this.#state = 'ready';
      if (!prepared.driver) this.#beginFrameObservation();
      else prepared.driver.setVolume(this.video.muted ? 0 : this.video.volume);
      this.#emit();
      return this.snapshot();
    } catch (error) {
      if (generation === this.#generation && !this.#disposed && !isAbort(error)) this.#fail(error);
      if (generation === this.#generation && this.#prepared === prepared) {
        this.#prepared = null; controller.abort();
        this.#preparedErrorUnsubscribe?.(); this.#preparedErrorUnsubscribe = null;
        this.video.removeAttribute('src'); this.video.load();
      }
      if (prepared) await this.#retirePrepared(prepared);
      throw error;
    }
  }

  async play(): Promise<void> {
    this.#requireSource();
    if (this.#playAttempt?.intent === this.#playIntent && this.#desiredPlaying) return this.#playAttempt.done;
    const intent = ++this.#playIntent;
    this.#desiredPlaying = true;
    this.#emit();
    if (this.#transportTask) return this.#transportTask;
    return this.#resumePlayback(intent);
  }

  #resumePlayback(intent: number): Promise<void> {
    const generation = this.#generation;
    const driver = this.#prepared?.driver;
    const done = (async () => {
      try {
        if (driver) await driver.play(); else await this.video.play();
        if (generation !== this.#generation) throw abortError();
        if (intent !== this.#playIntent || !this.#desiredPlaying) return;
        if (this.#state !== 'failed') { this.#state = 'playing'; this.#emit(); }
      } catch (error) {
        if (generation !== this.#generation) throw abortError();
        if (intent !== this.#playIntent || !this.#desiredPlaying) return;
        this.#desiredPlaying = false;
        if (this.#state !== 'failed') this.#state = 'paused';
        this.#emit(); throw error;
      }
    })();
    const attempt = { intent, done }; this.#playAttempt = attempt;
    const clear = (): void => { if (this.#playAttempt === attempt) this.#playAttempt = null; };
    void done.then(clear, clear);
    return done;
  }

  async pause(): Promise<void> {
    this.#assertLive();
    const generation = this.#generation, intent = ++this.#playIntent;
    this.#desiredPlaying = false;
    // Pause the native host synchronously before an awaited managed completion
    // could outlive this source and pause a newer one.
    this.video.pause();
    this.#emit();
    if (this.#transportTask && !this.#playAttempt) return;
    await this.#prepared?.driver?.pause();
    if (generation !== this.#generation || (intent !== this.#playIntent && this.#desiredPlaying)) return;
    if (this.#prepared && !['opening', 'failed', 'ended', 'seeking'].includes(this.#state)) this.#state = 'paused';
    this.#emit();
  }

  async seek(seconds: number): Promise<void> {
    this.#requireSource();
    if (!Number.isFinite(seconds)) throw new EngineError('INVALID_ARGUMENT', 'Seek target must be finite');
    if (['paused', 'ready', 'ended'].includes(this.snapshot().state)) this.#desiredPlaying = false;
    const duration = this.snapshot().duration;
    if (duration <= 0) throw new EngineError('UNSUPPORTED_PROFILE', 'This source does not have a known seekable duration');
    const target = Math.max(0, Math.min(seconds, duration)), atEnd = target === duration;
    return this.#runTransport('seek', async (prepared, signal) => {
      await prepared.seek?.(target, signal);
      if (signal.aborted) throw abortError();
      if (!prepared.driver) {
        if (Math.abs(this.video.currentTime - target) > 0.001) this.video.currentTime = target;
        await waitForMedia(this.video, 'seeked', () => !this.video.seeking && Math.abs(this.video.currentTime - target) < 0.1, signal, 10_000);
      }
    }, atEnd);
  }

  #runTransport(kind: 'seek' | 'audio', operation: (prepared: PreparedPlayback, signal: AbortSignal) => Promise<void>, atEnd = false): Promise<void> {
    const prepared = this.#prepared!, sessionSignal = this.#sessionAbort?.signal;
    if (!sessionSignal || sessionSignal.aborted) return Promise.reject(abortError());
    if (this.#transportTask && (kind === 'audio' || this.#transportKind === 'audio')) {
      return Promise.reject(new EngineError('BACKPRESSURE', 'Wait for the active track or seek operation'));
    }
    this.#seekAbort?.abort();
    const controller = new AbortController(), signal = AbortSignal.any([sessionSignal, controller.signal]), previous = this.#transportTask;
    this.#seekAbort = controller; this.#transportKind = kind; ++this.#playIntent;
    this.#epochs?.advance(); this.#state = 'seeking';
    if (atEnd) this.#desiredPlaying = false;
    this.video.pause();
    const check = (): void => { if (signal.aborted || this.#prepared !== prepared) throw abortError(); };
    const task = (async () => {
      try {
        await previous?.catch(() => undefined); check();
        await operation(prepared, signal); check();
        if (atEnd) { this.#desiredPlaying = false; this.#state = 'ended'; }
        else for (;;) {
          const intent = this.#playIntent;
          if (this.#desiredPlaying) await this.#resumePlayback(intent); else await prepared.driver?.pause();
          check();
          if (intent !== this.#playIntent) continue;
          if (!this.#desiredPlaying && this.#state !== 'failed') this.#state = 'paused';
          break;
        }
        this.#emit();
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (!isAbort(error)) this.#fail(error);
        throw error;
      }
    })();
    this.#transportTask = task;
    this.#emit();
    const clear = (): void => {
      if (this.#transportTask === task) { this.#transportTask = null; this.#transportKind = null; this.#seekAbort = null; }
    };
    void task.then(clear, clear);
    return task;
  }

  setVolume(volume: number): void {
    this.#assertLive();
    if (!Number.isFinite(volume)) throw new EngineError('INVALID_ARGUMENT', 'Volume must be finite');
    this.video.volume = Math.max(0, Math.min(1, volume)); this.#prepared?.driver?.setVolume(this.video.muted ? 0 : this.video.volume); this.#emit();
  }
  setMuted(muted: boolean): void { this.#assertLive(); this.video.muted = muted; this.#prepared?.driver?.setVolume(muted ? 0 : this.video.volume); this.#emit(); }
  setRate(rate: number): void {
    this.#assertLive();
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new EngineError('INVALID_ARGUMENT', 'Playback rate must be between 0.25 and 4');
    if (this.#prepared?.driver && rate !== 1) throw new EngineError('UNSUPPORTED_PROFILE', 'Managed playback currently preserves the original 1× sample clock');
    this.video.playbackRate = rate; this.#emit();
  }
  async setQuality(mode: QualityMode): Promise<void> {
    this.#assertLive(); this.#prepared?.driver?.setQuality(mode); await this.#subtitles?.setQuality(mode); this.#quality = mode; this.#emit();
  }
  async selectAudio(trackId: string): Promise<void> {
    this.#requireSource();
    if (!this.#prepared?.selectAudio || !this.#sessionAbort) throw new EngineError('UNSUPPORTED_CODEC', 'Audio-track switching is unavailable for this route');
    if (trackId === this.#selectedAudio) return;
    if (!this.#prepared.tracks.some(track => track.id === trackId && track.kind === 'audio' && track.selectable)) {
      throw new EngineError('UNSUPPORTED_PROFILE', 'The selected audio track is not switchable on this route');
    }
    const time = this.snapshot().time;
    return this.#runTransport('audio', async (prepared, signal) => {
      await prepared.selectAudio!(trackId, time, signal);
      if (signal.aborted) throw abortError();
      this.#selectedAudio = trackId;
    });
  }
  async loadSubtitle(file: File, options: { readonly pgsPalette?: 'bt709-limited' | 'bt601-limited' } = {}): Promise<void> {
    this.#requireSource();
    if (!this.#subtitles) throw new EngineError('UNSUPPORTED_CODEC', 'Subtitle renderer is unavailable');
    if (file.size > 16 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'Subtitle file exceeds the 16 MiB safety limit');
    const extension = file.name.split('.').pop()?.toLowerCase();
    const kind = extension === 'xml' || extension === 'dfxp' ? 'ttml' : extension === 'sup' ? 'pgs' : extension;
    if (kind !== 'ass' && kind !== 'ssa' && kind !== 'vtt' && kind !== 'srt' && kind !== 'ttml' && kind !== 'pgs') throw new EngineError('UNSUPPORTED_CODEC', 'Use an ASS, SSA, WebVTT, SRT, TTML or PGS subtitle file');
    const generation = ++this.#subtitleGeneration;
    const sessionGeneration = this.#generation;
    const data = new Uint8Array(await file.arrayBuffer());
    if (generation !== this.#subtitleGeneration || sessionGeneration !== this.#generation) throw abortError();
    this.#prepared?.setSubtitleEnabled?.(false);
    await this.#subtitles.load({ kind, data, label: file.name, ...options });
    if (generation !== this.#subtitleGeneration || sessionGeneration !== this.#generation) throw abortError();
    this.#subtitleLabel = file.name; this.#selectedSubtitle = 'external'; this.#emit();
  }
  async clearSubtitle(): Promise<void> {
    const generation = ++this.#subtitleGeneration;
    this.#prepared?.setSubtitleEnabled?.(false);
    await this.#subtitles?.clear();
    if (generation !== this.#subtitleGeneration) return;
    this.#subtitleLabel = null; this.#selectedSubtitle = null; this.#emit();
  }
  setSubtitleOffset(seconds: number): void {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 3600) throw new EngineError('INVALID_ARGUMENT', 'Subtitle offset must be within one hour');
    this.#subtitleOffset = seconds; this.#subtitles?.setOffset(seconds); this.#emit();
  }

  coreSnapshot(): SessionSnapshot | null {
    const current = this.snapshot();
    if (!this.#epochs || current.state === 'empty') return null;
    return Object.freeze({ stamp: this.#epochs.capture(), state: current.state,
      mediaTime: toMediaTime(current.time), duration: toMediaTime(current.duration),
      error: this.#error ? new EngineError('INTERNAL', this.#error.message) : null,
    });
  }

  diagnostics(): Readonly<Record<string, unknown>> { return { snapshot: this.snapshot(), managed: this.#prepared?.driver?.diagnostics?.() ?? null }; }

  /** Adapter error boundary for asynchronous presentation failures. */
  reportOutputFailure(error: unknown): void { if (!this.#disposed && this.#prepared) this.#fail(error); }

  async close(): Promise<void> {
    this.#assertLive(); const generation = ++this.#generation, pending = [...this.#openingTasks];
    await this.#closeSource();
    await Promise.allSettled(pending);
    if (generation === this.#generation && !this.#disposed) { this.#state = 'empty'; this.#source = null; this.#error = null; this.#emit(); }
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true; ++this.#generation;
    clearInterval(this.#timer);
    for (const { type, listener } of this.#events) this.video.removeEventListener(type, listener);
    this.#disposal = (async () => {
      await this.#closeSource();
      await Promise.allSettled([...this.#openingTasks]);
      await this.#subtitles?.dispose();
      this.#state = 'disposed'; this.#emit(); this.#listeners.clear();
    })();
    return this.#disposal;
  }

  async #closeSource(): Promise<void> {
    this.#sessionAbort?.abort(); this.#sessionAbort = null;
    this.#seekAbort?.abort(); this.#seekAbort = null;
    this.#epochs?.dispose(); this.#epochs = null;
    this.#desiredPlaying = false; ++this.#playIntent;
    if (this.#callbackId !== null) this.video.cancelVideoFrameCallback(this.#callbackId);
    this.#callbackId = null; this.#lastCallbackTime = null; this.#lastPresented = null; this.#callbackRate = null; this.#processingMs = null;
    const prepared = this.#prepared; this.#prepared = null;
    const transport = this.#transportTask;
    this.#transportTask = null; this.#transportKind = null;
    this.#preparedErrorUnsubscribe?.(); this.#preparedErrorUnsubscribe = null;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    this.#selectedAudio = null;
    this.#retiring = this.#retiring.then(async () => {
      await transport?.catch(() => undefined);
      try { if (prepared) await this.#retirePrepared(prepared); }
      finally { await this.clearSubtitle(); }
    });
    await this.#retiring;
  }
  #retirePrepared(prepared: PreparedPlayback): Promise<void> {
    let retirement = this.#retired.get(prepared);
    if (!retirement) { retirement = Promise.resolve().then(() => prepared.dispose()); this.#retired.set(prepared, retirement); }
    return retirement;
  }
  #beginFrameObservation(): void {
    if (typeof this.video.requestVideoFrameCallback !== 'function') return;
    const generation = this.#generation;
    const observe: VideoFrameRequestCallback = (now, metadata): void => {
      if (this.#disposed || generation !== this.#generation) return;
      if (this.#lastCallbackTime !== null && this.#lastPresented !== null && now - this.#lastCallbackTime >= 1000) {
        this.#callbackRate = (metadata.presentedFrames - this.#lastPresented) * 1000 / (now - this.#lastCallbackTime);
        this.#lastCallbackTime = now; this.#lastPresented = metadata.presentedFrames;
      } else if (this.#lastCallbackTime === null) { this.#lastCallbackTime = now; this.#lastPresented = metadata.presentedFrames; }
      this.#processingMs = metadata.processingDuration === undefined ? null : metadata.processingDuration * 1000;
      this.#callbackId = this.video.requestVideoFrameCallback(observe);
    };
    this.#callbackId = this.video.requestVideoFrameCallback(observe);
  }
  #fail(error: unknown): void {
    this.#state = 'failed'; this.#desiredPlaying = false; this.video.pause();
    if (!this.#error) this.#error = Object.freeze({ code: error instanceof EngineError ? error.code : 'PLAYBACK_ERROR', message: error instanceof Error ? error.message : String(error) });
    this.#emit();
  }
  #emit(): void { const snapshot = this.snapshot(); for (const listener of this.#listeners) listener(snapshot); }
  #assertLive(): void { if (this.#disposed) throw new EngineError('DISPOSED', 'Player is disposed', 'new-session'); }
  #requireSource(): void { this.#assertLive(); if (!this.#prepared || this.#state === 'opening' || this.#state === 'failed') throw new EngineError('INVALID_ARGUMENT', 'Open a playable source first'); }
}

export function describeInput(input: MediaInput): PlayerSourceInfo {
  if (input instanceof File) return { name: input.name, kind: 'local', bytes: input.size, mime: input.type || null, width: null, height: null, color: 'Browser output mapping · unverified', audio: 'Browser audio output' };
  const url = new URL(input.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EngineError('INVALID_ARGUMENT', 'Media URLs must use HTTPS or HTTP');
  const leaf = url.pathname.split('/').pop() || url.hostname;
  let name = leaf;
  try { name = decodeURIComponent(leaf); } catch { /* Keep a malformed escaped filename displayable. */ }
  name = input.label ?? name;
  return { name, kind: 'url', bytes: null, mime: null, width: null, height: null, color: 'Browser output mapping · unverified', audio: 'Browser audio output' };
}

export async function prepareDirectPlayback(input: MediaInput, signal: AbortSignal): Promise<PreparedPlayback> {
  if (signal.aborted) throw abortError();
  describeInput(input);
  const local = input instanceof File;
  const url = local ? URL.createObjectURL(input) : input.url;
  let disposed = false;
  return {
    route: 'N0', description: nativeDescriptions.N0, tracks: [],
    notices: ['Native decode, HDR output and the 60/120 fps gates require device qualification.'],
    async attach(video, attachmentSignal) {
      if (disposed || attachmentSignal.aborted) throw abortError();
      video.src = url; video.load();
    },
    async dispose() { if (disposed) return; disposed = true; if (local) URL.revokeObjectURL(url); },
  };
}

export function mediaElementError(video: HTMLVideoElement): EngineError {
  const code = video.error?.code;
  const explanation = code === 2 ? 'Media download failed. Check the URL, connection and origin permissions.' : code === 3 ? 'The browser could not decode this media profile.' : code === 4 ? 'No available playback route accepts this container or codec profile.' : 'Playback was interrupted.';
  return new EngineError('UNSUPPORTED_CODEC', video.error?.message ? `${explanation} ${video.error.message}` : explanation, 'caller-fix', { mediaErrorCode: code ?? null });
}

export function waitForMedia(video: HTMLVideoElement, event: string, ready: () => boolean, signal: AbortSignal, deadlineMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (ready()) return Promise.resolve();
  if (video.error) return Promise.reject(mediaElementError(video));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); video.removeEventListener(event, check); video.removeEventListener('error', failed); signal.removeEventListener('abort', abort); };
    const check = (): void => { if (ready()) { cleanup(); resolve(); } };
    const failed = (): void => { cleanup(); reject(mediaElementError(video)); };
    const abort = (): void => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); reject(new EngineError('DEADLINE_EXCEEDED', `Media ${event} deadline exceeded`, 'caller-fix')); }, deadlineMs);
    video.addEventListener(event, check); video.addEventListener('error', failed); signal.addEventListener('abort', abort, { once: true });
    check();
  });
}
