import { openMedia } from '@ubve/io-demux';
import { createNativeStream, selectNativeTracks, type NativeStream } from '@ubve/native-bridge';

const result = document.querySelector<HTMLElement>('#result')!;
const video = document.querySelector<HTMLVideoElement>('#video')!;
const input = document.querySelector<HTMLInputElement>('#fixture')!;

function waitForMedia(event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(Error(`Media element error ${video.error?.code ?? 'unknown'}`)); };
    const timer = setTimeout(() => { cleanup(); reject(Error(`Timed out awaiting ${event}`)); }, 15000);
    video.addEventListener(event, done, { once: true }); video.addEventListener('error', failed, { once: true });
  });
}

document.querySelector<HTMLButtonElement>('#run')!.addEventListener('click', async () => {
  result.dataset['status'] = 'running';
  const file = input.files?.[0];
  let media: Awaited<ReturnType<typeof openMedia>> | undefined, native: NativeStream | undefined;
  const evidence: Record<string, unknown> = { schema: 'ubve-native-bridge-candidate-v1', date: new Date().toISOString(), userAgent: navigator.userAgent, qualified: false, physicalOutputVerified: null, performanceQualified: null };
  try {
    if (!file) throw Error('Select the exact fixture first');
    evidence['fixtureSha256'] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    media = await openMedia(file);
    const selection = { videoTrackId: 'mkv:1', audioTrackId: 'mkv:2', subtitleTrackId: 'mkv:3' };
    const selected = selectNativeTracks(media, selection);
    evidence['mime'] = selected.mimeType;
    const mimeQueries = [selected.mimeType, selected.mimeType.replace(/flac(?=")/, 'fLaC')];
    evidence['mimeQueries'] = mimeQueries.map(type => ({ type, supported: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type) }));
    if (typeof MediaSource === 'undefined' || !mimeQueries.some(type => MediaSource.isTypeSupported(type))) {
      evidence['status'] = 'EXACT_MSE_MIME_REJECTED_NOT_QUALIFIED';
    } else {
      let cues = 0;
      native = await createNativeStream(media, video, selection, { allowExperimental: true, onSubtitle: packet => {
        if (packet.durationTicks !== 800000000n) throw Error('Unexpected ASS event duration');
        cues++;
      } });
      await native.ready;
      evidence['prePlay'] = { readyState: video.readyState, seeking: video.seeking, remainsPaused: video.paused };
      if (video.readyState < video.HAVE_CURRENT_DATA || video.seeking) throw Error('Native ready resolved before current data was available');
      const ended = waitForMedia('ended'); ended.catch(() => {});
      await video.play(); await ended; await native.completion;
      const rendered = video.getVideoPlaybackQuality();
      evidence['initialPlayback'] = { duration: video.duration, currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, totalVideoFrames: rendered.totalVideoFrames, droppedVideoFrames: rendered.droppedVideoFrames, forwardedSubtitlePackets: cues, stats: native.snapshot() };
      await native.seek(0.213);
      evidence['seek'] = { requested: 0.213, observed: video.currentTime, remainsPaused: video.paused, readyState: video.readyState, seeking: video.seeking };
      if (!video.paused || video.seeking || video.readyState < video.HAVE_CURRENT_DATA || Math.abs(video.currentTime - 0.213) > 0.01) throw Error('Seek did not prime the requested timestamp and remain paused');
      evidence['status'] = 'SHORT_NATIVE_CANDIDATE_EXECUTED_NOT_QUALIFIED';
    }
  } catch (error) {
    evidence['status'] = 'FAILED_NOT_QUALIFIED';
    evidence['error'] = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  } finally {
    await native?.dispose().catch(() => {});
    await media?.dispose().catch(() => {});
    evidence['preloadRestored'] = video.getAttribute('preload') === 'metadata';
    result.textContent = JSON.stringify(evidence, null, 2);
    result.dataset['status'] = 'done';
  }
});
