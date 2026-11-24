# Qualification matrix and verdict tooling

This directory contains a **proposed finite test catalog**, an executable matrix generator and a conservative exact-configuration verdict evaluator. It contains **no successful player qualification**. Synthetic unit-test values are strictly evaluator tests, never benchmark results.

## Run

From this directory, run:

```sh
python3 generate_matrix.py --out generated
python3 verdict.py untested-record.json
python3 -m unittest -v test_verdict.py
```

`generate_matrix.py` produces `catalog.json`, `priority-matrix.jsonl`, `optional-dv-matrix.jsonl` and `summary.json`. HDR10 is primary; Dolby Vision remains optional. All proposed rows begin `UNTESTED`; user-deferred native/GPU execution has its separate `DEFERRED_NOT_QUALIFIED` status. The catalog includes 4 standard resolution anchors and additional boundary/dimension cases. It does not claim that four anchors prove every integer dimension, profile or bitstream between 720p and 4K.

The initial primary expansion has 7,560 proposed rows: 5 OS families × 4 anchors × 2 modes × 7 target bitrates × 3 AV1 complexity classes × 3 ASS complexity classes × 3 conventional TrueHD configurations. OS family rows still require an actual browser engine/build, device, decoder route, display mode and audio route. They must be expanded, not treated as five representative devices that certify whole operating systems. A complete five-trial desktop/mobile schedule across that initial expansion alone has 30,240 serial measurement hours, calculated; setup, additional engines, exact profile validation and other format families are additional. Risk prioritization is necessary, but cannot turn unsampled combinations into verified results.

The TrueHD sweep deliberately distinguishes 8-channel 96 kHz from 6-channel 192 kHz; it does not invent an 8-channel 192 kHz TrueHD profile. The primary compound container is Matroska with valid HDR10 BT.2020/PQ 10-bit source samples, mastering display metadata and content-light metadata. The source must pass AV1 level/tier constraints. Dolby Vision is an optional 30-row matrix with separate profile/metadata/level requirements; it does not block the HDR10 primary claim. 240 Mbps is a target for valid admitted high-tier streams, not a promise that every low-resolution/profile stream at that rate is accepted. The encoded result's mean, p95, peak windows and total mux bitrate must be recorded. Merely setting an encoder bitrate flag is insufficient. AV1 in standards-compliant BDMV is not a valid primary test combination.

## Metric boundaries

`verdict.py` implements a **strict version of the user's literal minimum**: genuine 60fps and 120fps source cohorts at 1×, zero eligible pictures lost or late, zero steady-state audio underruns, five sustained trials and an exact complete-pipeline evidence record. Normal 23.976/24/25/29.97/30/50/59.94/119.88fps sources need separate cadence records; they cannot produce 60/120 unique source pictures per second without changing the source. The strict evaluator therefore refuses them rather than misleadingly counting repeated pictures.

The CFR evidence interval must be aligned to the source opportunity boundaries. Keep the source interval, actual observed wall interval and clock uncertainty in raw evidence; the aggregate denominator must not be rewritten to force a pass. The prototype evaluator rejects inconsistent denominators and does not implement a calibrated measurement-uncertainty model. Hardware laboratory admission must define that model before using it as an automated release authority. This evaluator is a guard against obvious false passes, not a replacement for metrology or physical reference review.

`PASS_PIPELINE_ONLY` is intentionally distinct from `PASS_EXACT_CONFIGURATION`. A browser full-pipeline measurement can prove application timing within its instrumented boundary; only a physically verified display/audio route with a sufficient active refresh rate can satisfy the final output claim. A table of capabilities or a user waiver of GPU testing does not produce a pass. Failing fidelity always blocks a full-quality result. Performance mode also requires an exact disclosed transform and correctness against that transform's reference.

The evaluator validates supplied fields and numerical consistency; it cannot authenticate their truth. SHA-256 syntax is not proof that the files exist. Review must validate raw evidence files, fixture hashes, instrumentation coverage, counters, independent decoder/color references and physical output measurements. Keep empty/unknown fields null or absent. Never convert unobserved events into measured zeroes.

Every measured trial needs its own `trial_id`; repeated IDs cannot satisfy the five-run requirement. Exact platform identity is required to select the correct endurance duration. The evaluator also rejects malformed records, nonnumeric playback rates, impossible unique-picture window rates, inconsistent A/V synchronization summaries, Boolean FPS components, missing case identity and unnamed performance transforms. These checks are covered by 22 small synthetic regression tests; they are evidence about the evaluator, never media performance evidence. The earlier 19-test run was extended after three additional shape risks were identified.

## Finite support catalog

`catalog.json` enumerates **candidate** video/audio/subtitle/container families. Every row still needs a specific provider build, actual fixture, valid container mapping, exact profile constraints and per-platform execution evidence. There is no automatic codec × container Cartesian product. Fixed-resolution/cadence codecs, interlaced fields, low-level profiles and unsupported proprietary extensions retain their own validity restrictions. Additional profiles can be added explicitly; the catalog is not an assertion that all possible historical or future formats are supported.

Use single-axis conformance suites for every declared profile; mandatory interaction suites for HDR10+AV1+TrueHD+ASS, HDR+bitmap subtitles, BDMV+HEVC+TrueHD+PGS, mixed edits/priming and fullscreen/PiP; then use constrained pairwise sampling only for lower-risk UI/settings combinations. Do not substitute pairwise testing for the mandatory compound workloads.

The source catalog additionally declares `zip-store-application-bundle-v1` as
a distinct 30th packaging/source family. Its bounded concrete profile is
`zip-store-nut-sidecar-ass-v1`: standard ZIP STORE containing unchanged NUT
video/audio, explicitly selected original timed ASS, a pinned font, and a
canonical association manifest. It is an application bundle, not a standard
native media container. The original NUT embedded-subtitle duration failure
remains a negative control. Its archive/member dataset admission ledger and
external-ASS render references are separate from this catalog: verified input
association does not change any endpoint row from `UNTESTED` or qualify
native/GPU playback. This addition does not expand or change the 7,560 primary
Matroska proposals. The generated JSON was refreshed in the authorized
preparation window. The primary matrix's before/after SHA-256 is identical:
`7b70654416118c7cd835a18ec1214067097aacd9b0c840c275c33709bf2a335d`.
`bench-v8/extreme-bundle/preparation/catalog-zip-family-regeneration.json`
retains that check and the prior 29-family catalog/summary snapshot. Actual
bundle construction and Node reader validation admitted all 24 inputs, but
the endpoint catalog remains proposed and untested.

## Persistent failure history

`failure-ledger/` freezes three actually observed default SIMD four-thread AV1
pixel failures with exact source/module/adapter identities and chained hashes.
`failure_guard.py` joins this history before qualification: unchanged-route
clean retries, different input fixtures and instrumentation-only adapter
changes cannot erase an unresolved fidelity defect. Meaningful changed
settings create a separately unqualified candidate. The helper never issues
a pass. Read `failure-ledger/README.md` for the immutable snapshot pin and
required admission contract.

The new helper and the separate 12 synthetic `test_failure_guard.py` cases were
source-only at introduction. After the parent released its preparation window,
**all 12 passed** and the default-route CLI retained all three blocking events.
`failure-ledger/validation-20261124.json` records the actual commands and source
hashes. These are separate from the retained 22 verdict tests, which were not
rerun, and are not media performance evidence. The original immutable ledger
continues to record the truthful untested status at its earlier creation time.
