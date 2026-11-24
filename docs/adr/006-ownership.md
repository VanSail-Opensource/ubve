# ADR 006 — One lease, bounded asynchronous codecs and honest resources

**Status:** core helper semantics validated; real adapter/worker/heap enforcement pending.

## Ownership rules

Reserve unique backing-store bytes and an item before allocation/admission. `OwnedLease.move()` invalidates the sender while keeping the global charge alive. Queue occupancy is a second bounded view, not a second owner or a reason to release an allocation when popped. Copying makes a second allocation charge; views of one owned backing store count once. Release is idempotent, and the core helper returns its reservation even if a destructor throws.

JavaScript cannot revoke a borrowed reference. Real adapters must stop using a view before transferring its backing buffer. Keep a transfer-ID table: each move is detached or documented as a shared reference, each return occurs once, stale returns are released and no old epoch can reclaim storage still owned by a new operation. SharedArrayBuffer lifetime requires an explicit shared lease and atomics protocol; it is not a transfer merely because a message carried the reference.

## Asynchronous codec completion

The synchronous `trySubmit` result is the ownership boundary. Only accepted moves packet bytes. `inputConsumed` settles once when the provider no longer needs those bytes, independently of delayed/reordered output. `readOutput` has one consumer and a byte-and-item bounded channel; include codec-delayed output in admission/accounting. No temporary-null convention, output-per-input assumption or `await decode()` shortcut.

Once inputConsumed settles, remove its operation deadline/cancel subscriptions; later expiry of that settled input must not retroactively discard valid queued output during pause. Session/epoch invalidation and active output-read operations still govern delivery.

`drain` captures prior accepted submissions and waits for their settle barrier without EOS or later admissions. `flushEndOfStream` seals new input and asks the codec to flush delayed/tail output while a concurrent reader drains capacity. A full output queue must backpressure without deadlocking the flush. Reset invalidates the old epoch synchronously and rejects old pending promises; the returned readiness promise includes decoder/batch/timestamp reconstruction. Disposal is terminal, synchronously invalidates admission, then awaits actual native/worker shutdown within finite deadlines.

Deliveries already owned by a caller remain its responsibility across decoder reset/dispose. Undelivered stale output is released by the decoder. A stale reply must never allocate an uncharged replacement or complete a new request merely because a numeric request counter was reused.

## Resource meanings

`DecoderResources` separates explicit input/output enforcement, internal heap `hard-cap`/`estimated`/`opaque`, configured maximum versus estimated allocation, session versus application-reusable lifetime and established shutdown. The core ledger cannot intercept a third-party allocator. Report measured `memory.buffer.byteLength`, configured maximum, input/output buffers, all host/child workers and opaque browser surfaces separately.

A reusable runtime remains charged at application lifetime while idle. In the first selected managed profile there are six Web Workers without custom subtitles, seven with one ASS/PGS host, plus a separately counted AudioWorklet. Source/disc uses the same I/O owner. Two TurboRes workers do not mean the whole pipeline has two workers. hardwareConcurrency is environment metadata, not permission to spawn.

The 256/512 MiB named envelopes reserve 32/64 MiB unallocated headroom. All known/estimated module, queue and transient allocations must fit before opening a route. If an opaque codec cannot meet a hard-cap claim, keep the claim estimated/unqualified or supply an actual build/allocator patch. The legacy 512 MiB heap needs the separate 1 GiB extension envelope; it cannot fit the ordinary 512 MiB profile after reserves and other state.

## Failure and shutdown

Use one-second graceful shutdown followed by owned-worker termination and one further second to establish completion. Return worker leases only after actual closure/termination. If shutdown is unestablished, reject with `E_SHUTDOWN`, retain appropriate resource charge and fail the new route rather than claiming a clean restart. Catch destructor/close failures without suppressing the original operation failure; record both through bounded diagnostics.

Unit tests must cover failed admission leaves ownership, accepted abort/reset/dispose, full output during flush, delayed/multiple/zero output, destructor exception, duplicate release/transfer, two epochs sharing numeric counters, and open/dispose races. Real provider tests add native command completion, worker lifecycle and heap telemetry. The existing marker fake proves core invariants but cannot qualify WASM lifetime or browser memory.
