import { createReferencePlayer } from '@ubve/browser';

const video = document.querySelector<HTMLVideoElement>('#video')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const output = document.querySelector<HTMLPreElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const input = document.querySelector<HTMLInputElement>('#fixture')!;
const wait = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error('Managed evidence deadline expired'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
button.addEventListener('click', () => { void run(); });
async function run(): Promise<void> {
  const file = input.files?.[0]; if (!file) { output.textContent = 'Select the exact fixture first'; return; }
  button.disabled = true; output.textContent = 'Running'; output.dataset.status = 'running';
  const records: unknown[] = [], began = performance.now();
  const params = new URLSearchParams(location.search);
  const player = createReferencePlayer({ video, overlay, routePreference: () => 'managed', allowStereoFoldDown: () => true,
    tracePerformance: params.get('trace') === '1', prefetchCanvas: params.get('prefetch') === '1' });
  const foreground = () => ({ visibility: document.visibilityState, hasFocus: document.hasFocus() });
  const foregroundEvents: unknown[] = [{ event: 'initial', elapsedMs: 0, ...foreground() }];
  const recordForeground = (event: Event): void => { foregroundEvents.push({ event: event.type, elapsedMs: performance.now() - began, ...foreground() }); };
  document.addEventListener('visibilitychange', recordForeground);
  window.addEventListener('focus', recordForeground); window.addEventListener('blur', recordForeground);
  const evidence: Record<string, unknown> = {
    schema: 'ubve-implementation-pipeline-v2', evidenceClass: 'browser-short-pipeline-screening',
    recordedAt: new Date().toISOString(), environment: { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio },
    route: 'C1', fixture: { name: file.name, bytes: file.size }, nativeDecoderExecuted: false, gpuQualificationExecuted: false,
    transforms: ['Explicit 720p SDR output cap and PQ tone map', 'Explicit stereo index fold-down for the test host'],
    measurementBoundary: 'Muted real-time PCM graph and Canvas submission. No source-picture deadline or physical-scanout measurement. Fixture hashing and startup are outside playback stages.',
    sourcePictureDeadlinePass: null, physicalOutputVerified: null, sustainedTrials: [], qualified: false, stages: records, foregroundEvents,
  };
  let stage = 'fixture-hash';
  const serialize = (): void => {
    output.textContent = JSON.stringify(evidence, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2);
  };
  const checkpoint = (event: string): void => {
    records.push({ event, elapsedMs: performance.now() - began, ...foreground(), snapshot: player.snapshot(), diagnostics: player.diagnostics(),
      output: { videoCanvasCount: document.querySelectorAll('canvas.managed-video-surface').length, subtitleCanvasCount: overlay.querySelectorAll('canvas').length, nativeSrcPresent: video.hasAttribute('src'), nativeCurrentSrc: video.currentSrc || null } });
    serialize();
  };
  const waitForEnd = async (): Promise<void> => {
    await wait(() => ['ended', 'failed'].includes(player.snapshot().state), 30000);
    if (player.snapshot().state === 'failed') throw new Error(JSON.stringify(player.snapshot().error));
  };
  let failure: unknown = null;
  try {
    if (file.size > 64 * 1024 * 1024) throw new Error('Short browser-screening fixture exceeds 64 MiB');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    evidence.fixture = { name: file.name, bytes: file.size, sha256: [...hash].map(value => value.toString(16).padStart(2, '0')).join('') };
    stage = 'open';
    player.setVolume(0);
    await player.setQuality('performance'); await player.open(file); checkpoint('open-ready');
    stage = 'play'; await player.play(); checkpoint('play-acknowledged');
    stage = 'first-eos'; await waitForEnd(); checkpoint('eos');
    if (params.get('trace') === '1') {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.managed-video-surface');
      if (canvas) {
        const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (data) evidence.eosRasterSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
      }
    }
    stage = 'paused-seek'; await player.seek(0.2); await player.pause(); checkpoint('paused-seek');
    stage = 'resume'; await player.play(); checkpoint('resume-acknowledged');
    stage = 'seek-eos'; await waitForEnd(); checkpoint('seek-eos');
    stage = 'close'; await player.close(); checkpoint('close');
    stage = 'reopen'; await player.open(file); checkpoint('reopen');
  } catch (error) {
    failure = error; evidence.failedStage = stage;
    evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    checkpoint('failure-before-cleanup');
  }
  finally {
    try { await player.dispose(); checkpoint('disposed'); }
    catch (error) { failure ??= error; evidence.disposeError = String(error); }
    document.removeEventListener('visibilitychange', recordForeground);
    window.removeEventListener('focus', recordForeground); window.removeEventListener('blur', recordForeground);
    evidence.status = failure ? 'FAILED' : 'SHORT_PIPELINE_EXECUTED_NOT_QUALIFIED';
    evidence.elapsedMs = performance.now() - began;
    serialize();
    output.dataset.status = failure ? 'failed' : 'complete'; button.disabled = false;
  }
}
