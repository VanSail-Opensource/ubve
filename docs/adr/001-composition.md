# ADR 001 — One browser composition root and terminal sessions

**Status:** selected design; public interfaces implemented, production assembly pending I05.

## Decision

`@ubve/core` contains platform-independent contracts/math/resource helpers. `@ubve/browser` is the composition root and public SDK facade. Concrete packages depend on core, while browser assembles them. `apps/vue-player` imports the facade and immutable user-visible snapshots. `@ubve/testkit` is development-only. No codec, worker, renderer, Vue or browser ambient object enters core.

The concrete package sequence is `io-demux` (I02), `wasm-adapters` (I03), `presentation` (I04), then the actual browser player and Vue app (I05). Native, disc, qualification and implementation benchmark packages appear in their own tasks. One integrator owns workspace/build/import-boundary wiring; independent owners do not compete on lockfiles or core signatures.

`PlayerOptions.host` is the one presentation host. The default factory creates a **per-player** registry closing over that host before invoking `openSession`. An injected `BrowserAdapterRegistry` must already be bound to that same host and is never shared across hosts. The current required `adapters` property remains required until an explicit API migration implements defaults. Do not add a fake default registry returning ready sessions.

## Lifecycle and concurrency

`Player.open` cancels any superseded opening operation, awaits disposal of the previous Session, creates a new session ID and prepares the admitted source/route. It resolves at `ready`, not autoplay, audio consumption or physical video presentation. If teardown cannot be established, the new open fails with a structured shutdown error; do not stack another runtime on top of leaked resources.

`Session.play` requires user activation when the browser requires it, primes audio and the first selected video picture, schedules a future audio anchor, and resolves after actual worklet start. `pause` resolves after consumption stops at the acknowledged media boundary. `seek` changes epoch, cancels obsolete work, reconstructs/prerolls and primes the target interval, then preserves the prior playing/paused intent. The target is rational media time; the production coordinator chooses sample/frame intervals, never “nearest next PTS” by accident.

Disposal is terminal and idempotent. A new source needs a new Session. `BrowserPlayer.dispose` additionally closes application-owned reusable runtimes and is terminal for that player. A disposed session cannot be resurrected by a late promise or worker response.

Serialize mutually exclusive open/seek/dispose transitions. A newer seek supersedes the old seek immediately by generation and rejects its pending promises; its readiness cannot be completed by the older seek. Read/decode concurrency exists only inside the explicit queue/worker governor. Each operation is stamped, cancellable and deadline-bounded.

## UI boundary

Vue displays metadata, state, current route, explicit transformations, diagnostics and errors from SDK snapshots. It owns user intent and accessibility controls, not engine queues or graph timing. Use shallow immutable snapshots at the proposed 3 Hz diagnostic rate while visible; play/pause/seek/error events update promptly. Do not make per-frame reactive updates or put Uint8Array/PCM/VideoFrame objects in a reactive store.

Initial controls are local file open, play/pause, timeline seek, volume/mute, close and diagnostics. Add track/title/subtitle controls only when corresponding engine tasks exist. Unsupported options are visibly unavailable with a reason; no button reports success without an implemented operation.

## Validation

I01 establishes contract/math/ownership logic. I05 must run real same-source A/V, open-over-open, pause while priming, rapid seek, disposal during initialization, and reopen after failure. Keep a host-isolation fixture with two players to prove registries do not share canvases/audio state. The 12-second common-container experiment is useful input but does not finish this facade or lifecycle implementation.
