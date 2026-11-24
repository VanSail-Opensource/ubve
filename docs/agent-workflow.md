# Agent development standard and handoff

## Instructions and ownership

The root `AGENTS.md` is short repository policy. A scoped `AGENTS.md` is created **with a real package** and states its ownership, imports, actual commands, resource/clock invariants and failure expectations. Do not create uppercase/lowercase duplicates. On case-sensitive filesystems the conventional filename is exactly `AGENTS.md`.

The integrator owns `packages/core` public APIs, workspace manifests, `package-lock.json`, shared schema versions and command wiring. An implementation agent proposes a migration with every affected caller before those shared files change. Assign non-overlapping directories or use isolated worktrees; do not assume separate agents may safely patch the same manifest. Never revert another agent's work to make a local check pass.

Each task starts with a concise working note: task ID, current status, exact owned files, interfaces consumed, targeted fixtures, expected command, reservation state and failure exit. Each handoff records the same fields with actual outcomes. An agent does not need the entire research narrative to proceed; START-HERE, its card and the referenced ADRs are sufficient.

## Scoped AGENTS requirements

| Scope | Required local instructions |
| --- | --- |
| core | No browser/Node/concrete-codec imports; rational rounding; exact range rules; ownership and reset/dispose completion semantics |
| io-demux | One cache owner; half-open exact reads; metadata preflight before upstream expansion; preserved source/representation/timing provenance |
| wasm-adapters | Exact source/binary/ABI pins; all nested workers counted; heap-cap versus estimate; accepted-input/output/EOS separation; awaited shutdown |
| presentation | Shared source-sample clock; first picture primed before start; latch on underrun; timed PCM and direct feeder port; fresh canvas per attempt; no physical-output claims |
| browser | Per-player host-bound composition; user activation; terminal sessions; visible route/unsupported state; self-hosted assets |
| vue-player | SDK-only calls and immutable snapshots; no packet/frame/PCM reactive state; keyboard/accessibility; no per-frame Vue updates |
| qualification / bench | Exclusive execution; actual foreground verification; fixed hashes/denominators; every failed attempt retained; evidence-class boundaries |
| disc | Checked 2048-byte block arithmetic; local synchronous slices only in worker; no remote ISO/decryption/menu fallback |

Each scoped file links its task card and current actual command. Planned commands belong in the task card until implemented and run.

## Development rules

Keep TypeScript strictness and separate DOM, DedicatedWorker and AudioWorklet compilation contexts. Use discriminated unions and explicit type imports. Validate externally supplied bytes, metadata, messages and dimensions at runtime. A type assertion is not parser validation. Promise ownership is explicit: every accepted operation settles once, cancel/deadline/stale errors preserve their cause, and cleanup errors are observable without leaking leases.

Runtime errors use the current finite `EngineErrorCode` vocabulary. Provider-specific `E_*` strings go in `details.reason`. No adapter creates a parallel error enum. The integrator reviews a genuinely necessary new public code with callers and fixtures.

Native/browser objects and worker transport details stay in adapters. Do not let UI state become the engine scheduler. Never use `hardwareConcurrency` as permission to exceed a granted worker lease. A worker or pooled runtime remains charged until its owner actually closes/terminates it; reference counts alone are insufficient evidence.

No new hot-path allocation, copy, batching or optimization is accepted solely because a microbenchmark got faster. Preserve source layout/timing and compare the same declared output. Change one hypothesis at a time; document failures and boundary differences.

## Browser reservation and foreground preflight

Before a timed run, reserve the machine and freeze harness/source/assets/fixtures. Other agents may review or write code/docs, but must not install, compile, test, generate media, decode or benchmark. A source correction creates a new version/hash; old raw results stay associated with old sources.

Activate the **actual browser window and actual target tab**. The observed browser once reported `visibilityState === 'visible'` for an unselected tab while rAF was severely throttled; selecting a logical automation tab was insufficient. Record `document.hasFocus()`, visibility, the actual window/tab action, and a short declared rAF cadence control before measurement. If focus/cadence changes during the run, retain it as contaminated/failed rather than treating it as playback capacity. Do not keep repeating until a favorable run replaces the first failure.

## Definition of done

A task is complete only when its named behavior and failure exits work in its real applicable environment, current type/import checks pass, targeted meaningful tests pass, resource/ownership cleanup is demonstrated, and evidence/commands are retained. Mocked/marker data validates protocol logic, not codecs, rendering or device output. A source-selected provider and a successful WASM build remain unqualified until exact output/browser fixtures pass.

A task may finish its implemented subset while leaving explicitly separate platform/native/endurance qualifications pending. Report that status precisely; do not call the whole release complete. Production support is derived by I12 from exact matching evidence.

Handoff template:

```text
Task: Ixx; status: implemented / validated-subset / blocked
Owned paths:
Behavior delivered and explicit exclusions:
Public-contract migration (or none):
Commands actually run, exit status and logs:
Fixture/source/module hashes and evidence IDs:
Failure paths exercised; resource/worker cleanup:
Remaining qualification gate and next dependent task:
```
