# ADR 002 — v8 selected providers and native priority

**Status:** exact source selections and component evidence; production adapters, full-player integration and target-device qualification remain pending. This ADR supersedes ProRes-first priority and obsolete provider pins without changing historical source/test results.

## Core and deployment contract

Retain Node 24.22.3, npm 11.19.1, TypeScript 5.9.3 and the existing starter lock. No new production dependency is installed by this documentation migration. The product remains browser-only static assets: no required backend, installed helper, native messaging host or hidden codec/font CDN. Browser APIs mediate native platform decoders; WebGPU provides graphics/compute, not a fixed-function codec API.

Prefer eligible native encoded HDR video and one media clock. N0 accepts the original tuple; N1 changes packaging only; N2 explicitly bridges exact conventional TrueHD channel PCM to lossless FLAC/fMP4 while preserving encoded video. N3's separate PCM graph requires a two-clock qualification. Custom WebCodecs/WebGPU and managed source decode have independent exact output contracts. Native/GPU measurements are deferred by the user, not counted as passes.

## Selected providers and exact identities

| Responsibility | Pin | Production seam and evidence boundary |
|---|---|---|
| Source demux | Mediabunny 1.66.4 | One bounded selected-track provider; complete ASS/attachment/HDR/timing exposure may need a narrow versioned adapter. |
| Primary managed AV1 | `@libmedia/avcodec`, `avformat`, `avutil`, `cheap` 1.3.1; `common` 2.3.0 | Real dav1d C ABI and original high-depth planes; pinned atomic/SIMD release binaries. The browser experiment is not yet the production Decoder contract. |
| Conventional TrueHD | `@mediabunny/truehd` 1.66.4 | Owned packet-fed decoder factory, exact integer-capable channel PCM, explicit input/drain/reset/close semantics. |
| Lossless N2 audio bridge | `@mediabunny/flac-encoder` 1.66.4 | Prefer the same owned audio worker; exact PCM aggregation, channel/rate/timeline preservation and independent round trip. |
| AV1 baseline / custom extension foundation | npm `libav.js` **6.11.9**, generated ABI **6.11.9.0.2**, FFmpeg **9.0.2** | Package version and generated filenames are different identities. Published libaom comparison does not make arbitrary custom decoder/demux variants available. |
| Portable common codecs | Owned FFmpeg **9.0.2** / libaom **b141d9c4** decoder-only WASM, Emscripten **6.0.0** | Dedicated per-track worker, explicit send/receive and EOF ABI, no shared memory or container/CLI API. The build manifest pins the exact sources and artifacts. AC-3/E-AC-3/DTS Core use this shared packet seam in the managed candidate. The earlier extension pins remain separate historical candidates. |
| Required ASS | JASSUB **2.5.38** | Exact packed eight-word raw descriptor ABI, correct unchanged-frame handling, explicit pool count and owned fonts/lifetime. Version 2.5.14 remains historical baseline only. |
| PGS | Selected FFmpeg 9.0.2 `pgssub` C subtitle shim | Actual `avcodec_decode_subtitle2`/`avsubtitle_free` ownership; not ordinary video ff_decode_multi. Build and admit before enabling. |
| Extreme baseline | Official `@ffmpeg/core` and `core-mt` **0.12.10**, FFmpeg 5.1.4 | Explicit experimental whole-clip CLI/VFS comparison; not the production streaming default. Preserve version-specific demux failures. |
| Retained historical ProRes / AC-3 | TurboRes 1.2.6 / `@mediabunny/ac3` 1.66.4 | Keep prior evidence and exact profiles; they no longer define the first v8 release workload. |
| Conventional DTS / resampling | `@mediabunny/dts` 1.66.4 / libsamplerate 0.2.2 | Separate codec/layout/rate and DSP qualification; no object-rendering implication. |
| Local disc | libudfread 1.2.0 / libbluray 1.5.0 | Restricted read-only local extent/title path; no whole-ISO extraction. |

The [provider policy](../policies/providers.proposed.json) preserves exact npm integrities, known experimental WASM hashes and source pins. Top-level production artifact hashes/qualifiedProfiles remain unpopulated until the actual integrated adapter is built and admitted. A known decoder binary hash alone is not an exact player-profile pass.

## Owned seams and known API corrections

AudioSampleSink is a comparison convenience that reads the selected track. It cannot implement production packet-fed admission while competing with the central demux owner. Expose exact per-command input lifetime, independent output, non-EOS drain and awaited close from the selected audio packages. Batch contiguous PCM without concealing genuine source gaps, edits or discontinuities. Plain FLAC preserves conventional samples, not TrueHD bitstream identity or Atmos objects.

The libmedia receive wrapper merges EAGAIN and EOF into no output. Known-fixture experiments additionally check every expected frame/hash. Production needs an explicit EOS seam and must drain/resubmit the same retained packet on send EAGAIN. Close after every attempted open, including partial failure; attempt cleanup stages independently and quarantine a worker after cleanup error. Worker.terminate is a request, not an exit acknowledgement.

Default SIMD/four-thread decoding is blocked by retained pixel mismatches. The separate four/eight-thread SIMD configuration with consumed `max_frame_delay=1` passed 96 bounded component correctness trials; it remains an experimental candidate, without production or complete-playback promotion. Bind evidence to normalized options, exact binaries and actual worker observations. Both release binaries embed dav1d `1.4.1-63-g37155c11`; exact custom C/threading patches and source-to-binary reproduction are still incomplete.

Use exact ABI-backed HDR field access, not assumed JS struct-array indexing. The pinned cheap struct-array read getter does not lazily create each mapped rational; the corrected experiment uses actual sizeof/offsetof/mapStruct addresses with bounds checks. Passing decoded planes is separate from interpreted HDR output.

JASSUB 2.5.38 returns packed descriptors and fixes the historical static-image return bug. Explicitly control the initialization pool; setThreads(1) alone did not remove the old preallocated pool. Report bitmap-return counts, pixel changes, raster time, upload and composition as different observations.

## Resource and support policy

Select worker counts for the complete player; do not assign four threads independently to video, audio and subtitles. Count coordinators, active/idle child pools, runtime heaps, decoder reference pictures and temporary copies. Historical six/seven-worker and 256/512 MiB policies are archived proposals, not universal v8 requirements or enforced heaps.

Reject silent quality changes, missing required subtitles, unsupported HDR interpretation and invented container mappings. Strict source-selected examples need actual mapping/decoder admission. Stock FFmpeg 5.1.4 directly maps NUT/WavPack `wvpk` through its extra audio table, and published core 0.12.10 automatically decodes the inspected fixture to exact PCM; the earlier absence inference was an audit error. NUT/TrueHD has no examined valid stock mapping, and stock AVI does not accept ASS. Embedded ASS/NUT remains blocked by lost cue duration. Any input decoder override remains explicitly labeled, and is unnecessary for this admitted WavPack source. Broad native absence remains unverified until a tested endpoint rejects the exact tuple.

I03 integrates primary codecs; I09 supplies selected subtitle/extension components; I08 integrates native/remux/bridge; I05 assembles and I06/I12 qualify. A source/build/API/component pass cannot promote an absent production route.

## UI and browser-test source pins

The retained v7 source-selected set is Vue3.5.46, @vitejs/plugin-vue6.0.11, Vite8.3.8, vue-tsc3.3.14 and @playwright/test1.62.1 (matching playwright/playwright-core). These pins were inspected previously; they were not newly installed or qualified by this migration. I05 must lock actual transitive/platform assets and run real TypeScript/SFC/browser checks. Vite transpilation does not replace vue-tsc. Native/GPU tests remain deferred in the current environment.
