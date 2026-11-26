import { createReferencePlayer } from '@ubve/browser';

const input = document.querySelector<HTMLInputElement>('#fixture')!;
const button = document.querySelector<HTMLButtonElement>('#start')!;
const result = document.querySelector<HTMLElement>('#result')!;
const video = document.querySelector<HTMLVideoElement>('#video')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const params = new URLSearchParams(location.search);
let running = false;
button.onclick = () => { if (!running) void measure(); };

async function measure(): Promise<void> {
  const file = input.files?.[0]; if (!file) return;
  running = true; button.disabled = true;
  const start = performance.now();
  const player = createReferencePlayer({ video, overlay, routePreference: () => 'managed',
    allowStereoFoldDown: () => true, portableAv1: true, tracePerformance: true });
  const receipt: Record<string, unknown> = { fixture: file.name, secure: isSecureContext, isolated: crossOriginIsolated,
    browser: navigator.userAgent, focus: document.hasFocus(), gate: 'NOT_QUALIFIED', evidenceClass: 'browser-software-screening' };
  const untilEnd = async () => {
    const { duration, time } = player.snapshot();
    const remainingMs = Math.max(0, duration - time) * 1000;
    if (!Number.isFinite(remainingMs) || remainingMs > 50_000) throw new Error('Software screen accepts at most 50 seconds of playback');
    const deadline = performance.now() + Math.max(30_000, remainingMs + 10_000);
    while (!['ended', 'failed'].includes(player.snapshot().state)) {
      if (performance.now() > deadline) throw new Error('Software screen EOS deadline expired');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (player.snapshot().state !== 'ended') throw new Error(player.snapshot().error?.message ?? 'Software playback failed');
  };
  try {
    player.setMuted(true);
    await player.setQuality(params.get('quality') === 'performance' ? 'performance' : 'full');
    await player.open(file);
    const ready = player.snapshot();
    if (ready.state !== 'ready' || ready.route !== 'C1') throw new Error('Software screen did not reach Ready without autoplay');
    receipt.readyMs = performance.now() - start;
    await player.play();
    await untilEnd();
    const end = player.snapshot();
    receipt.eos = { time: end.time, duration: end.duration, transforms: end.transforms, ...player.diagnostics() };
    if (params.get('seek') === '1') {
      const target = Math.min(.2, end.duration / 4);
      if (!(target > 0)) throw new Error('Cannot check paused seek without a source duration');
      await player.seek(target); await player.pause();
      if (player.snapshot().state !== 'paused' || Math.abs(player.snapshot().time - target) > .03) throw new Error('Software paused seek did not re-prime');
      await player.play(); await untilEnd();
      receipt.seek = 'PASSED';
    }
    await player.close();
    if (player.snapshot().state !== 'empty') throw new Error('Close left the session active');
    receipt.outcome = 'PASSED';
  } catch (error) { receipt.outcome = 'FAILED'; receipt.error = error instanceof Error ? error.message : String(error); receipt.diagnostics = player.diagnostics(); }
  finally {
    try {
      await player.dispose();
      receipt.cleanup = !document.querySelector('canvas.managed-video-surface') && !video.hasAttribute('src');
    } catch (error) { receipt.cleanup = false; receipt.cleanupError = String(error); }
    if (receipt.cleanup !== true) receipt.outcome = 'FAILED';
    result.textContent = JSON.stringify(receipt, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
    result.dataset.complete = 'true'; button.disabled = false; running = false;
  }
}
