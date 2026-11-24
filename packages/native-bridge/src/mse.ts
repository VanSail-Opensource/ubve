import { EngineError } from '@ubve/core';
import type { MediaSourceSession } from '@ubve/io-demux';
import { runFragmentedRemux, selectNativeTracks, type NativeBridgeStatistics, type NativeTrackSelection, type RemuxOptions } from './mux.js';

export interface NativeStream {
  readonly route: 'N1' | 'N2';
  readonly ready: Promise<void>;
  readonly completion: Promise<void>;
  seek(seconds: number, signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): NativeBridgeStatistics | null;
}
interface Runtime { ready: Promise<void>; completion: Promise<void>; dispose(): Promise<void>; snapshot(): NativeBridgeStatistics | null; }

function waitEvent(target: EventTarget, success: string, signal: AbortSignal, start?: () => void, timeoutMs = 10000): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(success, done); target.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new EngineError('OUTPUT_UNAVAILABLE', `Native ${success} failed`)); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    target.addEventListener(success, done, { once: true }); target.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new EngineError('DEADLINE_EXCEEDED', `Native ${success} acknowledgement exceeded ${timeoutMs} ms`)); }, timeoutMs);
    try { start?.(); } catch (error) { cleanup(); reject(error); }
  });
}
async function idleTick(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 100);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function runtime(media: MediaSourceSession, video: HTMLVideoElement, selection: NativeTrackSelection, options: RemuxOptions, startTime: number): Promise<Runtime> {
  const selected = selectNativeTracks(media, selection), abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  if (signal.aborted) throw signal.reason;
  const mime = typeof MediaSource === 'undefined' ? undefined : [selected.mimeType, ...(selected.route === 'N2' ? [selected.mimeType.replace(/flac(?=")/, 'fLaC')] : [])].find(type => MediaSource.isTypeSupported(type));
  if (!mime) throw new EngineError('OUTPUT_UNAVAILABLE', `This browser does not admit MSE ${selected.mimeType}`);
  const source = new MediaSource(), url = URL.createObjectURL(source);
  let buffer: SourceBuffer | null = null, stats: NativeBridgeStatistics | null = null, closing: Promise<void> | null = null;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void, readySettled = false, positioned = startTime === 0, targetBuffered = false;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
  const priorPreload = video.getAttribute('preload');
  const readyEvents = ['loadeddata', 'canplay', 'seeked'] as const;
  let readyDeadline: ReturnType<typeof setTimeout> | undefined;
  const removeReadiness = () => {
    clearTimeout(readyDeadline);
    signal.removeEventListener('abort', aborted);
    for (const event of readyEvents) video.removeEventListener(event, checkReady);
  };
  const settleReady = (error?: unknown) => {
    if (readySettled) return;
    readySettled = true; removeReadiness();
    if (error !== undefined) rejectReady(error);
    else resolveReady();
  };
  const aborted = () => settleReady(signal.reason ?? new EngineError('CANCELLED', 'Native startup was cancelled'));
  const checkReady = () => {
    if (signal.aborted) { aborted(); return; }
    if (targetBuffered && positioned && !video.seeking && video.readyState >= video.HAVE_CURRENT_DATA) settleReady();
  };
  const failed = () => abort.abort(new EngineError('OUTPUT_UNAVAILABLE', 'Native media element rejected the remux', 'none', { code: video.error?.code ?? null }));
  for (const event of readyEvents) video.addEventListener(event, checkReady);
  signal.addEventListener('abort', aborted, { once: true });
  video.addEventListener('error', failed);
  const detach = () => {
    removeReadiness(); video.removeEventListener('error', failed);
    if (video.getAttribute('src') === url) {
      video.pause(); video.removeAttribute('src');
      if (priorPreload === null) video.removeAttribute('preload'); else video.setAttribute('preload', priorPreload);
      video.load();
    }
    URL.revokeObjectURL(url);
  };
  try {
    await waitEvent(source, 'sourceopen', signal, () => { video.preload = 'auto'; video.src = url; });
    buffer = source.addSourceBuffer(mime); buffer.mode = 'segments';
  } catch (error) { abort.abort(error); detach(); settleReady(error); throw error; }
  const activeBuffer = buffer;
  readyDeadline = setTimeout(() => abort.abort(new EngineError('DEADLINE_EXCEEDED', 'Native playback did not decode and position initial media data within ten seconds')), 10000);
  const completion = runFragmentedRemux(media, selection, { ...options, signal, startTime }, async data => {
    if (signal.aborted) throw signal.reason;
    // Backpressure keeps only eight seconds ahead. User pause is an intentional wait, not a decoder stall.
    while (readySettled && activeBuffer.buffered.length && activeBuffer.buffered.end(activeBuffer.buffered.length - 1) - video.currentTime > 8) await idleTick(signal);
    if (activeBuffer.updating) await waitEvent(activeBuffer, 'updateend', signal);
    if (video.currentTime > 30 && activeBuffer.buffered.length && activeBuffer.buffered.start(0) < video.currentTime - 30) {
      await waitEvent(activeBuffer, 'updateend', signal, () => activeBuffer.remove(0, video.currentTime - 30));
    }
    await waitEvent(activeBuffer, 'updateend', signal, () => activeBuffer.appendBuffer(data as Uint8Array<ArrayBuffer>));
    if (activeBuffer.buffered.length && !readySettled) {
      targetBuffered = false;
      for (let i = 0; i < activeBuffer.buffered.length; i++) {
        if (startTime === 0 || (activeBuffer.buffered.start(i) <= startTime && activeBuffer.buffered.end(i) > startTime)) {
          targetBuffered = true;
          if (!positioned) { video.currentTime = startTime; positioned = true; }
          break;
        }
      }
      checkReady();
    }
  }, value => { stats = value; }).then(async () => {
    if (!targetBuffered) throw new EngineError('OUTPUT_UNAVAILABLE', 'Remux completed without an admitted buffered playback range');
    if (source.readyState === 'open') source.endOfStream();
    await ready;
  }).catch(error => { settleReady(error); throw error; });
  completion.catch(() => {});
  return { ready, completion, snapshot: () => stats,
    dispose() { if (closing) return closing; abort.abort(new EngineError('CANCELLED', 'Native stream stopped')); if (activeBuffer.updating) { try { activeBuffer.abort(); } catch { /* Source may already have detached. */ } } detach(); closing = completion.catch(() => {}); return closing; },
  };
}

/** Attaches exactly one native video clock; N3/dual-clock playback is not enabled. */
export async function createNativeStream(media: MediaSourceSession, video: HTMLVideoElement, selection: NativeTrackSelection, options: RemuxOptions): Promise<NativeStream> {
  if (options.allowExperimental !== true) throw new EngineError('UNSUPPORTED_PROFILE', 'Native remux requires experimental opt-in');
  const selected = selectNativeTracks(media, selection), lifetime = new AbortController();
  const ownedOptions = { ...options, signal: options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal };
  let current = await runtime(media, video, selection, ownedOptions, options.startTime ?? 0), disposed = false, closing: Promise<void> | null = null, seeking: Promise<void> | null = null;
  return { route: selected.route,
    get ready() { return current.ready; }, get completion() { return current.completion; }, snapshot: () => current.snapshot(),
    seek(seconds, signal) {
      if (disposed) return Promise.reject(new EngineError('DISPOSED', 'Native stream disposed'));
      if (seeking) return Promise.reject(new EngineError('BACKPRESSURE', 'One native seek may be active'));
      if (!Number.isFinite(seconds) || seconds < 0 || (media.duration !== null && seconds >= media.duration)) return Promise.reject(new EngineError('INVALID_ARGUMENT', 'Native seek target is outside the media duration'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const prepare = new AbortController(), cancelled = () => prepare.abort(signal?.reason);
      signal?.addEventListener('abort', cancelled, { once: true });
      seeking = (async () => {
        await current.dispose();
        if (disposed) throw new EngineError('DISPOSED', 'Native stream disposed during seek');
        current = await runtime(media, video, selection, { ...ownedOptions, signal: AbortSignal.any([ownedOptions.signal, prepare.signal]) }, seconds);
        try { await current.ready; } catch (error) { await current.dispose(); throw error; }
        if (prepare.signal.aborted) throw prepare.signal.reason;
      })().finally(() => { signal?.removeEventListener('abort', cancelled); seeking = null; });
      return seeking;
    },
    dispose() { if (closing) return closing; disposed = true; lifetime.abort(new EngineError('DISPOSED', 'Native stream disposed')); closing = (async () => { await current.dispose(); if (seeking) await seeking.catch(() => {}); await current.dispose(); })(); return closing; },
  };
}
