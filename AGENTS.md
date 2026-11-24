# Agent instructions for the implementation starter

## Deliver the assigned slice

This workspace contains implemented core resource/math helpers, a deterministic test codec, and frozen interface candidates. It does not contain a playable SDK. Read `README.md`, `docs/START-HERE.md`, the assigned I00–I12 task card and referenced ADRs before editing. Discover and read each applicable nested `AGENTS.md` along the paths you will change. Use `rg` to locate contracts and tests. Inspect existing changes and preserve other agents' work.

One integrator owns public core contracts, workspace manifests, and `package-lock.json`. Assign files before parallel editing. Propose interface migrations to dependent owners before changing signatures. Independent coding may proceed during browser measurements; installs, builds, tests, codec workloads and benchmarks wait until the coordinator releases the measurement window.

## v8 priority and evidence boundary

Primary work is AV1 10-bit HDR10, conventional TrueHD channel PCM and required ASS/PGS semantics at full-60/performance-120. Preserve eligible native encoded HDR video and one media clock; WebGPU is composition/compute, not a hardware bitstream-decoder API. Native/GPU/physical-output execution is deferred by user request. Historical 23 core/boundary tests are retained, not newly run by documentation edits. The v8 executable evidence-kit verdict owns the strict zero-eligible-miss gate; archived 0.995 policies cannot qualify a release. Exact provider pins and pending production seams are in ADR002 and the proposed policy.

## Existing command contract

Use Node 24.22.3 and npm 11.19.1. TypeScript is pinned to 5.9.3. After bootstrap, use the committed lockfile with `npm ci --ignore-scripts`.

| Command | Actual scope |
| --- | --- |
| `npm run check:types` | Strict core compilation without DOM/Node globals, then workspace contract type checking |
| `npm run check:boundaries` | TypeScript-AST import boundary checks for the three existing packages |
| `npm run check` | Both checks above |
| `npm run build` | Emit JavaScript and declarations for core, testkit and browser contracts using TypeScript project references |
| `npm run test:unit` | Build, then run Node's real test runner against correctness/ownership/race fixtures |
| `npm test` | Check, build and unit tests |

No browser, fixture-hash, license, lint or performance script is advertised before it exists. Add the relevant real tool and a failing fixture when introducing such a lane. A successful testkit check is never browser or decoder qualification. Report the command actually executed and its outcome; pending, skipped and blocked checks are not successes.

## Architecture and invariants

- `@ubve/core` owns pure contracts and helpers. It has no DOM, Node, Vue, concrete parser, codec or renderer imports.
- `@ubve/browser` is the composition root. It owns browser-host integration, adapter registration/default selection and the future public player implementation. Vue will import that public SDK. A disposed Session is terminal; another Player.open creates a fresh Session.
- `@ubve/testkit` is development-only. Never put its marker codec or memory fixture source into the production registry.
- Keep exact checked byte offsets and half-open range semantics. Parse large integers as BigInt, reject values beyond an explicitly admitted Number boundary, and never use 32-bit offset arithmetic.
- Preserve signed rational timing, unknown DTS as null, configuration epochs, source-span availability and representation/timing provenance. Repacked bytes need not equal original span lengths. Floating API timestamps do not become exact container evidence through conversion to bigint.
- Reserve application-owned bytes and item count before allocation. Move one lease; do not clone release ownership. Moving/popping a queue does not release the global allocation budget. Destruction is idempotent and stale output is released.
- The ledger accounts for explicitly owned resources. It cannot impose a third-party WASM heap ceiling. Report adapter-enforced limits separately from opaque estimates; account retained worker/module pools at application lifetime.
- Every asynchronous operation has session/generation identity, operation identity, cancellation and a finite deadline. Input consumption, decoded output, output submission and physical presentation are distinct events.
- Decoder input completion must not wait for one output per packet. Delayed/B-frame/tail output uses the bounded output channel and explicit EOS flush. Await reset readiness and shutdown completion.
- Audio underrun events include the next expected media sample. Advancing graph time is not proof of advancing media. Rebuffering freezes logical media until a new epoch is primed and acknowledged.

## Development and verification

Retain strictness in `tsconfig.base.json`. Use discriminated unions, explicit type imports, runtime validation at admitted boundaries, and handled promises. The compiler does not prove that a media parser validated untrusted bytes. Do not loosen global settings to satisfy one adapter.

Add a scope-specific TypeScript project when worker or AudioWorklet source actually appears. Keep browser DOM, DedicatedWorker and AudioWorklet ambient declarations separate. Do not add placeholder implementations returning success for missing hardware or missing adapters.

A behavior change needs the smallest meaningful boundary or race test. An adapter integration needs the actual pinned dependency API plus real browser/worker tests; a fake-only test does not finish that task. Performance work requires a reserved machine, fixed sources, every attempt retained, declared timer boundaries, exact environment and raw evidence. Missing measurements are null.

Handoff: task ID from the canonical implementation backlog; behavior delivered; owned files; contract migration; actual verification; evidence class; remaining blocker; next dependent task. Do not introduce a second competing milestone namespace in this workspace.
