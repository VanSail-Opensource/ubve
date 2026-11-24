# I11 | Optimization and promotion boundaries

The managed CPU candidate spent substantial time converting raw PQ/BT.2020 frames for a declared SDR Canvas output. The presentation implementation now reuses working buffers and sampling geometry and uses bounded transfer-function lookup tables. The reference and paired component test remain checked in. The paired conversion compared three actual 720p source frames and found a one-byte maximum output difference in 12 of 11,059,200 RGBA scalars. The median component speedup was approximately 3.3×. This is a declared SDR transform, not source-precision full HDR output.

A separate real-browser paired screen tested output caps of 720p and 360p with the same pinned 720p60 input and selected tracks. Its small first-play improvement did not justify losing 75% of output pixels, so the 720p cap remains. See [the raster experiment](I11-canvas-raster-screening.md) for the exact screening boundary.

The combined short managed route completed all 15 executed cases. It still logged late submissions. Short software conversion, use of native MSE and decoded pictures alone do not establish sustained on-time output. No route was promoted to 60/120 fps qualification. Do not combine component timers into a complete-player estimate. Default four-thread SIMD remains blocked, and the native and GPU endpoint exits remain distinct.

Reproduce the scoped conversion comparison after a locked build with `node test/presentation-color-benchmark.mjs` and the declared source inputs documented in the script. Keep execution receipts separate from the production ability report.
