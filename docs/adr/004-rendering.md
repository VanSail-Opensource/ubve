# ADR 004 — Preserve HDR output semantics and bounded presentation

**Status:** v8 route policy selected; production renderer and exact endpoint qualification pending I04/I06/I08/I11. Native, GPU and physical-output execution is deferred by the user. Historical raw-frame Canvas measurements remain evidence only for their recorded SDR workload.

## Priority and admission

Preserve an admitted encoded HDR video stream and the browser's media clock where possible. Direct media-element playback, lossless stream copy into an accepted container, and the separately qualified TrueHD-to-FLAC soundtrack bridge precede unnecessary managed video decode. A WebCodecs decoder is a browser-native decode API; WebGPU is a compute/composition API and does not expose a standardized hardware bitstream decoder. Website JavaScript cannot directly call Media Foundation, VideoToolbox or Android MediaCodec.

For a managed decode route, preserve I420P10 planes and HDR interpretation until the declared output transformation. A WebGPU high-precision compositor is a candidate, subject to exact format, color-management and endpoint evidence. A raw `VideoFrame(data, init)` constructor is a presentation-buffer API, not a native codec call. API or context existence is admission information, not a demonstrated 60/120 fps path. All production routes require matching qualified profiles and budgets; absent native/GPU evidence remains `DEFERRED_NOT_QUALIFIED`.

The historical I422P10 raw-VideoFrame-to-Canvas2D route and floating/Q16 RGB8 conversions remain SDR comparison fixtures. They are not HDR10 output implementations. Their old 99.5% proposal is superseded by the executable v8 zero-eligible-miss gate. Faster short submissions do not qualify full-quality 60 fps or declared performance-mode 120 fps.

## Startup, resources and attempts

Create a fresh canvas for each renderer attempt. A canvas that acquired one context and then failed format/shader setup is not assumed reusable with another context. Dispose failed resources and preserve the failure ledger. Never cycle through unlimited attempts to hide an unsupported route.

Before managed audio starts, decode the containing target picture, validate it, prepare the renderer, complete the first import/upload/draw and attach the intended host. Account this work as startup. Only then choose a future audio anchor; if first-use work consumes its margin, choose a new anchor rather than silently starting with an A/V phase error. For a native single-clock route, retain the media element's own ready/play/pause/seek semantics and verify equivalent source state.

Raw VideoFrame construction without transfer copies source bytes. Its source buffer must remain stable through construction. Close temporary frames in `finally`, including failure, and distinguish application handles from browser/GPU storage. Reserve actual stride-based allocations, transient copies and decoder references. Opaque native/GPU allocations remain explicitly unknown or justified estimates; they are not free memory.

## Layout, HDR and subtitle semantics

Validate checked dimensions, offsets, strides, plane extents, crop, nominal sample range and color fields. I420P10 uses 10-bit sample values in 16-bit little-endian storage; it is not interchangeable with an MSB-aligned P010 layout. Test padded/cropped planes, chroma siting, limited/full range, ramps and color/chroma edges. Do not infer BT.709 or another interpretation from resolution. Preserve original unknown metadata when a caller explicitly declares an interpretation override.

WebCodecs color fields do not provide standard raw-VideoFrame setters for HDR10 mastering-display or content-light metadata. A constructor accepting PQ/BT.2020 therefore does not prove static metadata reached the display. A linear high-precision WebGPU target, extended canvas tone mapping or display-P3 support also needs a documented source-to-output transform and actual HDR endpoint validation. Do not relabel RGB8 Canvas output or an unverified browser color conversion as full HDR10.

Full mode preserves required subtitle events, shaping, fonts, timing, effects and the declared raster/output semantics. Performance mode may admit a separately declared subtitle raster cap, video output scaling or other explicit quality change. Such a profile must still meet its genuine 120 fps source deadline; omitted source frames cannot manufacture a 120 fps claim. Output scaling alone does not reduce AV1 entropy/reference decoding work.

DOM/Canvas subtitle overlays may be absent from native video fullscreen or ordinary video picture-in-picture. Container fullscreen and Document Picture-in-Picture are separate capability profiles. If the exact presentation mode cannot preserve required subtitles, refuse or explain that mode before entering it; do not silently remove the subtitles.

## Scheduling, recovery and evidence

Managed presentation follows the consumed source-sample anchor while audio is active. Select the picture containing media time, release obsolete pictures and enforce the admitted application-slot and byte caps. Count every eligible source-picture opportunity, including unsubmitted or dropped pictures. Submission completion, animation-frame cadence and `requestVideoFrameCallback` metadata are distinct from physical scanout.

Latched audio starvation freezes logical media and holds the acknowledged picture. Recovery reconstructs the exact source state under existing budgets. A declared, already-qualified lower output profile may follow bounded recovery exhaustion only when policy allows it; no silent channel, bit-depth, HDR or subtitle change is permitted. Failed fallback is terminal.

Record decode, raw copy/import, CPU conversion, upload/submit, subtitle raster/composition, queue occupancy, drops, late completions and handle balances separately. Use valid asynchronous GPU timing only in a later authorized GPU environment; unknown timing remains null. The accompanying evidence-kit evaluator owns the strict full-60/performance-120 qualification. Physical output, HDR fidelity, 120 Hz presentation and sustained endpoint behavior require their own evidence and remain deferred here.
