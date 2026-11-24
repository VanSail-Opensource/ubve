# I11 — Optimize one demonstrated full-pipeline bottleneck

**Status:** pending integrated-player optimization; current v7/v8 component experiments are research inputs. **Dependency:** I06. **Owner:** measured-bottleneck agent. **Owned paths:** one explicitly assigned production implementation and its dedicated candidate benchmark; integrator owns policy/default promotion.

## v8 candidate order

Preserve native HDR surfaces and clocking first. Candidate CPU changes include colocated/batched exact PCM→FLAC, dav1d atomic/SIMD and actual thread/tile structure, JASSUB 2.5.38 unchanged-state/pool handling, declared subtitle raster cap, shared cue/font/demux work and reduced-copy transport. The full-player scheduler owns combined worker grants. No GPU/native measurement is executed in the current environment.

The strict release target is zero eligible misses at full 60 fps/performance 120 fps, with the executable evidence-kit verdict authoritative. A component improvement may be retained while the complete target remains unqualified. Source scaling, grain changes and effect changes require declared fidelity; output/CSS downscale alone does not reduce AV1 entropy/reference decode.

The completed reduced-video experiment narrows the next hypothesis. All same-original-4K half-output trials remain below 120 pictures/s; its JavaScript nearest-sample handoff is slower than full row copies in all twelve matched groups. Do not promote that implementation as a cheaper copy path. The three precomputed 720p/120-source alternatives exceed 120 in every atomic/four-thread component observation, with a minimum of 129.52, while the difficult 1080p alternative still misses 60 in its median. Treat an available lower-resolution rendition as a distinct lossy input with its own source/HDR/PTS/bitrate identity, not faster reconstruction of the original 4K stream or free live transcoding. Its simultaneous audio/subtitle/output route still needs I06. See the companion `bench-v8/results/reduced-video-summary.json` and plan §8.8.

## Select the hypothesis from evidence

Use I06's all-opportunity frame loss/lateness, import/conversion/draw cost, audio missing frames, read/decode queue occupancy and resource totals to choose one bottleneck. Do not optimize a decoder microbenchmark when conversion, main-thread scheduling or source I/O dominates. Current prototype evidence supports testing rawVideoFrame import over floating JavaScript YUV conversion, and isolating the audio feeder; it does not guarantee the final product's 4K deadline.

Write before coding: exact hypothesis, affected workload/profile, correctness invariant, selected timer boundary, source/assets/settings, expected benefit, measurable failure exit and rollback. Freeze baseline. Candidate gets its own version/hash; retain baseline source/raw evidence. No CPU tests or candidate timings run concurrently with another browser reservation.

## Paired method

Use the same compressed fixture, decoder precision/chroma, source color/override, output dimensions/transform, worker/memory budgets, media interval and foreground state. Warmup/init/EOS definitions match. Execute serially with an alternating or predetermined randomized baseline/candidate order and at least 3 independent repetitions each. Report per-run medians/tails/counts plus between-run spread; do not treat every frame as an independent benchmark repetition.

Validate output before speed promotion. For Q16, the one-RGB8-code bound is against the exact floating baseline for valid input; it is not a browser VideoFrame/color-conformance bound. If browser conversion changes observable color/filter behavior, qualify that exact transform rather than declaring equivalent from black/white endpoints. Account additional buffers/copies/worker/module memory.

Keep startup and steady execution separate. First target picture is already primed before audio start in both variants. Completion is the same worklet acknowledged scheduled media interval, not wall timer for one and graph timer for another. Reject focus/cadence contamination; retain it as failed evidence.

## Gates and allowed conclusions

A faster CPU median alone cannot promote a route. Require identical admitted output semantics, zero eligible missed/late source pictures, no unintended underruns/stale output/leaks and an improved targeted metric under the same budgets. The executable v8 verdict requires full-quality 60 fps or declared performance-mode 120 fps at genuine source cadence in every required sustained qualification trial. The archived 99.5% proposal is not an alternative gate. If the full gate still fails, record “faster experimental candidate, unqualified” and keep the restricted fallback/error behavior.

One explicitly selected lower spatial output-resolution profile may be evaluated separately. It is a changed output workload with declared transformation, not an equivalent-resolution speedup. Never silently lower source bit depth/chroma, channels or quality and call that optimization.

## Verification and exits

**Existing:** actual check/build/unit commands and current evidence inspection. **TO CREATE:** `npm run bench:paired`, with baseline/candidate immutable paths, all raw attempts and a correctness comparison. Run affected real browser regression lane plus targeted unit/adapter fixtures before performance trials, not during them.

Success: reproducible full-pipeline benefit and preserved correctness/resource gates for the named profile; integrator updates only that profile/default with evidence IDs. Failure/noise/regression: retain result, revert candidate default, state the remaining bottleneck and stop optional testing once that concrete hypothesis is answered. No indefinite loop of favorable reruns.

**Next:** I12 releases the exact validated configuration; unqualified 4K remains unqualified regardless of a large relative speedup.
