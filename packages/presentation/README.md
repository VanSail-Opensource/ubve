# UBVE presentation candidates

This package is the I04/I09 implementation. It preserves the distinction between
decoded media, graph/draw submission and physical presentation. No profile here
is a qualified full-HDR 60 fps or reduced-quality 120 fps playback endpoint.

## PCM and color

`PcmOutput` owns a fixed transferable pool and an AudioWorklet. It enforces a
continuous source-sample sequence per epoch, actual-start acknowledgement, paused
sample freezing, a latched first missing sample, explicit EOS, and terminal
disposal. The producer must aggregate small decoded chunks into transport blocks;
40-sample TrueHD chunks must not consume separate 960-frame pool slots. Every
accepted buffer returns to its owner. Channel labels describe source identity;
the device's physical speaker mapping remains unverified. The graph requests the
source sample rate and refuses a changed rate; no hidden resampler is installed.

`RawCanvasRenderer` is an operational SDR fallback. Its PQ/BT.2020 conversion is
an explicit reduction with a declared 203-nit reference white, luminance-preserving
Reinhard mapping, nearest-sample spatial reduction and sRGB gamut clipping. It is
not a full HDR renderer or a qualified image resampler. The native encoded-video
route remains preferred. `WebGpuRawRenderer` is a separately admitted source
candidate using integer YUV textures and explicit chroma siting. Its HDR mode
requires retained rgba16float, display-p3-linear and extended-tone configuration.
Configuration success still does not establish a physical HDR output. GPU
execution is deferred in this environment.

## Selected subtitles

- ASS/SSA uses pinned JASSUB 2.5.38 and its packed eight-word bitmap ABI. The asset
  builder checks the exact upstream source before pinning one renderer thread
  (zero pthread children) and validating descriptor/bitmap extents. WASM bytes are
  unchanged. The generated manifest binds all workers, WASM and bundled font
  hashes. Attached fonts are preflighted; remote lookup and local font permission
  prompts are disabled. The worker receives the bounded bundled fallback font
  before readiness so the first cue cannot depend on a background font reload.
  Missing families are visible, not silently called exact.
- Native WebVTT is used with the native-video clock. Managed playback admits a
  separate basic text profile: timing, line breaks, b/i/u and alignment. CSS,
  regions, vertical writing and richer WebVTT markup are refused in that profile.
  SRT is converted only when its selected semantics map to WebVTT.
- IMSC text uses imscJS 2.0.0. XML size/depth/element/event limits precede rendering.
  External entities, stylesheet processing, and image/external resource URLs are
  refused. Images require a future explicitly selected resource pack. Parser
  warnings remain diagnostics; errors fail the selected track.
- PGS uses an independent bounded TypeScript decoder candidate. This is a
  documented implementation change from the proposed FFmpeg C subtitle shim,
  which is not claimed complete. The decoder implements palette/object/window
  state, fragmented objects, forced/cropped rectangles, clear events, 90 kHz PTS
  wrap, checked RLE and explicit BT.709/BT.601 limited-range palette policy. It
  rejects incomplete sidecars, malformed object fragments and oversized display
  canvases before exposing them as valid output. It does not infer sRGB or HDR
  palette interpretation from the filename. Native-reference raster comparison
  remains a separate admission step.

For streaming ASS, load CodecPrivate once and await `addPacket()` for each central
reader packet. The exact upstream C wrapper passes chunk timestamps/durations to
libass in **milliseconds**; raw draw uses **seconds**. `resetStream(newEpoch)`
recreates track state, including duplicate ReadOrder handling; the packet provider
must supply seek/preroll cues again. Unknown or zero durations and intervals
that need sub-millisecond precision are refused by this pinned provider path.
Supply optional fonts as bounded attachments, not inline `[Fonts]` or `[Graphics]`
sections. The one bounded source reader remains responsible for subtitle packets.

Positive subtitle offset delays cues. `renderAt()` uses the managed source clock;
call `setExternalClock(true)` before loading a managed text track. Performance
mode caps ASS raster height at 1080 while preserving script layout/timing/effects.
Ordinary video PiP/native fullscreen cannot retain custom sibling overlays and
are refused for required custom subtitles. Container fullscreen is separate.

## Verification

Run from repository root:

```sh
npx tsc -b packages/core packages/presentation
npx tsc -p packages/presentation/tsconfig.worklet.json
node scripts/prepare-presentation-assets.mjs
node --test test/presentation*.test.mjs
node test/presentation-browser.mjs
node scripts/serve-presentation-harness.mjs
```

The automated browser runner checks cancelled starts, starvation and recovery,
ASS raster changes across a cue boundary and backward seek, and IMSC cue timing.
The final command serves an interactive harness with a Run button and JSON
evidence. Use the hosted CI browser lane when local Chromium cannot start. Asset
preparation, Node protocol/color and PGS/text tests, the real browser component
checks, and full-player qualification are separate evidence classes.

The helper copies license notices next to self-hosted assets. Review the source
package's combined license obligations before redistributing changed binaries.

Primary upstream API references: [JASSUB source](https://github.com/ThaUnknown/jassub),
[libass chunk timing contract](https://github.com/libass/libass/blob/master/libass/ass.h),
[imscJS source](https://github.com/sandflow/imscJS), and the attached v8 plan.
