# ADR 005 — Source-sample clock, first-picture priming and latched recovery

**Status:** selected managed-audio protocol; the historical isolated worklet v2 passed 17 assertions. Actual v8 codec/video/subtitle integration and output qualification remain pending I03–I06. Native single-clock routes follow their own media-element clock.

## Clock and delivery

The v8 primary source is conventional TrueHD channel audio with its original precision, layout and rate. The six-channel 48 kHz fixture is an example, not permission to downmix other sources. Preserve an exact integer-capable PCM representation through decode/reference comparison and any lossless FLAC encoding. Float32 can represent normalized signed 24-bit PCM exactly, but later mixing, resampling and device processing require their own output contract. The preserved core's existing float32 output type does not by itself implement the pending integer/HDR migrations.

Prefer an admitted native single-clock video/FLAC route when the exact browser/container/layout combination accepts it. Batch a bounded number of decoded PCM samples per FLAC/fMP4 operation and verify every conventional PCM scalar, channel and timestamp. The proposed 4,096-sample aggregation is a candidate, not a universal optimum. Lossless channel PCM does not retain TrueHD compressed identity or Atmos objects. A native-video plus managed-audio hybrid needs a measured drift controller and an explicit clock authority; two independently running clocks are not synchronized by assumption.

Exact PCM scalar equality does not establish speaker identity through a native reader. Chromium source at revision `8aff45122317ba7b921cdc8fcb3c9af9773d54df` gives a narrow MSE/Symphonia candidate for six-channel 5.1(side): the MP4 parser guesses that layout and the decoder wrapper retains a valid same-count configuration. It does not demonstrate arbitrary FLAC mask propagation, a shipped stable backend or actual speakers. I08 owns the source/encoded/reader/decoder/output mapping gate. Keep side/back layouts distinct and unverified mappings unqualified.

For the managed worklet route, a dedicated feeder prepares bounded 960-frame blocks and sends them directly by MessagePort using a transferable pool. A 12-block, six-channel float32 pool occupies 276,480 payload bytes, excluding codec heaps and other buffers. The main thread handles controls/snapshots and rendering, not routine PCM delivery. An isolated SharedArrayBuffer ring is a separate lane until its ownership/atomic protocol passes; isolation is not a reason to skip transfer-pool correctness. The historical stereo workload validates only its recorded protocol scope.

Each block has epoch, first media sample, frame count, sample rate, channel layout and one owned backing store. The worklet tracks `nextExpectedMediaSample` and actual quantum length. While consuming, an acknowledged AudioAnchor maps graph frames to source samples. While stopped/paused/starved, logical media is frozen even though AudioContext time may advance. Graph time alone is not consumed source audio.

Use the default user output sink in the product. The measured silent sink is a legitimate real-time graph experiment but no audible-device evidence. Actual sample rate must equal the admitted rate; otherwise fail `E_RATE_UNQUALIFIED` until the selected resampler has its own qualified delay/count policy. No hidden per-block stateless resampling or silent channel remix.

## Start, pause and EOS

Before audio starts, prime at least 9,600 frames (200 ms) and decode/import/draw the first target video frame. Complete renderer allocation/first-use work first, then schedule a graph start at least 50 ms in the future, aligned to the observed graph quantum when required. A schedule acknowledgement means accepted scheduling; `Session.play` resolves only on the actual started event. Reject an anchor that arrived too late and permit one future-anchor retry. Never conceal a late start as an arbitrary new phase.

Pause is acknowledged after worklet consumption actually stops and returns the next expected sample. Queued same-epoch data may remain for resume under capacity limits; resume installs a new graph anchor at that sample. Seek changes epoch, reconstructs decoder preroll, trims to the exact audio target, selects the containing video interval and preserves playing/paused intent.

Declare the exact final media sample at EOS. Consume precisely that interval, produce segment-complete acknowledgement and release unused queued data. An intentionally declared endpoint is not an underrun. Steady benchmark completion uses this acknowledgement with an independent wall watchdog, not an outer timer that truncates the last audio samples.

## First missing active sample

1. The worklet immediately stops source consumption, zero-fills the remaining quantum and future output, and latches once with `underrun(epoch, boundaryGraphFrame, nextExpectedMediaSample)`. It does this before waiting for the main thread.
2. Late same-epoch PCM cannot restart it. Reject/return it. The supervisor freezes logical media at the reported missing sample and holds video; the missing sample equals last consumed plus one.
3. Invalidate the old epoch, cancel reads/decodes and return obsolete buffers. Reuse source/index state but reset or recreate required codec state behind the readiness barrier.
4. Reconstruct/preroll at the exact resume sample. Prime 200 ms and the containing video picture within the existing byte/item caps. Deadline is 5 s; do not enlarge queues to hide starvation.
5. Prepare and submit the first resume picture, install a new future graph anchor, await actual start, then resume logical media from that exact sample.
6. Permit at most two recoveries within 30 s and six per open. Exhaustion permits one declared already-qualified lower output-resolution profile only if policy allows; otherwise return `INTERNAL` with `details.reason = E_RENDER_BUDGET`. An underrun after fallback is terminal; do not oscillate back to the failing profile.

State transitions are `playing → rebuffering → playing` or `failed`; pause/seek/dispose supersede an in-flight recovery by epoch. A paused user's intent never becomes playing just because a recovery completed.

## Observed isolated protocol evidence

The historical companion record `previous/v7/bench/audio-recovery/results/browser-result-20261124T120938-8eb8383762ab.json` records a real worklet/direct producer worker: 17 assertions passed, one deliberate starvation at sample 2880, no consumption while latched (including after a late same-epoch block), stale-epoch rejection, 200 ms reprime, acknowledged pause/resume/seek/dispose, 14,400 consumed frames and 28,800 exact scalar comparisons with zero mismatch/continuity error. All 26 transferred buffers returned; 7,680 queued frames were disposed. Source v1/v2 hashes and raw results remain separate. That companion path is outside this standalone starter.

That protocol uses deterministic generated PCM, no media decoder/video or physical sound. The common-container playback prototype still uses the older measurement worklet and main-thread feeder. Therefore I04/I05 must integrate these semantics with the actual codec, renderer and public Session; I06 must deliberately stall that real pipeline and verify recovery, not cite two separate passing experiments as if integration had happened.
