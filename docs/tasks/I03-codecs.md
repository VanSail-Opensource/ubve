# I03 — Owned AV1, TrueHD and lossless bridge adapters

**Status:** production adapters pending; v8 component/worker experiments are separate evidence. **Dependency:** I01; real selected packets come from I02. **Owner:** codec agent. **Owned paths:** new `packages/wasm-adapters/`, exact dependency/patch manifests, codec workers and fixtures. The integrator owns public type and workspace/lock migrations.

## Exact primary seams

Use the provider policy and ADR002: libmedia 1.3.1 AV1/dav1d atomic/SIMD, with common 2.3.0; focused TrueHD and FLAC encoder 1.66.4; npm libav.js 6.11.9/generated ABI 6.11.9.0.2 as the independently measured libaom baseline/custom-extension foundation. Preserve existing TurboRes 1.2.6 and AC-3/E-AC-3 profiles as historical extensions, not the primary v8 dependency order.

The real dav1d C exports are decoder_open/decode/receive/flush/close. The inspected package uses AV1 codec ID 225 and yuv420p10le format 62; verify them against the pinned generated types for every build. Preserve all original visible 16-bit storage bytes, actual strides/crop, decoded errors and color/HDR side data. Do not select a half-sized packed copy or convert to 8-bit to improve the reported rate.

Admit an exact configuration, including binary, requested threads and normalized decoder options. Default SIMD/four-thread decoding has retained pixel mismatches and remains blocked. The separate SIMD four/eight-thread candidate with `max_frame_delay=1` passed 96 component correctness trials, 4,608 ordered frame hashes and HDR comparisons in the companion `browser-dav1d-low-delay-correctness.json`; all requested options were consumed. That result does not repair the default configuration or prove a root cause, sustained performance or production playback. Keep the actual option dictionary/consumption and worker observations in every record. The embedded upstream version string identifies dav1d `1.4.1-63-g37155c11`, but the released build still lacks pinned custom C/pthread-source provenance.

The accompanying `bench-v8/libmedia` experiment is a useful implementation reference, not a conforming production Decoder. Its wrapper maps receive EAGAIN and EOF to no output; known-fixture count/hash checks complete that experiment's guard. Production must expose explicit EOS, retain a send-EAGAIN packet, drain available output and resubmit that same packet without duplication/loss. Do not assume one output per input or a known total frame count for general streams.

TrueHD/FLAC production factories consume packets from the central owner. AudioSampleSink whole-track scans are comparison conveniences, not the production packet seam. Expose exact current-command input lifetime, independent output, non-EOS partial-batch drain and awaited native close. Preserve integer-capable 24-bit samples, rate and speaker identity. A 4,096-sample aggregation is a candidate with declared rate-dependent latency; do not bridge across a real timestamp gap/edit/configuration epoch. Prefer colocating decode/aggregation/encode in one owned audio worker once that integration is measured.

## Common protocol and lifetime

Implement synchronous admission, accepted inputConsumed, bounded independent readOutput, non-EOS drain, tail flush, awaited reset readiness and terminal disposal. The output consumer remains active during flush so a full output queue cannot deadlock the tail. Detach settled-input deadline handlers; a later deadline must not invalidate good paused output. Delivered output belongs to its receiver.

Track codec parameters before population and close after any attempted open, including partial C allocation failure. Attempt independent releases and retain all errors; do not reuse a worker after failed cleanup. Timeouts stop further RPC without another full watchdog wait for disposal. Browser Worker.terminate is a termination request, not physical exit acknowledgement. Record actual constructor/terminate observations and any runtime registry evidence separately.

Read mastering metadata through the real generated struct API. The pinned cheap struct-array getter does not lazily map read-only AVRational elements; the corrected experiment uses actual sizeof/offsetof/mapStruct addresses and allocation bounds. Do not invent offsets from another FFmpeg version or interpret null metadata as successful preservation.

## Resources and variants

Reserve packets, decoder references, output pictures, PCM, aggregation, encoder buffers, module heaps and every host/child/pool worker. Record requested thread count separately from actual children. One/four-thread or atomic/SIMD component scaling is not a complete-player worker budget. Original six/seven-worker ProRes topologies are archived, not mandatory v8 defaults.

No JavaScript ledger can enforce an arbitrary third-party heap maximum. Expose enforced, estimated and opaque memory honestly. The current full-plane performance experiment reuses one output buffer; correctness hashing temporarily adds another canonical frame and is outside the performance timer. Production streaming cannot preload a movie or inherit a whole-clip CLI/VFS loop.

## Fixtures and exits

Validate all visible frames in ordered output, every conventional PCM scalar/channel and all HDR rationals/integers against independent references. Test genuine 60/120 fps sources at 720p, 1080p, 1440p and 2160p as named by the admitted matrix. Keep parsed profile/level/tier/tiles and source conformance separate from requested encoder options. A reference pixel match does not by itself complete AV1 Annex A/E model conformance or physical HDR.

Failure fixtures include failed open, malformed/oversized input, cancellation during accepted work, zero/multiple/delayed/EOS-only output, full output queue at flush, reset while output is pending, stale reply, worker crash, close during initialization and multiple cleanup failures. The existing pure-JS lifecycle tests and real struct-memory tests are narrow evidence; actual codec failure integration remains required.

**Existing:** source/check/build/unit commands after real package wiring. **TO CREATE:** test:codecs and real worker/browser adapter fixtures. Do not run builds/tests during reserved measurements. Success requires the bounded production protocol and exact named outputs, not merely registering a decoder. Hardware output remains deferred. I05 consumes these adapters; I06/I12 qualify the complete selected pipeline.
