// Development only: explicit capped fixture materialization is excluded from production source budgets.
const button = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector<HTMLElement>('#status')!;
const results = document.querySelector<HTMLElement>('#results')!;
const json = (value: unknown) => JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
const sha = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value as Uint8Array<ArrayBuffer>))].map(byte => byte.toString(16).padStart(2, '0')).join('');

button.addEventListener('click', async () => {
  button.disabled = true; status.textContent = 'Initializing owned software workers…';
  const record: Record<string, unknown> = { schema: 'ubve-codec-component-v1', qualification: 'NOT_QUALIFIED', environment: { userAgent: navigator.userAgent, crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' }, startedAt: new Date().toISOString() };
  let media: import('@ubve/io-demux').MediaSourceSession | undefined;
  let video: import('@ubve/wasm-adapters').Av1Decoder | undefined;
  let audio: import('@ubve/wasm-adapters').TrueHdDecoder | undefined;
  try {
    for (const name of ['VideoDecoder', 'AudioDecoder']) Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
    record['nativeDecodeDisabled'] = typeof globalThis.VideoDecoder === 'undefined' && typeof globalThis.AudioDecoder === 'undefined';
    const [{ openMedia, operationContext }, { Av1Decoder, TrueHdDecoder }, { sessionStamp }] = await Promise.all([import('@ubve/io-demux'), import('@ubve/wasm-adapters'), import('@ubve/core')]);
    const response = await fetch(document.querySelector<HTMLInputElement>('#fixture')!.value);
    if (!response.ok) throw Error(`Fixture fetch failed (${response.status})`);
    const size = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(size) || size < 1 || size > 32 * 1024 * 1024) throw Error('Fixture needs a known Content-Length within the 32 MiB development limit');
    const fixture = new Uint8Array(await response.arrayBuffer());
    if (fixture.length !== size) throw Error('Fixture body length changed');
    record['fixture'] = { bytes: fixture.length, sha256: await sha(fixture), materialization: 'test-only capped Blob, not a production source path' };
    let stamp = sessionStamp(crypto.randomUUID(), 0);
    media = await openMedia(new Blob([fixture]), { stamp });
    const vt = media.tracks.find(track => track.codec === 'av1'), at = media.tracks.find(track => track.codec === 'truehd');
    if (!vt?.width || !vt.height || !at?.sampleRate || !at.channelCount) throw Error('The combined fixture needs admitted AV1 and TrueHD tracks');
    video = await Av1Decoder.create({ width: vt.width, height: vt.height, description: vt.codecPrivate, stamp, threads: 4, outputFrames: 3 });
    audio = await TrueHdDecoder.create({ sampleRate: at.sampleRate, channelLabels: Array.from({ length: at.channelCount }, (_, i) => `channel-${i + 1}`), timestampResolutionSeconds: Number(media.matroska?.timecodeScaleNs ?? 0n) / 1e9, stamp });
    const runEpoch = async (seekSeconds: number) => {
      const frames: Record<string, unknown>[] = [], pcm: Record<string, unknown>[] = [], chunks: Uint8Array[] = [];
      let totalPcmBytes = 0, submittedVideo = 0, submittedAudio = 0, subtitlePackets = 0;
      const op = (id: string) => operationContext(stamp, id, undefined, 120000);
      const consumeVideo = (async () => { for (;;) { const output = await video!.readOutput(op('video-output')); if (!output) break; try { const frame = output.payload.borrow(); frames.push({ pts: output.pts, durationTicks: output.durationTicks, format: frame.format, width: frame.codedWidth, height: frame.codedHeight, sha256: await sha(frame.data), planes: await Promise.all(frame.planes.map(async plane => ({ ...plane, sha256: await sha(frame.data.subarray(plane.offsetBytes, plane.offsetBytes + plane.rows * plane.strideBytes)) }))), metadata: frame.signalMetadata }); } finally { output.payload.release(); } } })();
      const consumeAudio = (async () => { for (;;) { const output = await audio!.readOutput(op('audio-output')); if (!output) break; try { const value = output.payload.borrow(), bytes = new Uint8Array(value.planes[0]!.buffer, value.planes[0]!.byteOffset, value.planes[0]!.byteLength); totalPcmBytes += bytes.length; if (totalPcmBytes > 16 * 1024 * 1024) throw Error('Development reference PCM exceeds 16 MiB'); chunks.push(bytes.slice()); pcm.push({ firstSample: output.pts.ticks, frames: value.frames, validBits: value.validBits, sha256: await sha(bytes) }); } finally { output.payload.release(); } } })();
      const failures = Promise.all([consumeVideo, consumeAudio]); failures.catch(() => {});
      const accepted = new Set<Promise<void>>();
      for await (const packet of media!.packets(media!.tracks.map(track => track.id), { startTime: seekSeconds, stamp })) {
        const decoder = packet.trackId === vt.id ? video! : packet.trackId === at.id ? audio! : null;
        if (!decoder) { subtitlePackets++; packet.bytes.release(); continue; }
        for (;;) {
          const submission = decoder.trySubmit(packet, op('submit'));
          if (submission.status === 'rejected') { packet.bytes.release(); throw submission.error; }
          if (submission.status === 'accepted') { const consumed = submission.inputConsumed; accepted.add(consumed); consumed.finally(() => accepted.delete(consumed)).catch(() => {}); if (decoder === video) submittedVideo++; else submittedAudio++; break; }
          if (!accepted.size) throw Error('Backpressure without accepted work');
          await Promise.race([Promise.race(accepted), failures.then(() => { throw Error('Output ended before packet submission'); })]);
        }
      }
      await Promise.all(accepted);
      await Promise.all([video!.flushEndOfStream(op('video-eos')), audio!.flushEndOfStream(op('audio-eos')), consumeVideo, consumeAudio]);
      const aggregate = new Uint8Array(totalPcmBytes); let offset = 0; for (const chunk of chunks) { aggregate.set(chunk, offset); offset += chunk.length; }
      return { seekSeconds, submittedVideo, submittedAudio, subtitlePackets, videoFrames: frames.length, pcmFrames: pcm.reduce((sum, item) => sum + Number(item['frames']), 0), pcmS32leSha256: await sha(aggregate), video: frames, pcm, source: media!.snapshot(), videoDecoder: video!.diagnostics(), audioDecoder: audio!.diagnostics() };
    };
    status.textContent = 'Decoding exact pixels and integer PCM…';
    record['initial'] = await runEpoch(0); results.textContent = json(record);
    status.textContent = 'Resetting codec epochs and checking seek recovery…';
    stamp = sessionStamp(stamp.sessionId, 1);
    await Promise.all([video.reset(stamp, operationContext(stamp, 'video-seek', undefined, 15000)), audio.reset(stamp, operationContext(stamp, 'audio-seek', undefined, 15000))]);
    record['seek'] = await runEpoch(0.4);
    record['status'] = 'COMPONENT_RUN_COMPLETED';
  } catch (error) { record['status'] = 'FAILED'; record['error'] = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error); }
  finally {
    const disposed = await Promise.allSettled([video?.dispose(), audio?.dispose(), media?.dispose()]);
    record['disposal'] = disposed.map(result => result.status === 'fulfilled' ? 'resolved' : String(result.reason));
    record['afterDispose'] = { video: video?.diagnostics(), audio: audio?.diagnostics(), source: media?.snapshot() };
    record['finishedAt'] = new Date().toISOString(); results.textContent = json(record); status.textContent = String(record['status']); button.disabled = false;
    try { await fetch('/__evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json(record) }); } catch { /* Results remain visible and copyable in the DOM. */ }
  }
});
