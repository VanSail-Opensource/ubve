# I11 — Optimization candidate assessment

**Status: BLOCKED_BY_I06; no measured full-pipeline promotion.**

Integration review identified a concrete admission bug: tiny TrueHD output blocks
could each occupy an entire AudioWorklet transport buffer. A 12-buffer pool then
filled before the 40 ms priming target. The I05 implementation now accumulates
contiguous PCM into 960-frame transport blocks, preserves the exact decoded
sample cursor and flushes the EOS tail. This is an implementation correctness
fix and a batching candidate; it is not a measured speedup.

The next paired experiment must freeze the same source, codec assets, channels,
sample rate, output transform and worker budgets. Compare the unbatched baseline
and batched implementation in serial alternating order, at least three independent
runs each, with exact aggregate PCM verification before timing. Count startup,
buffer occupancy, source picture opportunities, render lateness, worklet underrun
samples and disposal separately. Retain every failed or contaminated attempt.

The current workspace has no permitted browser execution result. No baseline or
candidate timing is fabricated, no test duration is a performance observation,
and no component timing is added to another component to infer playback FPS.
The v8 default SIMD/four-thread failures stay blocked. Atomic/four-thread is a
separate candidate whose complete route still needs I06 and the strict I12 gate.

| Required observation | Current value |
| --- | --- |
| Full pipeline paired baseline/candidate | Not executed |
| Reference-equal output after batching | Decoder/component checks only; integrated result pending |
| Full 60 unique source pictures/s, zero misses | Not qualified |
| Performance 120 unique source pictures/s, zero misses | Not qualified |
| Sustained/endurance and physical output | Not executed / deferred |

Do not promote the batching change as a proven 4K60/120 optimization until these
measurements and the corresponding correctness/resource checks pass.
