# Start here: implement the v8 browser player

**Taskbook revision:** 24 November 2026. **Product:** browser-only SDK and Vue reference player delivered as static assets. **Primary workload:** AV1 10-bit HDR10, conventional TrueHD channel audio and required complex subtitles, from 720p through 4K. The strict modes are **full-60** and **performance-120**, at 1× with no lost or late eligible source pictures. Dolby Vision is an optional independently qualified extension.

Native video and a browser-owned media clock have the highest architectural priority where the exact output semantics are admitted. WebGPU is used for eligible color/scaling/composition, not as a standardized fixed-function bitstream-decoder API. Native/GPU/physical-output measurements remain **DEFERRED_NOT_QUALIFIED by user request** in the current environment. Do not introduce an installed helper, server transcoder or implicit native bridge.

## What this checkout actually contains

The unchanged v7 core/testkit/browser-contract source, package lock and historical **23 passing unit/boundary tests** are retained. The validation logs are historical v7 evidence, not a new v8 execution. This migration edits documentation and proposed policies; there is still no production demuxer, codec worker, renderer, native route, AudioWorklet processor, Vue app or playable SDK here.

The separate v8 evidence bundle contains real AV1/dav1d, libaom, TrueHD/FLAC, AudioWorklet, ASS and extreme-format experiments. Those components do not complete production integration or qualify full playback. See [evidence boundary](evidence.md) and [migration details](v8-migration.md).

## Canonical task DAG and current state

| Task | Owned delivery | Status / dependencies |
|---|---|---|
| [I00](tasks/I00-bootstrap.md) | Existing toolchain; real command/asset wiring as packages appear | Historical bootstrap validated; no new execution in this documentation migration |
| [I01](tasks/I01-contracts.md) | Pure contracts, exact metadata, ownership and clock migration | Existing helpers historically validated; new HDR/subtitle/integer-PCM descriptor migrations pending; after I00 |
| [I02](tasks/I02-source-demux.md) | One bounded selected-track reader, complete metadata/ASS/attachment exposure | Pending; after I01 |
| [I03](tasks/I03-codecs.md) | Owned AV1 and conventional TrueHD/FLAC packet processing; retained historical codec profiles | Pending production; after I01, using actual I02 packets |
| [I04](tasks/I04-presentation.md) | Native/qualified HDR output and worker-fed PCM recovery | Pending production; after I01; hardware output deferred |
| [I05](tasks/I05-player-ui.md) | Actual Player/Session and accessible Vue UI | Pending; integrates I02/I03/I04 and required I09 subtitle components |
| [I06](tasks/I06-browser-evidence.md) | Complete selected-pipeline correctness, timing, lifecycle and sustained evidence | Pending; after I05 |
| [I07](tasks/I07-http.md) | Exact HTTP range source, identity and finite retry | Pending; after I02 |
| [I08](tasks/I08-native-remux.md) | Native direct/remux and lossless soundtrack bridge | Priority design/implementation alongside I02; exact hardware qualification deferred |
| [I09](tasks/I09-cinema.md) | Required ASS/PGS, fonts, conventional extensions and declared transforms | Components may start after I01; complete-player exit depends on I05 |
| [I10](tasks/I10-index-disc.md) | Paged indexes and restricted local UDF/BDMV | Pending; index subpart after I02, complete disc profile after selected I09 components |
| [I11](tasks/I11-optimization.md) | Paired optimization of demonstrated full-player bottleneck | Experiments are inputs; production promotion after I06 |
| [I12](tasks/I12-release.md) | Exact support records, assets/notices and strict release verdict | Pending; I06/I11 plus each claimed extension's exits |

Do not create a second competing task namespace. I08 implementation does not wait for managed benchmarks; I09 parser/renderer components do not wait for a finished I05. Their integrated qualification still occurs through the real player. HTTP/disc/spatial/native claims add exact conditional evidence rather than blocking unrelated component development.

## First implementation decisions

1. Preserve encoded native HDR video and one browser media clock when admitted. Advanced subtitles or TrueHD alone do not force video into WASM.
2. N1 is stream-copy remux. N2 explicitly converts conventional TrueHD PCM losslessly to FLAC, potentially in 4,096-sample batches, then muxes unchanged video into an accepted fMP4 destination. It has its own exact PCM/channel/timing/output gate.
3. For unsupported AV1 paths, integrate an exact passing dav1d SIMD/atomic configuration as a real bounded adapter; no 8-bit copy shortcut. Default SIMD/four-thread decoding is blocked. The distinct four/eight-thread `max_frame_delay=1` candidate has bounded component correctness evidence only. Treat libaom as a measured baseline.
4. Add the required I420P10, exact integer PCM, HDR static metadata and subtitle/font contracts centrally. The retained source does not already expose these new types.
5. Apply JASSUB 2.5.38's correct descriptor/change/pool handling. Keep full and reduced raster policies distinct and preserve required cue timing/content.
6. Use the executable v8 evaluator in `evidence-kit/qualification/verdict.py` as release authority. The old 99.5% proposal is archived and cannot qualify v8.

## Commands and ownership

The actual starter commands remain [documented here](commands.md). Production browser/codec/paired-performance commands are **TO CREATE** until their owner implements and runs them. No install, build, test runner or codec workload may overlap a reserved measurement window.

One integrator owns public contracts, workspace wiring and the root lockfile. Read root/scoped AGENTS.md, the assigned card and relevant ADRs. Create new production packages only when implementing them; do not add placeholder success adapters. Vue imports the public browser facade; core never imports DOM, a codec, a parser or Vue, and testkit never enters the production registry.

The [proposed policies](policies/README.md) are not runtime configuration or universal device limits. Every production qualification list is empty. Missing source validity, output fidelity, runtime budgets or device evidence must remain visible.
