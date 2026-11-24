# I11 — Paired Canvas raster screening

Reducing the managed Canvas2D cap from 720p to 360p removed only **2–3 late submissions out of 48** on first play. The 360p candidate discarded 75% of the output pixels without coming close to zero late submissions. Keep the existing 720p cap. This does not promote either transform to a qualified playback mode.

## Exact workload and boundary

- Source `test/fixtures/primary/combined-720p60.mkv`, SHA-256 `4e681a037ee5a4fdf57ac7512e702012d15b986133e27410e826c45fe76ad187`. The 0.8-second source has 48 AV1 HDR10 pictures, TrueHD at 48 kHz and ASS with an attached font.
- Actual Linux HeadlessChrome `158.0.8127.0` with GPU disabled. The production C1 packet/codec/AudioWorklet/subtitle pipeline used the same CPU PQ-to-SDR transform, source decode, explicit stereo index fold-down, muted output and 1× clock in both conditions. Only the post-decode Canvas raster cap changed. The actual canvases were 1280×720 and 640×360. The lower raster is deliberately lossy and does not reduce source decode work.
- Six short runs in one browser, with a fresh Playwright page for each. The counterbalanced order was 720→360, 360→720, 720→360. The same `test/pipeline-browser.mjs` functional screen checked metadata, fixture hash, real decode and PCM EOF, paused seek, resumed EOF, close, reopen and disposal. The cap selector and canvas geometry assertion were local experiment code, not a production feature.
- Count late submissions at first playback EOS. The counter flags a picture when the render loop’s sampled media clock is more than 20 ms past its PTS. The paused-seek column is the additional count after a seek to 0.2 seconds and a second play to EOS. This is a browser software counter, not the v8 source-picture deadline, physical presentation or a throughput measurement.

## Results

| Pair | First-play late at 720p | First-play late at 360p | Seek-play late at 720p | Seek-play late at 360p |
| --- | ---: | ---: | ---: | ---: |
| 1 | 42 | 40 | 31 | 23 |
| 2 | 42 | 40 | 32 | 23 |
| 3 | 44 | 41 | 32 | 23 |
| Median | 42 | 40 | 32 | 23 |

All six runs decoded and submitted 48 first-play pictures, consumed 38,400 PCM sample frames, loaded 24 ASS events and one attached font, and reported no audio underruns or recovery. That verifies short functional completion for this exact workload. It does not reproduce a sustained gate trial or establish output fidelity, physical display cadence, or 60/120 qualification.
