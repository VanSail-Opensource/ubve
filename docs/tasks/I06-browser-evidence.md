# I06 — Strict full-pipeline evidence and failure injection

**Status:** pending for the production player. Component, parser, Node, CPU-raster and unpaced decoder results cannot complete this task. **Dependency:** I05 with all selected tracks active. **Owner:** browser qualification agent. **Owned paths:** real implementation qualification/bench runner and records; policy changes require integrator review.

## Authority and execution protocol

The accompanying v8 `evidence-kit/qualification/verdict.py` and record.schema.json are the executable authority. The proposed policy records their identity. The old 0.995/three-by-300-second gate is archived and superseded; no tolerated eligible-picture loss can satisfy the new strict gate.

Reserve exclusive measurement time. Freeze source/lock/harness/module/fixture hashes and record actual browser/OS/device/CPU quota/memory/worker topology/isolation and sink/output mode. Unknown metrics stay null with reasons. Activate the real window and tab, record focus/visibility/cadence and transitions; visibility alone did not prove foreground in earlier experiments. Retain failed and contaminated attempts.

Use the actual I05 player and one bounded source owner. Managed cases disable native codec APIs; native cases are labeled separately. Native/GPU/physical-output execution remains DEFERRED_NOT_QUALIFIED by user request here. Preloaded short clips are not large-file streaming evidence. Separate fetch/demux/init/warmup/startup from declared steady measurement and retain EOS/tail work.

## Strict modes and denominators

Full-60 requires a genuine 60/1 source at 1×; performance-120 requires 120/1 at 1× plus an explicit accepted quality transform. Count unique source-picture opportunities with deadlines, including every late, dropped and unsubmitted picture. Repeats, interpolation, rAF callbacks and decoded-only output cannot populate the on-time numerator.

The evaluator requires at least **five independent sustained trials** per exact record: **1,800 active seconds each for Windows/macOS**, **3,600 each for iOS/iPadOS/Android**. Every eligible picture must be on time; late/dropped counts and audio-underrun samples are zero. The eligible denominator equals active duration×target, the final steady window remains at target, memory stays within its admitted budget and foreground continuity is verified. The evaluator's maximum freeze allowance is two source intervals; it does not relax zero eligible misses.

Full fidelity includes source precision/resolution, no temporal reduction, HDR10 metadata, correct PQ/BT.2020 output,10-bit samples, exact decoder PCM, subtitle semantics/fonts and timeline/channels. Performance mode retains no temporal reduction, exact decoded TrueHD PCM, required subtitle content/timing and timeline/channels, and validates its declared transform against reference. Optional Dolby Vision adds its own rendering gate and is not inferred from HDR10.

A browser-full-pipeline pass is PASS_PIPELINE_ONLY. PASS_EXACT_CONFIGURATION additionally requires verified physical HDR/audio/subtitle output, active display refresh at least target, physical A/V sync p95≤20ms and max≤50ms. Component figures or omitted hardware fields cannot pass. Actual conformance and exact configuration/asset hashes are mandatory; source-generation intent is insufficient.

## Failure and recovery evidence

Measure startup, pause/seek/reset/dispose, source starvation, malformed decode, full queues, renderer/context failure, forced audio underrun, stale generations, worker crash, partial initialization and recovery exhaustion through real APIs. Integrated recovery preserves the exact resume sample/picture interval and first-picture/start order; it is separate from uninterrupted steady state.

Store decoded/submitted/composition/physical rates separately. Worklet counters are not CPU time; draw completion is not scanout. Use repeated independent trials, not pooled per-frame samples as independent repeats. Short screening runs may guide I11 but remain screening.

**Existing:** current source/check/build/unit and separately scoped experiment commands. **TO CREATE:** actual bench:browser/test:browser full-player lanes. Success is exact reproducible evidence with all relevant gates met. Failure preserves raw records, prevents promotion and identifies the next demonstrated bottleneck. I12 alone derives support from matching evidence.
