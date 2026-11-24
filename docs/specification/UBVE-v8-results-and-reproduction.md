# Universal Browser Video Engine v8: results and reproduction

**Research cutoff: 24 November 2026, Asia/Shanghai. Primary workload: AV1 10-bit HDR10, conventional TrueHD channel audio and required complex subtitles. Release status: NOT QUALIFIED.** Dolby Vision remains an optional, independently qualified extension.

The work produced faster software-decoder candidates, an exact lossless-audio bridge, improved subtitle raster handling, valid combined fixtures and reproducible evidence. It has **not** demonstrated the requested complete 4K60 full-quality or 4K120 reduced-quality playback gate across the five target operating systems. Demanding 4K software inputs remain below 60 decoded pictures/s before adding the complete player workload. Native/GPU performance and physical output remain deferred under the user's instruction.

This report summarizes completed component evidence. It accompanies the [v8 plan](Universal-Browser-Video-Engine-v8.0.md), [implementation starter](implementation-starter-v8/docs/START-HERE.md) and [qualification contracts](../evidence-kit/qualification/README.md). The reduced-video results use independently audited cohorts. The difficult-format result section is finalized separately from its own retained protocol and raw records.

## 1. What was measured

The browser host is **Chrome 156 on Linux**, reporting nine logical processors and cross-origin isolation. It is separate from the researched latest Windows, macOS, iOS, iPadOS and Android installations. Timed suites run serially with other owned codec, encoder, build and reference jobs paused. Browser-native decoder globals are disabled in the software experiments. Native FFmpeg prepares fixtures and independent references; its elapsed time is not browser-native performance.

The primary HDR corpus has 28 sources: four signal patterns and 24 textured cases covering 720p, 1080p, 1440p and 4K; genuine 60/120 source cadence; and 4/20/80 Mbit/s encoder targets. Each has 48 displayed pictures. Samples are generated numerically in PQ/BT.2020, with low-bit witnesses and actual mastering/content-light metadata. Earlier SDR imagery merely tagged PQ remains diagnostic. The final AV1 tier repair, unchanged coded/HDR data and before/after pixel checks are retained; complete Annex E buffering conformance remains unverified. See [source validity and environment](plan-parts/06-executed-evidence.md).

## 2. AV1: faster candidates, persistent 4K limits

The original four-cohort summary contains **216 groups, 648 measured trials and 216 separately labeled warmups**. The first three cohorts contribute 192 groups/576 measured trials using full visible-plane copies. A fourth adds 24 groups/72 measured trials comparing full copies with pointer-only output. Correctness runs are separate from throughput. The [combined summary](../bench-v8/results/av1-timing-with-copy-summary.json) binds all four raw cohorts and preserves the failure-history guard.

The table uses the first three cohorts. Each cell is the minimum–maximum of six per-fixture medians, each based on three measured trials: two source cadences × three bitrate targets. Units are **unpaced decoded pictures/s**, not displayed FPS or confidence intervals.

| Decoder configuration | 720p | 1080p | 1440p | 4K |
|---|---:|---:|---:|---:|
| libaom, 1 requested thread | 24.5–46.7 | 12.3–29.5 | 7.6–23.4 | 3.8–14.7 |
| libaom, 4 requested threads | 31.1–78.5 | 19.5–52.8 | 13.8–33.6 | 6.5–24.6 |
| dav1d atomic, 1 thread | 41.2–93.0 | 19.9–91.0 | 12.6–54.1 | 7.0–41.7 |
| dav1d atomic, 4 threads | 60.4–167.0 | 36.2–140.1 | 25.1–81.1 | 14.4–90.7 |
| dav1d SIMD, 1 thread | 47.8–135.5 | 22.9–99.6 | 16.0–49.5 | 8.6–46.0 |
| dav1d SIMD, 4 threads, delay 1 | 43.4–124.9 | 24.6–92.0 | 13.4–43.2 | 8.6–60.8 |
| dav1d SIMD, 8 threads, delay 1 | 43.2–124.7 | 24.9–80.5 | 14.7–45.0 | 8.7–60.3 |

“Delay 1” means the explicitly consumed `max_frame_delay=1` option. Four versus eight threads has no automatic benefit: eight is faster in nine fixture pairs and slower in fifteen; the median paired ratio is 0.987×. These are short measurements on this host, not universal scaling estimates. Full details and the separate blocked configuration are in the [AV1 results chapter](plan-parts/08-av1-performance.md); the [4K figure](figures/av1-4k-throughput.svg) intentionally depicts only the original full-copy cohorts.

### Correctness remains a separate gate

The original default SIMD/four-thread run passes 110/112 pixel cases, with two retained failures. A later held-frame diagnostic reproduces a stable incorrect picture. Independent localization finds 127 luma samples wrong by one code value at a block boundary; the root cause remains unresolved. That configuration stays **blocked**, despite faster diagnostic timing.

The distinct delay-one four/eight-thread candidate passes 96/96 bounded correctness trials and all 4,608 complete frame comparisons, including repeated previously failing inputs. This supports that exact candidate, not a repair claim for the default configuration or complete-player qualification. [Correctness evidence](plan-parts/06-executed-evidence.md)

### Bitrate and copy boundaries

The highest-target 4K files actually average approximately **175.875 and 177.451 Mbit/s** over their short source-clock intervals. All eight measured configurations, including the blocked default, fall below 60 pictures/s on those inputs. Encoder targets, achieved averages and peak/burst obligations are different fields.

The paired copy diagnostic finds a median pointer-only/full-copy throughput ratio of **1.069×**, ranging from 0.996× to 1.214×. Omitting the explicit local copy does not close the difficult 4K gap, and pointer-only output does not deliver picture planes to a renderer.

Timers include resident packet handling, decoding, flush and the selected local output-copy boundary. They exclude source fetch/demux, compilation, decoder opening/closing, correctness hashing, rendering and audio/subtitles. Cross-library results include different integration overhead. Packet latencies are retained, but hidden coded pictures and delayed output mean that a packet call exceeding 8.333 ms is not itself a measured display miss. These limits are recorded in the [four-cohort summary](../bench-v8/results/av1-timing-with-copy-summary.json).

## 3. TrueHD and FLAC: useful measured batching

Eight twelve-second inputs cover stereo at 48/192 kHz and 5.1(side) at 48/96 kHz, using tones, noise and 24-bit witnesses. All 24 browser decoded-PCM cases match exactly. Sixteen independently decoded FLAC outputs also match the admitted PCM byte-for-byte; 72 warm timings compare decode-only, immediate per-chunk FLAC input and 4,096-frame aggregation. [Audio evidence](plan-parts/06-executed-evidence.md)

Batching improves the bridge's warm median by approximately **1.9–2.9×**. For the 5.1/48 kHz tone source, the bridge falls from **824.04 to 323.13 ms** for twelve media seconds; decode alone takes 242.58 ms. No samples are removed or quantized. At 48 kHz, however, a 4,096-frame block represents **85.33 ms** of audio, so startup and seek latency constrain the production choice. A single-worker decode/aggregate/encode integration is proposed; its further gain is not measured.

A separate paced, muted AudioWorklet experiment passes 18 graph checks, consuming exactly 576,000 six-channel sample frames in twelve graph seconds with zero observed graph underruns and balanced buffer returns. It does not establish physical speaker routing or combined video synchronization. Conventional PCM equality also does not preserve Atmos objects or encoded TrueHD identity. [Audio graph and bridge contracts](plan-parts/02-audio-subtitles-resources.md)

## 4. Subtitles: API, threading and raster improvements

JASSUB 2.5.38 corrects the older 2.5.14 static-change behavior. Its packed eight-word descriptors need the corresponding adapter; the explicit pool option also removes seven idle initialization workers from the one-thread baseline. The updated one-thread case creates no children, while the four-thread case creates four. Observed heap high-water marks fall from approximately 508.4 to 229.4 MiB across these suites, without implying a mobile memory guarantee.

Selected 4K/120-source-time-grid results are:

| JASSUB configuration | Median raster calls/s | Median trial P95, ms | Calls above 8.333 ms / 720 |
|---|---:|---:|---:|
| 2.5.38, 4 threads, 24 events, full raster | 486.7 | 3.040 | 2 |
| Same, 1080p raster cap | 984.0 | 1.425 | 0 |
| 2.5.38, 4 threads, 200 events, full raster | 126.4 | 10.146 | 125 |
| Same, 1080p raster cap | 212.3 | 6.268 | 13 |

These are CPU raster calls, including API-return handling; no video, GPU upload or display participates. The stress median above 120 does not eliminate long calls. A capped raster explicitly loses subtitle spatial resolution. Arbitrary languages, fonts and effects remain separate coverage obligations. [Subtitle results](plan-parts/06-executed-evidence.md)

## 5. N2 native handoff: eight verified artifacts

The N2 prototype combines unchanged AV1 with TrueHD decoded to exact conventional PCM and re-encoded as 24-bit FLAC in fragmented MP4. All eight selected sources pass builder and independent verification: **384 unchanged video packets**, **384 matching decoded pictures**, matching HDR side data and **230,400 exact PCM sample frames**. Original timed ASS/font companions remain hash-bound external assets. [N2 evidence](plan-parts/07-n2-evidence.md)

The result does not prove native playback. `av1C` is normalized, source timing is rescaled within recorded bounds, and HDR metadata remains in unchanged AV1 OBUs; separate `mdcv`/`clli` boxes are absent. The actual browser must still interpret that representation, preserve speaker identity and carry required subtitles through fullscreen/PiP. The inspected Chromium path supports a narrow 5.1(side) candidate, not arbitrary-layout or every-browser assurance.

## 6. Reduced video: same-source output work versus an alternate input

The independent [reduced-video audit](../bench-v8/results/reduced-video-summary.json) joins **36 correctness trials and 1,728 exact frame/HDR/PTS comparisons**, then **144 timing trials: 36 excluded warmups and 108 measured trials in 36 groups**. All requested rows are retained; twelve focused negative checks reject incomplete, stale or forged joins. The original default-SIMD4 failure stays blocked.

For the same original 4K compressed input, `video-half` still reconstructs every full-resolution picture. It then selects every second sample in each 10-bit plane to produce 1920×1080, copying both storage bytes. This saves output bytes while introducing explicit spatial loss and aliasing; it is not a linear-light HDR resampler. The paired median total-throughput ratios span **0.872×–1.094×**, with median **1.029×**. Several SIMD cases become slower, and the measured JavaScript sampling stage itself takes longer than full row copies in all twelve pairs. Those short total-rate differences do not establish a cheaper handoff. The fastest reduced-output group reaches 96.77 pictures/s in its median and 99.14 in its fastest trial; no same-input reduced trial reaches 120.

The alternate experiment decodes **six different, precomputed lossy inputs**. Each preserves the original 120 Hz source-picture mapping and retained HDR descriptors. It requires an actually available alternate stream and does not measure real-time transcoding or faster original-4K reconstruction. These sources declare AV1 level6.2/Main tier; that is not full Annex E conformance or native-device admission.

| Alternate raster / parent encoder target | Actual alternate whole-file Mbit/s | Atomic4 median / minimum, pictures/s | SIMD4 delay1 median / minimum, pictures/s |
|---|---:|---:|---:|
| 720p / 4 Mbit/s | 0.176 | 265.63 / 246.03 | 306.07 / 285.90 |
| 1080p / 4 Mbit/s | 0.894 | 138.84 / 135.29 | 94.97 / 86.86 |
| 720p / 20 Mbit/s | 3.552 | 246.72 / 215.58 | 207.01 / 205.69 |
| 1080p / 20 Mbit/s | 11.747 | 108.42 / 99.21 | 71.86 / 67.48 |
| 720p / 80 Mbit/s | 26.246 | 134.01 / 129.52 | 102.62 / 95.45 |
| 1080p / 80 Mbit/s | 64.524 | 59.74 / 57.05 | 41.22 / 38.26 |

Each median/minimum uses three observations of all 48 source pictures. The atomic configuration exceeds 120 in every trial of the three 720p alternates and the easiest 1080p alternate. This identifies useful component headroom; audio, subtitles, rendering, delivery, pacing and endurance remain outside that result. The highest-rate 1080p alternate still misses even 60 in its median. The source-choice policy must therefore retain actual complexity, bitrate and configuration instead of treating every lower-resolution source as automatically fast.

The full source pixels were independently verified before the half-output reference transform. Reduced hashes cannot clear a defect at discarded pixels. Full/performance playback gates remain **NOT QUALIFIED** for both experiments.

## 7. Final difficult-format results

**All four final scopes completed and passed the independent protocol audit. The 60/120 fps playback gates remain NOT QUALIFIED.** The final evidence contains 70 instances across sources, routes and configurations, 1,476 runtime records, 292 profile groups and 876 warm calls. Every source video/PCM comparison, required count and same-renderer repetition/cache control passes. The final classifications are 70 source-video/PCM component passes, 70 packet-copy controls, 78 invalid NUT ASS exclusions and 74 rejected or unverified subtitle/scaled groups. These classifications are distinct; they are not 292 playback passes. [Final evidence join](../bench-v8/results/extreme-final-evidence-summary.json)

| Final scope | Completed instances | Runtime records | Groups / warm calls | Isolation policy |
|---|---:|---:|---:|---|
| Original ST | 32 | 720 | 144 / 432 | Fresh worker per fixture |
| Associated ST | 24 | 444 | 84 / 252 | Fresh worker per fixture |
| Original MT4, 4K | 8 | 192 | 40 / 120 | One fixture per fresh observed tab |
| Associated MT4, 4K | 6 | 120 | 24 / 72 | One fixture per fresh observed tab |

There are no aborted instances in these final scopes. All fourteen MT final receipts and all 28 independently retained zero-row checkpoints before runtime import and before the suite call are verified. Each actual tab close was awaited and its absence separately observed. This records tab lifecycle, not a new OS renderer process or confirmed memory reclamation. The two ST families and two MT document collections remain separate policies. [ST audit](../bench-v8/results/extreme-isolated-st-summary-attempt1.json), [MT audit](../bench-v8/results/extreme-document-mt-summary-attempt1.json), [operator ledger](../bench-v8/results/extreme-document-operator-ledger.json)

The original corpus is 32 **SDR** inputs: FFV1 v3 16-bit 4:4:4 or UtVideo 8-bit 4:4:4 with DTS, WavPack or TrueHD in the admitted NUT/Matroska combinations. It contains 12 unique pictures at 720p/1080p/1440p and 6 at 4K, all sourced at 60 fps. The smooth/textured inputs span 358.33–18,074.14 Mbit/s when whole-file bytes are divided by their actual source-frame clock. These very short synthetic inputs are not network-endurance measurements or substitutes for the primary AV1/HDR10 corpus. [Corpus and reference scope](plan-parts/09-extreme-evidence.md)

Each table range below spans the per-fixture median of exactly three complete-clip **CLI video/audio decode** calls across the eight original cases at that resolution. Source pixels and PCM are correct for this profile. Module initialization, caller transfer, separate probes, comparison, disposal and presentation are outside this CLI interval.

| Source resolution | ST median range, pictures/s | MT4 median range, pictures/s |
|---|---:|---:|
| 720p | 3.041–88.268 | Not measured |
| 1080p | 1.399–39.329 | Not measured |
| 1440p | 0.793–22.916 | Not measured |
| 4K | 0.345–9.787 | 0.735–27.366 |

The subtitle routes are slower and have a separate fidelity failure. At 4K, active FFV1/TrueHD/Matroska ASS medians are 0.294–0.915 pictures/s in ST and 0.569–1.668 in MT4. Valid associated ASS over the three NUT video/audio families spans 0.327–7.140 in ST and 0.669–18.241 in MT4. Its actual inclusive interval, including package validation, copies and probe, spans 0.255–5.374 and 0.443–10.032. No invalid embedded NUT no-op is included in these active-subtitle numbers. [ST statistics](../bench-v8/results/extreme-isolated-st-summary-attempt1.csv), [MT statistics](../bench-v8/results/extreme-document-mt-summary-attempt1.csv)

For one explicit three-observation example, the textured 4K FFV1/TrueHD/Matroska MT4 active-ASS profile has a CLI rate **minimum 0.566, median 0.569 and maximum 0.599 pictures/s**. Its median call processes six pictures in 10,541.365 ms. Caching the extracted ASS preserves the selected same-renderer result and raises its median to 0.779 pictures/s; the initial cache preparation cost is separate. Neither value qualifies the playback gate. Bilinear 1080p output still requires full input decode: the highest active scaled 4K MT4 median among these routes is 19.152 pictures/s, and scaled pixels lack an independent output reference. [Detailed measurements and limits](plan-parts/09-extreme-evidence.md)

All 24 original NUT/ASS tracks lose cue duration and are rejected as active workloads. The separate ZIP STORE input associates the unchanged NUT with the original timed ASS/font; it does not repair embedded NUT carriage. Automatic WavPack admission works; the earlier contrary source-table inference was corrected. None of the forty uncached active full-output subtitle groups equals the selected newer-native raster reference. Bounded image comparison localizes glyph/clip differences, while source backgrounds and the selected vector region agree. No tolerance was introduced to turn that difference into a pass. [Retained admission, source correction and renderer analysis](plan-parts/09-extreme-evidence.md)

Three earlier attempts remain outside the final timing statistics:

- The 48-frame repeated-source attempt was operator-stopped after 118 checkpoints. The final protocol instead makes three single-pass calls per profile and retains separate two-pass correctness controls. [Retained interruption](../bench-v8/results/browser-extreme-long-loop-interrupted-attempt1.json)
- The shared-owner ST attempt trapped at record 147 and retained 214 checkpoints. The reported allocator entry and preceding 69,730,304-byte heap observation do not identify the corrupting event or prove out-of-memory. Fresh owners contain reused state without establishing a root-cause repair. [Retained trap](../bench-v8/results/browser-extreme-complete-clips-interrupted-attempt1.json)
- The multi-instance MT browser document crashed after 120 durable checkpoints. The last saved state commits four outer completions and reports the fifth disposal event; the crash could have occurred after an unrecorded fifth completion or during later initialization. Its exact boundary and cause remain unknown. The fourteen later fresh-document completions are a separate candidate, not a repaired old cohort. [Retained renderer crash](../bench-v8/results/browser-extreme-isolated-mt-renderer-crash-attempt1.json), [boundary clarification](../bench-v8/results/interrupted-extreme-isolated-mt-renderer-crash-attempt1/boundary-clarification.md)

The measured published CLI path remains far below the required 4K gates, and the active/scaled output fidelity requirements remain unmet. These short calls include setup/finalization and cannot establish sustained limits of a future dedicated decoder build, genuine 120 fps input handling, paced presentation or endpoint fidelity. Native and GPU performance tests were waived and remain unexecuted. The final artifact therefore reports successful **protocol integrity** alongside **NOT QUALIFIED** playback gates.

## 8. Native roles and current-platform research

Prefer one admitted native media element for decoding, A/V synchronization and presentation. Packaging-only obstacles use bounded remux; unsupported TrueHD can use the separately admitted FLAC bridge. WebCodecs exposes browser decoders, whose actual hardware backend remains conditional. WebGPU supplies eligible scaling, color processing and composition; it has **no standardized hardware AV1 bitstream-decoder command**. AudioWorklet consumes bounded decoded PCM. Direct VideoToolbox, MediaCodec or Media Foundation calls are not website JavaScript APIs. [API/source register](plan-parts/11-appendices.md), [WebGPU specification](https://www.w3.org/TR/2026/CRD-webgpu-20261116/)

Without an admitted native bitstream route, the proposed managed route retains software decoding and needs separately qualified output primitives. If those are unavailable or miss the declared gate, that endpoint remains unsupported; only an actually available, independently admitted alternate rendition can change the outcome.

| OS research baseline | Dated release evidence |
|---|---|
| Windows 11 | 26H2: optional preview 26300.10075, 19 November; security baseline 26300.9974, 10 November |
| macOS / iOS / iPadOS | Each 27.2.1, 9 November |
| Android | Android 17, released 16 June |

Browser research records Safari 27.2, Chrome desktop 158.0.8127.88/.89, Chrome Android 158.0.8127.92 and Edge 158.0.4370.33. Firefox 161 is announced stable on 24 November while the inspected distribution feed still returns 160.0.1. These observations require an actual installation record. They are not performance tests or substitutes for the measured Chrome 156 host. Exact primary release links and hardware/output conditions are in the [platform chapter](plan-parts/04-platform-and-native.md).

## 9. Reproduction and artifact layout

Extract the independent archives into **one parent directory**, preserving `bench-v8/`, `research/`, `evidence-kit/` and `deliverables/`. The separate history archive preserves `previous/v7/` companion evidence referenced by the starter; it does not represent fresh v8 execution. Per-archive manifests identify members and hashes. Media parts are independently readable archives, not split ZIP volumes. The starter remains at `deliverables/implementation-starter-v8/`. Use the recorded Node 24.22.3/npm 11.19.1, Python 3.12 and exact package locks; native build-tool binaries in a retained runtime cache are host-specific.

From that parent directory:

```bash
npm ci --prefix bench-v8
npm ci --prefix bench-v8/libmedia
npm ci --prefix bench-v8/extreme
npm ci --prefix deliverables/implementation-starter-v8
python3 bench-v8/server.py
```

Open `http://127.0.0.1:8140/`, keep it visible/focused and run one suite at a time. The server supplies COOP/COEP. Check complete inner results, expected trial counts, exact references and HDR applicability; a completed wrapper or partial checkpoint is not a pass. Read the [experiment README](../bench-v8/README.md) before regenerating fixtures or rebuilding an adapter. A rebuild creates a new candidate identity.

To reproduce the four-cohort aggregation from retained raw evidence without overwriting its published summary:

```bash
python3 bench-v8/scripts/aggregate-av1-timings.py \
  bench-v8/results/browser-av1-hdr-timing-final.json \
  bench-v8/results/browser-dav1d-hdr-timing-final.json \
  bench-v8/results/browser-dav1d-low-delay-timing-final.json \
  bench-v8/results/browser-dav1d-4k-copy-thread-tuning.json \
  --libmedia-freeze bench-v8/results/harness-freeze-max-frame-delay.json \
  --out bench-v8/results/av1-four-cohort-reproduced.json
```

To reproduce the independent original-input/alternate-input audit:

```bash
python3 bench-v8/scripts/aggregate-reduced-paths.py \
  --half-correctness bench-v8/results/browser-dav1d-half-output-correctness.json \
  --half-timing bench-v8/results/browser-dav1d-half-output-timing.json \
  --alternate-correctness bench-v8/results/browser-dav1d-alternate-correctness.json \
  --alternate-timing bench-v8/results/browser-dav1d-alternate-timing.json \
  --out bench-v8/results/reduced-video-reproduced.json
```

These commands read retained evidence; they do not rerun playback. Their output
paths must be new, and the supplied identity records must belong to the actual
candidate being evaluated.

The difficult-format evidence has two distinct lifecycle policies. Audit the
two Worker-isolated ST cohorts and the fresh-document MT leaves separately:

```bash
python3 bench-v8/scripts/aggregate-extreme-isolated-clips.py \
  --cohort bench-v8/results/browser-extreme-isolated-complete-clips.json bench-v8/results/harness-freeze-extreme-isolated-clips.json 32 \
  --cohort bench-v8/results/browser-extreme-associated-isolated-complete-clips.json bench-v8/results/harness-freeze-extreme-isolated-clips.json 24 \
  --associated-references bench-v8/extreme-bundle/references/manifest.json \
  --out bench-v8/results/extreme-st-reproduced.json

python3 bench-v8/scripts/aggregate-extreme-documents.py \
  --operator-ledger bench-v8/results/extreme-document-operator-ledger.json \
  --freeze bench-v8/results/harness-freeze-extreme-document-leaves.json \
  --associated-references bench-v8/extreme-bundle/references/manifest.json \
  --scope all \
  --out bench-v8/results/extreme-document-mt-reproduced.json

python3 bench-v8/scripts/join-extreme-evidence.py \
  --st-summary bench-v8/results/extreme-st-reproduced.json \
  --document-summary bench-v8/results/extreme-document-mt-reproduced.json \
  --operator-ledger bench-v8/results/extreme-document-operator-ledger.json \
  --out bench-v8/results/extreme-final-reproduced.json
```

The first command intentionally reports two ST scopes as a subset of its
historical four-suite contract. The second binds each MT source to its own
document, exact final receipt, both durable pre-runtime checkpoints and the
external operator observations. The retained multi-source MT renderer crash
cannot be filled in with later document-leaf records. For new browser work,
follow [the document-leaf operator procedure](../bench-v8/extreme-document-leaves.md)
and use new ledger/output paths. Closing a tab is not a measured memory-reclamation barrier.

The final join uses the two newly reproduced summaries, rebinds their retained
receipts in the extracted workspace, and keeps the ST and MT lifecycle policies
and all three interruptions separate. It does not pool their measurements or
promote protocol integrity into a playback pass. Preserve the published summaries
with their original identities; do not rewrite recorded paths inside them.

N2 preparation and verification are separate untimed jobs:

```bash
node bench-v8/native-bridge/run.mjs --execute
python3 bench-v8/native-bridge/verify.py --execute
python3 evidence-kit/qualification/verdict.py evidence-kit/qualification/untested-record.json
```

The N2 commands overwrite their named output files: preserve the retained run first or use the documented alternate output directory. Never run preparation, codec references, builds or archive compression during a timing reservation. The verdict example evaluates a supplied record; it does not perform playback. [N2 command details](../bench-v8/native-bridge/README.md)

## 10. Production integration still required

The [I00–I12 taskbook](implementation-starter-v8/docs/START-HERE.md) retains 23 historical core tests and source contracts, not a finished SDK. I01 owns descriptor migrations; I02–I05 implement source, codec, output and Player/Session integration, including required I09 subtitle/font components. I08 develops native/remux/bridge routes in parallel. I07/I10 add claimed HTTP/index/disc behavior. I06 measures the simultaneous complete pipeline; I11 promotes demonstrated improvements; I12 releases only an exact admitted envelope.

The strict evaluator preserves zero eligible picture misses, complete audio/subtitle behavior and the declared full/performance transform. Its 7,560 primary proposals remain untested endpoint records. Short component medians, successful remuxes, capability queries and physical-output deferral cannot qualify them. Original failures remain evidence, including the blocked default SIMD configuration, lost NUT subtitle duration, renderer mismatch, shared-owner allocator trap and multi-source MT renderer crash. The complete playback verdict remains **NOT QUALIFIED**.
