import { createReferencePlayer } from '@ubve/browser';
import { ApiError, api, el, message } from './model.js';
import type { Job } from './model.js';
import { LabAudio } from './audio.js';

const status = el('status'), setup = el<HTMLButtonElement>('setup-audio'), stop = el<HTMLButtonElement>('stop');
const video = el<HTMLVideoElement>('video'), overlay = el('overlay');
const tab = globalThis.crypto?.randomUUID?.() ?? '';
const show = (s: string) => { status.textContent = s; };
const abortError = (why: string) => new DOMException(why, 'AbortError');
interface Active { readonly job: Job; readonly stop: AbortController; }
type Outcome = 'passed' | 'refused' | 'failed' | 'cancelled' | 'interrupted';
interface EventResult { readonly status: 'result'; readonly outcome: Outcome; readonly reason: string | null; readonly result: Record<string, unknown>; }
let audio: LabAudio, buildId: string;
let preparingAudio = false, active: Active | null = null, lastContact = 0;
let pending: { job: Job; event: EventResult } | null = null;
const foreground = () => ({ visible: document.visibilityState === 'visible', focused: document.hasFocus() });
const environment = () => ({ userAgent: navigator.userAgent, secure: isSecureContext, isolated: crossOriginIsolated,
  audioWorklet: typeof AudioWorkletNode !== 'undefined', hardwareConcurrency: navigator.hardwareConcurrency ?? null,
  audioSampleRates: audio.admitted, devicePixelRatio: devicePixelRatio ?? null, ...foreground() });
const event = async (job: Job, body: object) => api<{ terminal: boolean; state: string }>(`/api/v1/runs/${job.id}/events`,
  { ...body, build: job.build.id, tab });

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, ms);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}
async function boundedWait(predicate: () => boolean, signal: AbortSignal, ms: number, stage: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`${stage} deadline expired`);
    await delay(20, signal);
  }
}
async function fixtureFile(job: Job, url: string, signal: AbortSignal): Promise<File> {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok || res.headers.get('etag') !== `"${job.fixture.sha256}"` || Number(res.headers.get('content-length')) !== job.fixture.bytes) {
    throw new Error('Fixture response does not match its frozen identity');
  }
  const bytes = await res.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== job.fixture.bytes || hash !== job.fixture.sha256) throw new Error('Fixture content failed SHA-256 verification');
  return new File([bytes], job.fixture.name, { type: job.fixture.mime });
}
async function cadence(signal: AbortSignal): Promise<number[]> {
  const times: number[] = [];
  const start = performance.now();
  while (times.length < 15 && performance.now() - start < 1500) {
    const time = await new Promise<number>((resolve, reject) => {
      signal.throwIfAborted();
      const clear = () => { signal.removeEventListener('abort', cancelled); clearTimeout(timer); cancelAnimationFrame(frame); };
      const cancelled = () => { clear(); reject(signal.reason); };
      const frame = requestAnimationFrame(at => { clear(); resolve(at); });
      const timer = setTimeout(() => { clear(); reject(new Error('Foreground frame callback did not arrive')); }, 1500);
      signal.addEventListener('abort', cancelled, { once: true });
    });
    times.push(time);
  }
  return times.slice(1).map((at, i) => at - times[i]!);
}

async function execute(run: Active, deadlineMs: number): Promise<void> {
  const { job, stop: cancel } = run, signal = cancel.signal, initialEnvironment = environment();
  const player = createReferencePlayer({ video, overlay, routePreference: () => 'managed',
    allowStereoFoldDown: () => job.foldDown, portableAv1: job.av1 === 'portable', tracePerformance: job.scenario === 'timing',
    prefetchCanvas: job.scenario === 'timing' && job.prefetchCanvas, sameOriginMediaCredentials: true, contextForPcm: audio.context });
  const begin = performance.now(), stages: Record<string, unknown> = {}, foregroundEvents = [{ elapsedMs: 0, ...foreground() }];
  let outcome: Outcome = 'failed', reason: string | null = null, stage = 'preparing', checksPassed = false, cleanup = false, route: string | null = null;
  let rafIntervals: number[] | null = null;
  const closed = () => { void player.close().catch(() => undefined); };
  signal.addEventListener('abort', closed, { once: true });
  const foregroundChanged = () => {
    const observed = foreground();
    if (foregroundEvents.length < 256) foregroundEvents.push({ elapsedMs: performance.now() - begin, ...observed });
    if (!observed.visible || job.scenario === 'timing' && !observed.focused) cancel.abort(abortError('Foreground interrupted'));
  };
  const timer = setTimeout(() => cancel.abort(abortError('Run deadline elapsed')), deadlineMs);
  const keepLease = setInterval(() => {
    if (performance.now() - lastContact >= 15_000) cancel.abort(abortError('Master lease lost'));
  }, 500);
  stop.hidden = false;
  stop.onclick = () => cancel.abort(abortError('Stopped on this device'));
  document.addEventListener('visibilitychange', foregroundChanged);
  window.addEventListener('blur', foregroundChanged);
  window.addEventListener('focus', foregroundChanged);
  const play = async (name: string, first = false) => {
    const start = performance.now();
    await player.play();
    stages[`${name}Ms`] = performance.now() - start;
    if (first && (await event(job, { status: 'phase', phase: 'running' })).terminal) cancel.abort(abortError('Attempt already ended on the master'));
    signal.throwIfAborted();
  };
  const checkEnded = async () => {
    await boundedWait(() => ['ended', 'failed'].includes(player.snapshot().state), signal, 45_000, 'End of stream');
    const snapshot = player.snapshot();
    if (snapshot.state !== 'ended' || snapshot.error) throw new Error(snapshot.error?.message ?? 'Playback did not reach EOS');
    return snapshot;
  };
  try {
    if (!isSecureContext || !tab) throw new Error('A certificate trusted by this browser is required');
    if (job.build.id !== buildId) throw new Error('Runner and job builds differ');
    if (job.fixture.audioSampleRate !== null) audio.context(job.fixture.audioSampleRate);
    if (job.scenario === 'timing') {
      if (!foreground().focused || !foreground().visible) cancel.abort(abortError('Foreground was not established'));
      rafIntervals = await cadence(signal);
      if (rafIntervals.length < 10) throw new Error('Insufficient foreground cadence observations');
    }
    show(`${job.fixture.id} · Preparing`);
    const url = new URL(`/fixtures/${job.fixture.id}`, location.origin).href;
    const source = job.transport === 'file' ? await fixtureFile(job, url, signal) : { url, label: job.fixture.name };
    stages.preparationMs = performance.now() - begin;
    player.setMuted(true);
    await player.setQuality(job.fixture.quality);
    stage = 'open';
    const open = performance.now();
    if (job.fixture.discClip && !(source instanceof File)) throw new Error('Disc clip must be opened as a local File');
    const input = job.fixture.discClip && source instanceof File ? { kind: 'bluray-clip' as const, disc: source, ...job.fixture.discClip } : source;
    await player.open(input);
    const ready = player.snapshot();
    route = ready.route;
    if (route !== 'C1' || ready.state !== 'ready') throw new Error('Expected managed Ready without autoplay');
    stages.readyMs = performance.now() - open;
    stage = 'play';
    await play('play', true);
    show(`${job.fixture.id} · Running`);
    stage = 'eos';
    const ended = await checkEnded();
    // Check declared counts independently of the UI and never treat a counter
    // as evidence of physical audio output or display scanout.
    const diagnostics = player.diagnostics().managed as Record<string, unknown> | null;
    const observed = { videoFrames: diagnostics?.decodedVideoFrames, pcmFrames: (diagnostics?.audio as { consumedFrames?: number } | null)?.consumedFrames,
      subtitleEvents: (diagnostics?.subtitles as { eventCount?: number } | null)?.eventCount, fonts: (diagnostics?.subtitles as { fontCount?: number } | null)?.fontCount };
    stages.firstEos = { elapsedMs: performance.now() - begin, time: ended.time, transforms: ended.transforms, diagnostics };
    for (const key of Object.keys(job.fixture.expected) as (keyof typeof observed)[]) {
      if (observed[key] !== job.fixture.expected[key]) throw new Error(`${key}: expected ${job.fixture.expected[key]}, observed ${observed[key] ?? 'unavailable'}`);
    }
    if (job.fixture.expected.videoFrames !== undefined && diagnostics?.submittedVideoFrames !== job.fixture.expected.videoFrames) {
      throw new Error(`Video submissions: expected ${job.fixture.expected.videoFrames}, observed ${diagnostics?.submittedVideoFrames ?? 'unavailable'}`);
    }
    if (job.scenario === 'lifecycle') {
      stage = 'seek';
      const seek = performance.now(), target = Math.min(.2, ended.duration / 4);
      if (!(target > 0)) throw new Error('Fixture has no known seek interval');
      await player.seek(target);
      await player.pause();
      if (player.snapshot().state !== 'paused' || Math.abs(player.snapshot().time - target) > .03) throw new Error('Paused seek did not acknowledge target');
      stages.seekMs = performance.now() - seek;
      stage = 'resume';
      await play('resume');
      await checkEnded();
      stage = 'reopen';
      await player.close();
      if (player.snapshot().state !== 'empty' || video.hasAttribute('src') || overlay.parentElement?.querySelector('canvas.managed-video-surface')) throw new Error('Close left a presentation surface attached');
      await player.open(input);
      if (player.snapshot().state !== 'ready') throw new Error('Reopen did not start a fresh Ready session');
    }
    signal.throwIfAborted();
    checksPassed = true; outcome = 'passed';
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : null;
    const audioRefused = error instanceof Error && (error.name === 'NotAllowedError' || /Browser audio has not been admitted|AudioContext resume/.test(error.message));
    outcome = signal.aborted ? (/Foreground|lease|deadline/.test(message(signal.reason)) ? 'interrupted' : 'cancelled')
      : audioRefused || ['UNSUPPORTED_PROFILE', 'UNSUPPORTED_CODEC', 'OUTPUT_UNAVAILABLE'].includes(code ?? '') ? 'refused' : 'failed';
    reason = `${stage} · ${message(signal.aborted ? signal.reason : error)}`.slice(0, 256);
  } finally {
    clearTimeout(timer); clearInterval(keepLease);
    signal.removeEventListener('abort', closed);
    document.removeEventListener('visibilitychange', foregroundChanged);
    window.removeEventListener('blur', foregroundChanged);
    window.removeEventListener('focus', foregroundChanged);
    stop.hidden = true; stop.onclick = null;
    try {
      await player.dispose();
      cleanup = !video.hasAttribute('src') && !overlay.parentElement?.querySelector('canvas.managed-video-surface');
      if (!cleanup) throw new Error('Retired player still owns visible output');
    } catch (error) { outcome = 'failed'; reason ??= `cleanup · ${message(error)}`.slice(0, 256); }
    const result = { fixtureSha256: job.fixture.sha256, build: job.build.id, environment: initialEnvironment, transport: job.transport,
      stages, route, cleanup, checksPassed, foregroundEvents, rafIntervals, elapsedMs: performance.now() - begin, physicalOutput: null, qualified: false };
    pending = { job, event: { status: 'result', outcome, reason, result } };
    active = null;
    show(`${job.fixture.id} · ${outcome}${reason ? ' · ' + reason : ''}`);
  }
}

async function tick(): Promise<void> {
  try {
    if (pending) { await event(pending.job, pending.event); pending = null; }
    const reply = await api<{ job: Job | null; leaseMs: number; peerTime: number }>('/api/v1/poll', {
      ready: !preparingAudio && active === null && !document.hidden, tab, environment: environment(),
    });
    lastContact = performance.now();
    if (active && (reply.job?.id !== active.job.id || reply.job.state === 'cancelling')) active.stop.abort(abortError('Cancelled by the master'));
    else if (!active && reply.job && reply.job.state !== 'cancelling') {
      const run = { job: reply.job, stop: new AbortController() };
      active = run;
      void execute(run, Math.max(1, reply.job.deadline - reply.peerTime)).catch(error => { active = null; show(message(error)); });
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setup.hidden = true;
      active?.stop.abort(abortError('Master disconnected'));
      show('Open a fresh pairing link from the master.');
      return;
    }
    if (!active) show(`Waiting for master · ${message(error)}`);
  }
  setTimeout(() => { void tick(); }, 2000);
}
function ready(): void {
  setup.hidden = !audio.missing;
  show(audio.missing ? 'Ready for automatic jobs. This browser may need audio enabled once for this tab.'
    : 'Ready. Master-queued tests start automatically while this tab is in the foreground.');
}

async function boot(): Promise<void> {
  if (!isSecureContext || !tab) throw new Error('Trust the local test CA in this device’s browser before joining.');
  const config = await api<{ build: string; sampleRates: number[] }>('/api/v1/runner-config');
  if (!/^[a-f0-9]{64}$/.test(config.build) || !Array.isArray(config.sampleRates) || config.sampleRates.length > 4 ||
      config.sampleRates.some(rate => !Number.isSafeInteger(rate) || rate < 8000 || rate > 192000)) throw new Error('Invalid runner configuration');
  buildId = config.build;
  audio = new LabAudio(config.sampleRates);
  addEventListener('pagehide', event => {
    if (!event.persisted) { active?.stop.abort(abortError('Runner page closed')); audio.close(); }
  });
  setup.onclick = () => {
    if (active || preparingAudio) return;
    preparingAudio = true; setup.hidden = true; show('Admitting browser audio…');
    void audio.prepare().then(() => { preparingAudio = false; ready(); });
  };
  const join = new URLSearchParams(location.hash.slice(1)).get('join');
  if (!join) {
    await audio.prepare();
    ready(); void tick();
    return;
  }
  const form = el<HTMLFormElement>('pair');
  const submit = form.querySelector<HTMLButtonElement>('button')!;
  show('Name the device to join the lab. Pairing also enables browser audio for this tab.');
  form.hidden = false;
  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    const admission = audio.prepare();
    void api('/api/v1/pair', { code: join, name: el<HTMLInputElement>('name').value, platform: el<HTMLInputElement>('platform').value })
      .then(async () => {
        form.hidden = true; history.replaceState(null, '', location.pathname);
        show('Paired. Preparing browser audio…');
        await admission; ready(); void tick();
      }).catch(error => { submit.disabled = false; show(message(error)); });
  };
}
void boot().catch(error => show(message(error)));
