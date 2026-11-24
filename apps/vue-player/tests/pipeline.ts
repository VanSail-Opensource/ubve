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
  const player = createReferencePlayer({ video, overlay, routePreference: () => 'managed', allowStereoFoldDown: () => true });
  const evidence: Record<string, unknown> = {
    schema: 'ubve-implementation-pipeline-v1', evidenceClass: 'browser-short-pipeline-candidate',
    recordedAt: new Date().toISOString(), userAgent: navigator.userAgent, crossOriginIsolated,
    route: 'C1', fixture: { name: file.name, bytes: file.size }, nativeDecoderExecuted: false, gpuQualificationExecuted: false,
    transforms: ['Explicit 720p SDR output cap and PQ tone map', 'Explicit stereo index fold-down for the test host'],
    physicalOutputVerified: null, sustainedTrials: [], qualified: false, stages: records,
  };
  let failure: unknown = null;
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    evidence.fixture = { name: file.name, bytes: file.size, sha256: [...hash].map(value => value.toString(16).padStart(2, '0')).join('') };
    player.setVolume(0);
    await player.setQuality('performance'); await player.open(file);
    records.push({ event: 'open-ready', elapsedMs: performance.now() - began, snapshot: player.snapshot() });
    await player.play();
    await wait(() => ['ended', 'failed'].includes(player.snapshot().state), 30000);
    if (player.snapshot().state === 'failed') throw new Error(JSON.stringify(player.snapshot().error));
    records.push({ event: 'eos', snapshot: player.snapshot(), diagnostics: player.diagnostics() });
    await player.seek(0.2); await player.pause();
    records.push({ event: 'paused-seek', snapshot: player.snapshot() });
    await player.play(); await wait(() => ['ended', 'failed'].includes(player.snapshot().state), 30000);
    if (player.snapshot().state === 'failed') throw new Error(JSON.stringify(player.snapshot().error));
    records.push({ event: 'seek-eos', snapshot: player.snapshot(), diagnostics: player.diagnostics() });
    await player.close(); records.push({ event: 'close', snapshot: player.snapshot() });
    await player.open(file); records.push({ event: 'reopen', snapshot: player.snapshot() });
  } catch (error) { failure = error; evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error); }
  finally {
    try { await player.dispose(); records.push({ event: 'disposed', snapshot: player.snapshot() }); }
    catch (error) { failure ??= error; evidence.disposeError = String(error); }
    evidence.status = failure ? 'FAILED' : 'SHORT_PIPELINE_EXECUTED_NOT_QUALIFIED';
    evidence.elapsedMs = performance.now() - began;
    output.textContent = JSON.stringify(evidence, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2);
    output.dataset.status = failure ? 'failed' : 'complete'; button.disabled = false;
  }
}
