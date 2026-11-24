import { EngineError } from '@ubve/core';
import type { MediaSourceSession } from '@ubve/io-demux';
import { runFragmentedRemux, selectNativeTracks, type NativeBridgeStatistics, type NativeTrackSelection, type RemuxOptions } from './mux.js';

export interface NativeStream {
  readonly route: 'N1' | 'N2';
  readonly ready: Promise<void>;
  readonly completion: Promise<void>;
  seek(seconds: number): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): NativeBridgeStatistics | null;
}
interface Runtime { ready: Promise<void>; completion: Promise<void>; dispose(): Promise<void>; snapshot(): NativeBridgeStatistics | null; }

function waitEvent(target: EventTarget, success: string, signal: AbortSignal, timeoutMs = 10000): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(success, done); target.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new EngineError('OUTPUT_UNAVAILABLE', `Native ${success} failed`)); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    target.addEventListener(success, done, { once: true }); target.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new EngineError('DEADLINE_EXCEEDED', `Native ${success} acknowledgement exceeded ${timeoutMs} ms`)); }, timeoutMs);
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
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(selected.mimeType)) throw new EngineError('OUTPUT_UNAVAILABLE', `This browser does not admit MSE ${selected.mimeType}`);
  const source = new MediaSource(), url = URL.createObjectURL(source);
  let buffer: SourceBuffer | null = null, stats: NativeBridgeStatistics | null = null, closing: Promise<void> | null = null;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void, readySettled = false, positioned = startTime === 0;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(() => {});
  const detach = () => { if (video.getAttribute('src') === url) { video.pause(); video.removeAttribute('src'); video.load(); } URL.revokeObjectURL(url); };
  try {
    const opened = waitEvent(source, 'sourceopen', signal); video.src = url; await opened;
    buffer = source.addSourceBuffer(selected.mimeType); buffer.mode = 'segments';
  } catch (error) { abort.abort(error); detach(); rejectReady(error); throw error; }
  const activeBuffer = buffer;
  const completion = runFragmentedRemux(media, selection, { ...options, signal, startTime }, async data => {
    if (signal.aborted) throw signal.reason;
    // Backpressure keeps only eight seconds ahead. User pause is an intentional wait, not a decoder stall.
    while (readySettled && activeBuffer.buffered.length && activeBuffer.buffered.end(activeBuffer.buffered.length - 1) - video.currentTime > 8) await idleTick(signal);
    if (activeBuffer.updating) await waitEvent(activeBuffer, 'updateend', signal);
    if (video.currentTime > 30 && activeBuffer.buffered.length && activeBuffer.buffered.start(0) < video.currentTime - 30) {
      const removed = waitEvent(activeBuffer, 'updateend', signal);
      try { activeBuffer.remove(0, video.currentTime - 30); } catch (error) { abort.abort(error); throw error; }
      await removed;
    }
    const appended = waitEvent(activeBuffer, 'updateend', signal);
    try { activeBuffer.appendBuffer(data as Uint8Array<ArrayBuffer>); } catch (error) { abort.abort(error); throw error; }
    await appended;
    if (activeBuffer.buffered.length) {
      for (let i = 0; i < activeBuffer.buffered.length; i++) {
        if (!positioned && activeBuffer.buffered.start(i) <= startTime && activeBuffer.buffered.end(i) > startTime) { video.currentTime = startTime; positioned = true; }
      }
      if (positioned && !readySettled) { readySettled = true; resolveReady(); }
    }
  }, value => { stats = value; }).then(() => {
    if (!readySettled) throw new EngineError('OUTPUT_UNAVAILABLE', 'Remux completed without an admitted buffered playback range');
    if (source.readyState === 'open') source.endOfStream();
  }).catch(error => { if (!readySettled) { readySettled = true; rejectReady(error); } throw error; });
  completion.catch(() => {});
  return { ready, completion, snapshot: () => stats,
    dispose() { if (closing) return closing; abort.abort(new EngineError('CANCELLED', 'Native stream stopped')); if (activeBuffer.updating) { try { activeBuffer.abort(); } catch { /* Source may already have detached. */ } } detach(); closing = completion.catch(() => {}); return closing; },
  };
}

/** Attaches exactly one native video clock; N3/dual-clock playback is not enabled. */
export async function createNativeStream(media: MediaSourceSession, video: HTMLVideoElement, selection: NativeTrackSelection, options: RemuxOptions): Promise<NativeStream> {
  if (options.allowExperimental !== true) throw new EngineError('UNSUPPORTED_PROFILE', 'Native remux requires experimental opt-in');
  const selected = selectNativeTracks(media, selection);
  let current = await runtime(media, video, selection, options, options.startTime ?? 0), disposed = false, closing: Promise<void> | null = null, seeking: Promise<void> | null = null;
  return { route: selected.route,
    get ready() { return current.ready; }, get completion() { return current.completion; }, snapshot: () => current.snapshot(),
    seek(seconds) {
      if (disposed) return Promise.reject(new EngineError('DISPOSED', 'Native stream disposed'));
      if (seeking) return Promise.reject(new EngineError('BACKPRESSURE', 'One native seek may be active'));
      if (!Number.isFinite(seconds) || seconds < 0 || (media.duration !== null && seconds >= media.duration)) return Promise.reject(new EngineError('INVALID_ARGUMENT', 'Native seek target is outside the media duration'));
      const resume = !video.paused;
      seeking = (async () => { await current.dispose(); if (disposed) throw new EngineError('DISPOSED', 'Native stream disposed during seek'); current = await runtime(media, video, selection, options, seconds); await current.ready; if (resume && !disposed) await video.play(); })().finally(() => { seeking = null; });
      return seeking;
    },
    dispose() { if (closing) return closing; disposed = true; closing = (async () => { await current.dispose(); if (seeking) await seeking.catch(() => {}); await current.dispose(); })(); return closing; },
  };
}
