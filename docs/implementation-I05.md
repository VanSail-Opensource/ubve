# I05 — Browser assembly and reference player

This implementation supplies the browser composition root and the Vue reference application. It remains an **unqualified candidate**, with explicit unsupported paths and no completed physical HDR/audio or 60/120 presentation gate.

## Public entry points

`createPlayer` implements the original injected `CreatePlayer` facade. A per-host registry receives exact source descriptors and operation contexts. Superseding an open cancels its operation, awaits the old preparation, and disposes a late session before attaching another. Player disposal is terminal.

`createReferencePlayer` assembles the default browser-facing source picker, selected route, subtitle controller and lifecycle. Its `ReferencePlayer` exposes `open`, `play`, `pause`, `seek`, `setVolume`, `setMuted`, `setRate`, `setQuality`, `selectAudio`, `loadSubtitle`, `clearSubtitle`, `setSubtitleOffset`, `close`, `dispose`, `snapshot`, `subscribe`, `coreSnapshot` and `diagnostics`.

Media input is a local `File` or an HTTP(S) URL descriptor. A native URL can remain opaque to JavaScript; it does not become an exact-range source merely because the browser can play it. Managed/remux URL routes use the strict source adapter.

Snapshots contain immutable metadata and observations, never decoded pictures, audio buffers, source objects, workers or native media objects. The application refreshes diagnostics four times per second and responds promptly to state transitions. Native media times remain API-derived seconds; their conversion into core rational storage does not recover original container ticks.

## Routes and policy

| Selection | Implementation | Admission boundary |
|---|---|---|
| Automatic | N0 for admitted native playback, C1 for known local incompatibilities including TrueHD | Remote URLs remain opaque and native-only. No silent stereo remix or HDR downgrade. Exact output remains unqualified. |
| Native direct | N0, one browser media element with local object URL or opaque HTTP(S) source | Required known-incompatible soundtrack/subtitle profiles refuse. No software fallback under this explicit choice. |
| Experimental remux / audio bridge | N1 or N2 from the bounded native bridge, selected video/audio/ASS from one provider | Explicit user selection is required. Stream-copy provenance, output format, PCM conversion and exact output device still require qualification. |
| Managed software decode | C1 AV1 dav1d + TrueHD integer PCM + subtitle output | Only registered source profiles. Native codec APIs are not substituted. Full HDR output is refused by the SDR renderer. |

Managed video uses a bounded decoded-picture queue and submits every eligible decoded picture. Several Canvas2D submissions during one display refresh do not prove separate physical presentations. Delivery, submission, source cadence and physical scanout remain separate evidence.

Performance mode explicitly caps managed video at 720p and allows the declared PQ/BT.2020-to-SDR transform. Subtitle raster is capped at 1080p; source video decoding is retained. Native routes retain source video and use the subtitle cap. Neither quality selector creates an admitted 60/120 profile.

TrueHD is decoded to integer PCM before the exact normalized floating conversion. An epoch-owned accumulator combines decoder output into full 960-frame transport blocks and flushes the final partial block once at EOS. The decoded-sample position and submitted-sample position are tracked separately, preserving continuity across the accumulator. The PCM graph supplies the start acknowledgement and source-sample clock. Graph time is not physical audible time.

Default managed output preserves the decoded channel count with explicit channel-index labels. If a local TrueHD file needs the managed route, leave **Automatic** selected. **Allow stereo output when needed** is a saved opt-in that lets the managed route use stereo only if the current browser output cannot accept the selected channel count. A failed open can be retried with that permission. Explicit **Managed decode** retains its separate forced-stereo option.

With either setting, even source indices average into left and odd indices into right. That changes the spatial layout and is not lossless surround output. HDR output selection is independent. Choose **Performance** for tone-mapped SDR or explicitly enable WebGPU for the Full HDR candidate.

## Lifecycle and resource boundaries

- Superseded opens and seeks carry cancellation and a new identity. Pending preparation is joined before a new owner attaches. Ordinary source closure and a concurrent new open share a cleanup barrier.
- Metadata readiness has a finite deadline and does not autoplay. Native play uses the browser's playback promise; managed play waits for real AudioWorklet start.
- Managed seeking retires the old epoch, restarts codec instances with keyframe preroll, trims decoded audio to the exact target sample and retains the picture interval containing the target.
- On underrun, the worklet freezes at the first missing source sample. The coordinator holds presentation, recreates the epoch, primes that sample, and waits for a new start. The limits are two recoveries in 30 seconds and six per open.
- Pause intent survives an in-flight start or seek. User pause does not turn an otherwise empty decoder-output wait into a decode failure.
- Managed playback pauses when the document becomes hidden, because its presentation scheduler requires a visible frame clock. No hidden-tab frame dropping is used to claim cadence.
- Application buffers remain bounded. Container layouts whose interleave prevents bounded initial priming fail at the startup deadline; arbitrary interleaving is not admitted.
- Nonzero container discard padding is refused until exact trim is implemented. Unknown color metadata is refused by the managed raw renderer rather than guessed.
- A failed route retains the first failure. No native fallback is silently substituted for a requested managed path. Disposal revokes local object URLs and retires workers, renderer state and audio graphs.

## Application

The Vue app includes local file selection, drag and drop, a session queue, direct URL selection, keyboard transport, seek/volume controls, fullscreen, eligible picture in picture, optional browser-native controls, subtitle files and offset, audio track selection where implemented, quality/route policy, source/route diagnostics and JSON export. English, Simplified Chinese and Traditional Chinese are included. Files stay in browser memory references and are not uploaded by the application.

PGS loading has an explicit BT.709/BT.601 limited-range palette selector. Ordinary video picture in picture is disabled when a required custom subtitle overlay would be lost. Managed subtitle clocks use the selected source time rather than an unloaded media element.

## Verification

`test/player.test.mjs` exercises nine lifecycle/ownership scenarios, including actual object-URL revocation, using deterministic event-host doubles. These are Node contract/race tests, not evidence of real media decoding, browser rendering, audio output or physical presentation.

`node test/automatic-truehd-browser.mjs` loads the real AV1/TrueHD/ASS MKV through the built reference player. It checks refusal on stereo without permission, successful retry and playback to EOS after permission, persistence across the two documents, and refusal in explicit Native direct. Its device-capacity probe may narrow actual browser output to stereo, but cannot increase it. This screen does not measure physical sound or device-wide compatibility.

The full browser test lane must exercise the real pinned codecs and current target environments. Execution in this session was blocked by the available browser environment; no browser pass, complete combined performance result or target-platform support claim is recorded from that absence.

The I06 harness and I12 release evaluator own complete-pipeline and release qualification. This implementation does not change the v8 baseline into a pass.
