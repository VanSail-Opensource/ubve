# Universal Browser Video Engine v8 — implementation starter

This is the source-only v8 revision of the existing implementation starter. Its primary workload is AV1 10-bit HDR10 + conventional TrueHD channel audio + required complex subtitles, with strict full-60 and declared performance-120 gates. Native encoded HDR video and one browser-owned media clock take architectural priority; native/GPU/physical-output measurements remain DEFERRED_NOT_QUALIFIED by user request. Dolby Vision is optional.

This is a concrete starting workspace for the implementation backlog. It contains real TypeScript helpers and deterministic correctness fixtures, plus explicit contracts for the next adapters. It does not claim to implement a player or a media decoder.

## What exists

| Package | Implemented now | Contract-only surface |
| --- | --- | --- |
| `@ubve/core` | Checked byte offsets/ranges; rational signed timeline math; session epochs; cancellation; application-owned byte/item reservations; move/release leases; bounded ownership queue; packet invariant validation | Exact source interface; codec configuration/resources and asynchronous decoder protocol; raw output metadata; audio anchors/rebuffer events; terminal Session lifecycle |
| `@ubve/testkit` | Small immutable memory fixture source, manual deadline scheduler, marker codec with input consumption/output-channel/EOS/reset/dispose semantics | No actual media format, browser worker, rendering or physical output |
| `@ubve/browser` | Buildable composition-root package and public interface candidates | Real adapter registry/defaults and `createPlayer` implementation are the next delivery slice; no success stub is exported |

The production dependency direction is UI → `@ubve/browser` → concrete adapters and `@ubve/core`. Core imports only its own modules. Testkit is development-only.

## Toolchain and commands

The observed local tools were Node **24.22.3** and npm **11.19.1**. The workspace pins npm in `packageManager` and Node in `.node-version`; TypeScript **5.9.3** is pinned as the only external development dependency. The TypeScript release was checked against its [upstream release](https://github.com/microsoft/TypeScript/releases/tag/v5.9.3). No production codec/parser dependency is added by this starter.

The generated `package-lock.json` is included. Reproduce with:

```bash
npm ci --ignore-scripts
npm test
```

`npm run check:types` performs real TypeScript checking. `npm run check:boundaries` parses imports using the installed compiler. `npm run build` emits package JavaScript/declarations through project references. `npm run test:unit` builds and runs Node's test runner on the actual emitted modules. The test runner is not substituted for type checking.

`verification.json` preserves the historical v7 validation of the unchanged source: strict type checks, import boundaries, package build and **23 passing correctness and import-boundary tests**, with zero failures/skips/TODOs in the final run. The initial typed-array generic error and its corrected run are both retained in logs. These are historical correctness checks, not performance measurements or a newly executed v8 test run. The source/test/lock preservation record is `v8-source-migration.json`; see [the migration note](docs/v8-migration.md). Future installations/builds/tests must wait while a browser benchmark window is reserved.

## Essential integration decisions

**Exact reads.** `RandomAccessSource.readExact([start,end), operation)` resolves with exactly that bounded half-open range or rejects. Zero length, including at EOF, is valid; out-of-range reads reject. Stable opaque source identity and revision are immutable. An opaque native URL is a separate descriptor and does not advertise byte access. A real adapter must cancel delivery on observation, abort underlying work where supported, retain accounting until an uninterruptible operation settles or its owned worker terminates, and detect identity changes; the in-memory test source does not qualify Fetch, Blob/File or remote identity behavior.

**Timing and payload provenance.** Store signed rational ticks and keep unknown DTS null. `EncodedPacket.timingProvenance` records container-exact, reconstructed or API-seconds origins. A float converted to an integer time base remains API-derived. Packet representation records source-exact, repacked or opaque adapter output. Original spans can be null when an API cannot expose them. Only source-exact packets require original span bytes to equal encoded payload bytes; header removal/repacking can change that relationship.

**Resource ownership.** Reserve known application bytes and an item before allocating. `OwnedLease.move()` invalidates the sender, while the ledger charge survives until the receiver releases. Queue occupancy is a separate bounded view; popping does not free the allocation. Release is idempotent, and cleanup returns the ledger even when a destructor throws. A borrowed JS reference cannot be revoked automatically, so real adapters must stop using it before transfer.

The ledger is not a WASM allocator interceptor. `DecoderResources` states which limits an adapter enforces, which internal memory is estimated/opaque, whether a runtime is session-owned or reusable at application lifetime, and whether complete shutdown is established. Actual third-party worker/heap lifetime must be measured and tested in each adapter. A configured upper limit is not current allocation.

**Asynchronous codec behavior.** `trySubmit` is synchronous admission. Accepted input moves ownership and supplies `inputConsumed`; backpressure/rejection leaves the input lease with its caller. Input consumption does not imply one output for that packet. The independent bounded `readOutput` channel supports delayed and reordered outputs; null means explicit EOS flush completed and the channel is empty. `flushEndOfStream` seals admission and must flush codec tail output. Keep consuming output concurrently if a real codec's flush needs capacity. Reset immediately invalidates the old epoch and returns a readiness promise; disposal is terminal and awaited.

The fake codec emits one four-byte marker per manually completed input, but the public protocol does not require one output per packet. Its tests exercise output order, lifetime and capacity, not compressed-media semantics.

**Audio recovery.** `AudioAnchor` maps graph frames to media samples for one epoch. Underrun events include the next expected media sample. A production worklet must stop consuming after a missing active sample and use controlled silence until rebuffering primes a new epoch. The supervisor holds video, freezes logical media, performs reset/preroll, and waits for a start acknowledgement. It must not continue claiming synchronization merely because the graph clock advances. `RebufferPolicy` carries the admitted retry window, priming target and explicit exhaustion action; the implementation backlog supplies and validates its values.

**Assembly and session lifetime.** `@ubve/browser` owns default adapter registration and the eventual `createPlayer` factory. The default factory constructs a per-player registry bound to `PlayerOptions.host` before calling `openSession`; that method closes over its presentation host. An explicitly injected registry must already be bound to the same host and must not be reused across different hosts. This is the host-binding contract until an explicit host parameter is deliberately introduced as an interface migration. A Player can open another source by disposing the previous Session and creating a new session ID. Session disposal is terminal. Open readiness, renderer submission and physical presentation are separate completions. Native/remux work remains independently gated.

## How an agent continues

Use the canonical task IDs and dependency graph in the revised implementation plan; do not create another competing milestone system. Each task identifies owned paths, exact interfaces, failure modes, fixtures, completion semantics and commands. The first adapter tasks consume these contracts and must report any required migration before changing them.

The next concrete integrations are a checked browser source and actual packet adapter; real codec adapters with resource/flush/reset semantics; the audio feeder worker/worklet; renderer/presentation supervisor; and the composition root/player. The native/remux/FLAC-bridge branch has architectural priority where it preserves fidelity and may be implemented alongside managed adapters; its actual native/GPU qualification remains deferred. I09 subtitle components start early so the primary I05 integration includes required subtitles.

Use the root and scoped `AGENTS.md` files as the repository instructions. Add scoped instructions only when their package exists. A source change needs its targeted correctness test; actual browser changes need browser execution; a performance claim needs retained raw evidence and the correct evidence class.

## Current limits

There is no actual media demuxer, renderer, AudioWorklet processor, worker transport, Vue app, native adapter, MSE remux path, or public player implementation in this workspace. Browser measurements live in the separate experiment bundle. Nothing in the marker codec or manual clock replaces those measurements or establishes codec/device support. The starter is intended to eliminate ambiguous contracts and missing bootstrap commands before those integrations begin.

## v8 provider and release decisions

Use [START-HERE](docs/START-HERE.md), the updated [ADR002](docs/adr/002-stack.md) and [provider policy](docs/policies/providers.proposed.json). The selected AV1 candidate is libmedia 1.3.1/dav1d with real atomic/SIMD binaries; npm libav.js 6.11.9 generates ABI 6.11.9.0.2 and remains a measured baseline/custom-extension foundation. TrueHD and lossless FLAC use focused 1.66.4 packages; ASS uses JASSUB 2.5.38. These are source/experiment selections, not new dependencies installed into this retained contract-only starter.

Configuration identity is part of admission. The default four-thread SIMD AV1 configuration has retained pixel mismatches and is blocked. The separately recorded `max_frame_delay=1` four/eight-thread configuration passed its bounded component correctness sweep; that does not qualify complete playback or erase the default failures. I03 and the provider policy retain this distinction.

The accompanying v8 evidence-kit evaluator is the release authority. Full 60 fps/performance 120 fps use genuine source cadence at 1×, zero eligible missed/late pictures, exact selected fidelity, five sustained trials and separate physical-output evidence. The old 99.5% gate and ProRes-first SDR policies are archived and superseded. No current component result qualifies production playback.
