# Contract map for implementation agents

The source under `packages/core/src` and `packages/browser/src/index.ts` is the authority for existing TypeScript signatures. This page fixes interpretation and specifies proposed internal seams for the next packages. Those proposed seams are **not implemented exports**; adding them is owned by the cited task and reviewed by the integrator.

**v8 migration boundary:** the source and historical 23 tests are preserved. I420P10, exact integer-capable PCM, HDR10 static metadata, subtitle/font descriptors and native output-mode capabilities remain deliberate I01 migrations. The current output union and policy interface below are not silently extended by the proposed JSON policies. The primary AV1/HDR10/TrueHD/ASS tasks must add and validate those interfaces before production admission.

## Existing public contracts

| Surface | Exact names and completion semantics |
| --- | --- |
| `RandomAccessSource` | `identity`, `size`, `readExact(range, operation): Promise<SourceRead>`, `close(): Promise<void>`; immutable source identity/revision, exact bounded half-open bytes |
| `OperationContext` | `stamp`, `operationId`, `deadlineMs`, `cancellation`; core uses its own Cancellation and DeadlineScheduler, not DOM AbortSignal |
| `EncodedPacket` | Signed `ptsTicks`, nullable `dtsTicks`/duration, rational `timeBase`, `decodeSequence`, nullable presentation sequence, `codecConfigEpoch`, recovery state, timing and representation provenance, optional original spans, owned bytes |
| `DecoderConfiguration` | Required `media: DecoderMediaConfiguration`: audio kind/sampleRate/channelLabels, or video kind/codedWidth/codedHeight/visibleRect/color; nullable codec-private description is separate |
| `Decoder<Payload>` | `effective`; synchronous `trySubmit`; independent bounded `readOutput`; `drain`; `flushEndOfStream`; awaited `reset` and `dispose` |
| `OwnedOutput<Payload>` | Session stamp/operation/sourcePacketId, rational PTS/duration, codecConfigEpoch and one payload lease |
| `VideoPixels` | I422P10, I420P8 or RGBA8; coded dimensions, visibleRect, byte offsets/strides/rows, source color metadata and data |
| `AudioPCM` | Float32 planar/interleaved; sampleRate, frames, channelLabels, planes; timestamps come from the enclosing output |
| `AudioAnchor` | Epoch/stamp, graphStartFrame, mediaStartSample, sampleRate; graph and media are distinct integer sample positions |
| `Session` | `snapshot`, `play`, `pause`, `seek`, `dispose`; terminal disposed state; play/pause/seek acknowledgements describe actual engine state, not physical presentation |
| `BrowserPlayer` | `open`, `currentSession`, `dispose`; open replaces/disposes old Session and creates a fresh session ID; no implementation is currently exported |

Source cancellation/deadline/close stops delivery and rejects once as soon as observed; abort underlying work only where supported. Uninterruptible reads stay charged until completion or owned-worker termination, and their late bytes are discarded/released. A blocked event loop can delay deadline callbacks; checkOperation runs at admission and immediately before completion delivery.

Accepted decoder input moves ownership immediately. `accepted.inputConsumed` means the provider no longer needs encoded bytes; it may precede or follow any output and never implies one output per packet. A backpressure or rejected result leaves the caller's lease valid. Once inputConsumed settles, detach that input operation’s deadline/cancel handlers: an expired already-settled input deadline must not retroactively destroy valid queued output during pause. Session/epoch cancellation and each active output-read operation govern later delivery. Temporary output starvation waits; `readOutput` returns null only after explicit EOS flush and queued output delivery. `drain` snapshots prior accepted submissions without EOS. During `flushEndOfStream`, keep reading concurrently to avoid a full-output-queue deadlock. Reset invalidates synchronously, then its promise gates readiness. Disposal invalidates synchronously and awaits bounded actual shutdown. Recipient-owned delivered outputs remain the recipient's responsibility.

`PlaybackPolicy` currently has only `allowNative`, `allowUnqualifiedRemux:false`, worker ceiling, compressed/raw-video/raw-audio byte ceilings and `rebuffer`. Additional policy JSON fields are task-owned runtime configuration or explicit future type migrations; do not cast extra JSON into the current interface and pretend it is enforced. `PlayerOptions.adapters` is required until the integrator deliberately changes that API. Default and injected registries are per-player and bound to that same `host`.

## I02 proposed internal demux seam

Place implementation-specific types in `packages/io-demux`, not core unless two independent consumers require a reviewed shared type. Create `openDemux(source, operation, limits): Promise<DemuxSession>` with:

- `tracks`: immutable bounded descriptors with stable ID, kind, codecId, raw codec-private bytes, duration/time base availability, language/default/forced flags, dimensions/layout/color and timing-provenance diagnostics. Unknown remains null, not an inferred format default.
- `readPacket(trackId, operation): Promise<EncodedPacket | null>`: one serialized consumer per selected track; null is source EOS for that track, not temporary queue emptiness; all output is budgeted and stamped.
- `seekToRecoveryPoint(target, operation): Promise<DemuxSeekResult>`: result records requested rational target and actual per-track recovery points/preroll requirements. It does not claim those packets already present the target. Interframe decoding starts at a sufficient recovery point; presentation trims to the target.
- `close(): Promise<void>`: stop readers, release undelivered packets/cache ownership, detach callbacks and await worker closure under source-owner policy.

Mediabunny `Input` is one per source session; the coordinator selects both A/V tracks from it. Do not use a second whole-track `AudioSampleSink` inside a production packet-fed decoder. That sink remains useful in the comparison harness.

## I04 internal message protocol to implement

All control/data envelopes use the existing `WorkerEnvelope` version 1 identity/ownership fields. The audio feeder and worklet share a direct MessagePort. Every request has an operation ID; only its matching response settles it. Main-thread control does not carry routine PCM blocks.

| Body / event | Required fields and action |
| --- | --- |
| `configure` / `ready` | Exact sampleRate, channel labels, format, block/pool bounds, epoch and effective capabilities; no acceptance before ready |
| `pcm` | transferId, firstMediaSample bigint, frame count, sampleRate/layout, owned buffer; admit only contiguous expected-epoch blocks within granted capacity |
| `release` | transferId and returned backing store; producer validates one return per outstanding transfer |
| `schedule-start` / `schedule-ack` | Requested AudioAnchor and optional exact end sample; reject a past anchor; acknowledgement means scheduled, not yet consuming |
| `started` | Actual first source sample consumed under the accepted anchor; translate to core WorkletEvent.started; `Session.play` resolves here |
| `pause` / `stopped` | Stop at the next controllable sample boundary; return nextExpectedMediaSample plus lastConsumedMediaSample/null; resolve pause only after this acknowledgement |
| `underrun` | One latched event with exact missing-sample boundary; worklet stops itself before main thread responds |
| `reset` / `reset-ack` | New epoch and requested first media sample; return obsolete buffers, clear old state, then accept priming |
| `segment-complete` | Exact declared end sample consumed, no underflow for legitimate EOS; includes active/consumed counters |
| `dispose` / `disposed` | Terminal state, all owned queues returned, final counters, port/node closure acknowledgement; reject subsequent data |

Worklet validation rejects stale, overlapping, malformed, over-capacity and post-disposal blocks without advancing media. A discontinuity is a reset, not an accepted gap. Keep instrumentation bounded and off the per-sample path in production. Read actual render-quantum length; do not hardcode 128 even though that length was observed in the experiment. The test harness uses generated samples and additional assertions; port its protocol semantics, not its diagnostic workload into production.

## Error/recovery contract

Current codes are `INVALID_ARGUMENT`, `RANGE_OUTSIDE_SOURCE`, `SOURCE_CHANGED`, `CANCELLED`, `DEADLINE_EXCEEDED`, `STALE_EPOCH`, `DISPOSED`, `BACKPRESSURE`, `ITEM_TOO_LARGE`, `OWNERSHIP_VIOLATION`, `UNSUPPORTED_CODEC`, `INVALID_PACKET`, and `INTERNAL`. Recovery is `caller-fix`, `retry-when-capacity`, `new-session`, or `none`. Details are scalar values; never include source credentials or full private URLs.

| Failure | Existing code / reason | Default action |
| --- | --- | --- |
| Unsupported profile, unavailable required timing/color/rate, unqualified provider | `UNSUPPORTED_CODEC`, exact `E_*` reason | Refuse route; no quality-changing fallback |
| Permanently oversized packet/metadata/resource profile | `ITEM_TOO_LARGE`, `E_RESOURCE_LIMIT` or precise reason | Fail admission before allocation |
| Temporary queue/lease contention | `BACKPRESSURE` | Retry only after capacity signal within original deadline |
| Bad packet/metadata/segments | `INVALID_PACKET` | Stop affected route; required subtitle failure is visible |
| Module hash/ABI mismatch or provider/runtime shutdown failure | `INTERNAL`, `E_MODULE_INTEGRITY` / `E_MODULE_UNAVAILABLE` / `E_SHUTDOWN` | Fail route; release what is actually owned; do not call it fully disposed |
| Exhausted audio/render recovery | `INTERNAL`, `E_RENDER_BUDGET` | One already-declared qualified spatial-resolution fallback if allowed, otherwise fail; never silently alter audio/channel/source precision |
| Cancellation/deadline/stale/source mutation | Corresponding existing code | Settle once, stop future admission and release obsolete work; source mutation requires a new source session |

A route is configured once per open. One equivalent-state rebuild is permitted only by the operation policy and retains its first failure. User Retry creates a new operation; it does not erase history. No automatic codec-family migration, HDR reinterpretation or compressed-audio core extraction is implied by a generic retry.
