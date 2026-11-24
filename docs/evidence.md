# Evidence index and permitted claims

This starter contains preserved TypeScript contracts/helpers and historical validation. The accompanying v8 evidence bundle contains media experiments, fixtures and raw results. Neither set establishes a production player or the complete 60/120 fps target. Native decode, GPU composition and physical HDR/audio/presentation evidence remain `DEFERRED_NOT_QUALIFIED` by the user's instruction.

## Preserved starter validation

[verification.json](../verification.json), [validation-clean-install-v7.log](../validation-clean-install-v7.log) and [validation-final-v7.log](../validation-final-v7.log) retain the historical clean installation, strict checks/build and **23/23 passing tests**: 17 helper/contract tests plus six AST-boundary regression tests. They have not been rerun or relabeled as v8 execution. The earlier typed-array error and 17-test run remain historical records.

[v8-source-migration.json](../v8-source-migration.json) lists the preserved source, tests, scripts, package manifests/lock and selected validation hashes. [The migration note](v8-migration.md) explains which v8 production interfaces remain pending. Documentation/link checks are separate from compiling, testing or running a player.

## v8 companion artifacts

Paths in this table refer to the enclosing v8 evidence bundle, outside this standalone starter. Use that bundle's final index and immutable manifests for the delivered run set; a filename alone is not proof of a successful run.

| Companion path | What it records | What it cannot establish |
| --- | --- | --- |
| `bench-v8/fixtures/hdr10/manifest.json` and its bitstream audit | Actual HDR10 fixtures, source hashes, dimensions/cadence, source metadata and declared codec level/tier/tiles | Encoder options alone do not prove conformance; source-level/bitrate eligibility is separate from native support |
| `bench-v8/results/hdr10-decoded-reference.json` | Independent visible-plane frame hashes and reference-decoder identity | Physical HDR appearance or complete AV1 Annex A/E conformance |
| `bench-v8/libmedia/` | Actual pinned dav1d WASM C-ABI experiment, plane copying, HDR metadata access, ownership cleanup and diagnostic source | Production adapter integration or qualification of every binary/thread configuration |
| `bench-v8/results/browser-dav1d-hdr-correctness-attempt2.json` | The retained 112-case sweep: all frame counts and HDR metadata passed; two SIMD/four-thread cases had pixel mismatches | SIMD/four-thread promotion; the failures remain blocking |
| `bench-v8/results/browser-dav1d-held-frame-diagnostic.json` | A reproduced SIMD/four-thread wrong picture remained byte-identical across two copies of the same held AVFrame, separated by a hash await and task yield | A unique upstream root cause, or proof that every possible lifetime/race explanation is excluded |
| `research/libmedia-hdr-access-review.md` and `research/libmedia-lifecycle-review.md` | Diagnosed adapter errors, exact fixes, retained old revisions and focused validation boundaries | Retroactive validity of failed or earlier-source results |
| `research/libmedia-simd4-pixel-mismatch-review.md` | Current decoder/thread investigation and exact source-provenance limits | A repaired or qualified SIMD/four-thread configuration without new explicit evidence |
| `bench-v8/fixtures/combined/manifest.json` and the final combined-run index | Genuine selected video/audio/subtitle/container tuples and their exact experiment inputs | Steady playback, physical output or arbitrary format coverage from a short component loop |
| `research/platform-native.md` | Dated primary-source ledger for platform versions, real browser APIs and conditional route limits | Executed native/GPU support on Windows, macOS, iOS, iPadOS or Android |
| `evidence-kit/qualification/verdict.py` and `record.schema.json` | Executable v8 release authority and required evidence fields | Passing records inferred from policy defaults or incomplete component metrics |

The initial all-case HDR-reader failure is retained under `bench-v8/results/browser-dav1d-hdr-first-failure.json`. Its corrected accessor uses the actual pinned cheap/libmedia struct API. Later success does not overwrite that failed attempt. Default SIMD multithreading remains blocked after the pixel failures and reproduction; atomic and single-thread configurations are separate candidates with their own records.

## Historical v7 browser experiments

The original record set is retained in the previous v7 bundle. Its evidence index is `previous/v7/implementation-starter/docs/evidence.md`; its browser measurements include Canvas/raw-VideoFrame SDR submission, a common-container prototype and a deterministic AudioWorklet recovery protocol. The observed silent audio graph was not audible-output evidence. A raw-frame constructor was not native bitstream decoding. Short SDR 30 fps experiments do not qualify HDR10 60/120 fps.

The archived 99.5% on-time policy is superseded. The v8 evaluator requires zero eligible misses at the required genuine source cadence, exact selected fidelity, sustained independent trials and separately required endpoint evidence. Component throughput, isolated protocol correctness, pixel equality, physical output and exact-configuration qualification remain distinct evidence classes.

## Task reporting

Report source selection, implemented behavior, correctness, timing and qualification separately. An absent environment is deferred or unavailable, never a pass. Preserve every failed attempt with its source/fixture/module hashes. Keep throughput denominators tied to all source pictures and exact consumed audio samples; do not hide drops, output precision changes, missing subtitle effects or altered clocks inside a faster result.
