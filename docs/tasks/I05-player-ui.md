# I05 — Actual browser facade and minimal Vue player

**Status:** pending; common-container experiments validate a subset, not the public player. **Dependencies:** I02/I03/I04 plus required I09 subtitle components; native routes use their I08 exit. **Owner:** composition/UI agent. **Owned paths:** `packages/browser/`, new `apps/vue-player/`, browser integration fixtures; integrator owns root workspace/scripts/lock migrations. Read ADR001 and exact current interfaces.

## Fixed stack and assembly

Source-select exact **Vue 3.5.46, @vitejs/plugin-vue 6.0.11, Vite 8.3.8, vue-tsc 3.3.14, @playwright/test 1.62.1**; the latter pins playwright/playwright-core 1.62.1. Official version metadata declares compatible Node 24.22.3/TS 5.9.3/peer ranges. This set was source-inspected, not installed or runtime-tested here; lock all transitive/platform artifacts during implementation and fail rather than silently float a version. [Source pins](../adr/002-stack.md#ui-and-browser-test-source-pins).

Implement actual `createPlayer` as the existing `CreatePlayer` contract. Construct the host-bound adapter registry and Session coordinator; injected registries remain required by the current API until a deliberate default-factory migration. No service backend/proxy or success stub. Use local static self-hosted versioned JS/worker/WASM assets.

`open` disposes the old Session, creates a new session ID, validates metadata/resources/route and resolves ready without autoplay. `play` handles activation, first-picture/audio priming and actual-start acknowledgement. `pause`, rational `seek`, supersession and `dispose` obey core barriers. One bounded provider supplies all selected video/audio/subtitle tracks, with packet-fed codecs and I04 direct feeder/recovery. No hidden AudioSampleSink whole-track reader competes with the coordinator.

## v8 route and primary integration

Prioritize eligible native HDR video and one media clock, including the separately admitted TrueHD→exact PCM→FLAC/fMP4 bridge. Managed dav1d and PCM/ASS fallbacks retain their exact output contract. Expose full 60 fps/performance 120 fps with the named output/subtitle transform, not a faster playback rate or hidden frame dropping. Native/GPU/physical tests remain deferred; no capability probe converts them to qualified.

Use the accompanying bench-v8/fixtures/combined/manifest.json as the current primary AV1/HDR10/TrueHD/ASS fixture index. Its actual frozen hashes and parsed codec metadata control identity. Integrate complete subtitle/font exposure from I02 instead of a separate whole-file scan. The historical ProRes fixture below remains useful lifecycle regression but cannot complete the primary v8 workload.

## UI contract

Vue Composition API with `<script setup lang="ts">`; shallow immutable SDK snapshots and explicit state/error events. Initial controls: local file, play/pause, seek, volume/mute, close, actual track/output-mode eligibility, full/performance selection and route/format/queue diagnostics. Display source versus output precision/color/layout, explicit override, experimental/unqualified status and unsupported reason. Do not expose unimplemented track/title/spatial options as working controls. Engine queues and audio timing remain outside reactivity.

Controls work by keyboard with labels/focus state and a non-color-only status. Drag seek is coalesced into explicit latest intent; obsolete requests reject cleanly. User pausing while seek/recovery primes stays paused. Do not reset volume or lose the first failure when retrying a route.

## Real fixture and scenarios

Use `bench/browser-container/fixtures/prores-ac3-1080p30-4s.mov`, SHA256 `26d427d20d181972daef7fd0b45ae83520813a60f4b262536275a6e485cb2808`, through incremental I02 input. Preserve actual source-derived PTS/duration, exact sample-grid mapping and api-seconds provenance where appropriate. Add independently understandable visual/audio timing markers for future physical-sync tests; the existing synthetic fixture does not supply physical evidence.

The prototype v1's12s/17-check result and v2's19-check fractional1.017s lifecycle result are reference behavior. Reproduce their logical/source/ownership checks through this actual SDK, then integrate deliberate starvation while codecs/video are active. Test two simultaneous hosts, open-over-open, rapid seeks, seek-to-end, play→pause during priming, close during worker/module startup, renderer error, source refusal, worklet crash, fallback exhaustion and fresh reopen.

## Verification and exits

**Existing:** npm check/build/test only after integrator adds all real project references. **TO CREATE:** `check:vue`, `build:demo`, `test:browser`. vue-tsc is separate from Vite transpilation. Browser tests use the actual selected browser/OS capabilities and native codec APIs disabled for managed cases; unavailable environment is not a pass.

Success: one real same-container source goes through production source/demux/owned codecs/renderer/worklet/session/UI with correct lifecycle/recovery and cleanup; static output starts from clean state; user-visible status matches runtime. Failure returns structured source/capability/resource/runtime reasons, never silently picks a lower-quality path or leaves old workers attached.

**Next:** I06 measures this exact integrated player. UI polish and component experiment throughput cannot substitute for that gate.
