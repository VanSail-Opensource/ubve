# I01 — Core contracts, ownership and deterministic helpers

**Status:** existing contracts/helpers historically validated; v8 descriptor migrations pending; final workspace 23 tests (17 helper/contract and 6 boundary). Production media/worker implementations pending downstream. **Dependency:** I00. **Owner:** core integrator. **Owned paths:** `packages/core/`, `packages/testkit/`, `test/contracts.test.mjs`; public signature migrations coordinated with every adapter owner.

## Fixed surface

Use [contracts.md](../contracts.md) and current source. Implemented helpers include checked ranges, signed rational timeline conversions, operation cancellation/deadline/epochs, resource ledger, movable leases, bounded queue and packet validation. Existing interface choices are settled: accepted `inputConsumed`, independent bounded `readOutput`, non-EOS `drain`, EOS flush, asynchronous readiness reset and terminal awaited disposal. Do not reopen the earlier output-per-input alternatives.

Packet provenance records exact/repacked/opaque representation, optional source spans and container-exact/reconstructed/API-seconds timing. DTS remains null when unavailable. Video output currently admits only I422P10, I420P8 and RGBA8; audio is float32 planar/interleaved. New formats or subtitle display sets need one centrally reviewed type extension, not an unsafe cast.

## Required v8 migrations, not already implemented

Add centrally reviewed I420P10 plane semantics, exact integer-capable24-bit PCM provenance, complete speaker identity, rational HDR mastering/CLL/FALL, subtitle packets/display state/fonts, selected output mode and metadata/configuration epochs. Preserve source unknown/conflicting values. Keep API admission, native implementation choice, decoded fidelity, physical output and qualification status separate. Do not attach fictional static-HDR fields to VideoFrame or cast new formats through the retained old unions.

Explicit EOS must remain distinguishable from no immediate output; production adapters cannot inherit the experiment wrapper's merged EAGAIN/EOF as the public terminal contract. Worker termination requests and physical exit evidence also remain distinct. The actual source is unchanged in this migration; production changes need targeted tests and accepted dependent-owner migrations.

## Implementation maintenance

1. Keep core pure; browser cancellation adapters translate AbortSignal into the existing Cancellation abstraction outside core.
2. Ensure input acceptance moves exactly once and rejected/backpressure paths retain caller ownership. Account unique underlying buffers; pop/transfer does not release the global charge.
3. Maintain one settlement for cancel/deadline/reset/dispose races and release stale undelivered output. Already delivered outputs belong to their recipient.
4. The fake codec remains explicitly marked marker output. Extend it only to express a real protocol edge, such as delayed/multiple/zero outputs or bounded flush; never register it in a product route.
5. Document any new fields with units/nullability/provenance. `PlaybackPolicy` is narrower than the proposed JSON. Per-open recovery count/deadline/profile metadata remain owned configuration until a reviewed migration adds them centrally.

## Fixture cases

Retain current high-offset/EOF, negative/fractional timeline, source-exact/repacked packet, move/release/destructor, queue-capacity, deadline/cancel/stale and reset/dispose tests. For future adapter-driven changes add only relevant missing invariants: flush while output full, delayed output requiring later input, canceled output read, delivered output outliving decoder, stale reply with reused request number, and synchronous admission during reset-readiness.

A virtual offset or marker test is mathematical/protocol evidence, not actual huge media, codec memory or browser performance. Tests should assert externally observable ownership/timeline outcomes, not mirror private implementation expressions.

## Verification and exits

**Existing:** `npm test`, with targeted emitted-module tests as needed after build; commands execute only outside reserved browser timing. Actual final 23-test record is in `verification.json`; the earlier 17-test run is historical evidence. No new task-specific runner is required for this task.

Success: public types remain strict, all relevant invariant tests pass, boundary rules remain true and dependent owners accept a necessary migration. Failure: arithmetic overflow, contradictory provenance, double ownership or unsettled operation rejects deterministically with current EngineError codes. Never loosen integer validation or ambient boundaries to make a provider fit.

I01 completion does **not** complete RandomAccessSource/File, a real Decoder, Worklet, Renderer, Session or Player. I02/I03/I04 consume these contracts and prove their actual implementations.
