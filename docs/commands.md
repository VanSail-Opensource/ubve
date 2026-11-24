# Command contract

Run workspace commands from `implementation-starter-v8/`. Use Node **24.22.3**, npm **11.19.1**, TypeScript **5.9.3** and the committed lockfile. Honor the browser reservation before any command that installs, compiles or runs tests. Commands in this first table exist now.

| Existing command | Actual behavior |
| --- | --- |
| `npm ci --ignore-scripts` | Reproduce the pinned workspace installation from package-lock |
| `npm run check:types` | Strict core project without DOM/Node ambient globals, then workspace type checking |
| `npm run check:boundaries` | TypeScript-AST import checks for the current package graph |
| `npm run check` | Both checks |
| `npm run build` | Emit core/testkit/browser JS and declarations through TS project references |
| `npm run test:unit` | Build and run `node --test test/*.test.mjs` |
| `npm test` | Check, build and current unit tests |

The preserved historical v7 clean `npm ci --ignore-scripts` and full `npm test` passed **23/23 tests**, with zero failures/skips/cancellations/TODOs. Evidence: `verification.json`, `validation-clean-install-v7.log` and `validation-final-v7.log`. The initial observed setup used `npm install --ignore-scripts --no-audit --no-fund`; its original 17-test run and earlier typed-array failure remain in their historical logs. The 23 tests comprise 17 helper/contract tests plus six AST-boundary regression tests. This source-only v8 documentation migration did not rerun them.

## Planned commands: TO CREATE

These names are implementation deliverables. They do not exist in package.json now and are not an instruction to run them before the owning task creates them. The integrator owns script/build wiring; the task owner supplies the implementation and a failing fixture. Add a script to AGENTS only after it executes successfully on the applicable checkout. All commands fail nonzero on failed, unexpectedly skipped, malformed or missing required evidence.

| Planned command | Owner | Required real implementation |
| --- | --- | --- |
| `npm run check:docs` | I00 integration follow-up | Verify local task/ADR links, existing-command paths and task-DAG references; do not require proposed package paths to exist |
| `npm run test:io` | I02 | Build actual I/O package and run exact-read, preflight and packet/provenance fixture tests |
| `npm run test:codecs` | I03 | Execute pinned real adapters in worker/browser lane plus asynchronous ownership/failure fixtures; report unavailable environments distinctly |
| `npm run test:presentation` | I04 | Actual browser renderer/worklet protocol tests, including starvation, epochs and first-frame-before-start order |
| `npm run check:vue` | I05 | `vue-tsc --noEmit` against real SFC project, separate from Vite transpilation |
| `npm run build:demo` | I05 | Vite static build with versioned same-origin assets and both deployment documents |
| `npm run test:browser` | I05 | Actual browser smoke/lifecycle/accessibility tests with saved browser identity and native codecs disabled for managed cases |
| `npm run bench:browser` | I06 | Exclusive serial foreground suite; immutable source/asset/fixture hashes, raw results and failure retention |
| `npm run test:http` | I07 | Local deterministic 206/200/416/identity/CORS/truncation/retry server and real Fetch source tests |
| `npm run test:native` | I08 | Separate native/MSE timing/output suite; do not execute in the present non-native experiment |
| `npm run test:cinema` | I09 | Real selected audio/subtitle/resampler fixtures; each absent provider fails or reports unqualified, never a pass |
| `npm run test:disc` | I10 | Built UDF/libbluray shim plus malformed, fragmented, title/clip/config and large-input fixtures |
| `npm run bench:paired` | I11 | Serial randomized/alternating baseline/candidate runner with matching correctness/output policy |
| `npm run check:assets` | I12 | ABI/module/worker/WASM/hash and forbidden-asset audit against release manifest |
| `npm run check:licenses` | I12 | Exact distributed dependency notices/source obligations report from locked artifacts |
| `npm run support:generate` | I12 | Schema-validate evidence and emit only matching qualified capability records |

Do not introduce a second test framework just to run deterministic core cases: keep Node's test runner. Browser execution uses the selected Playwright release when its environment is usable, or an explicitly documented supported real-browser control path. Playwright's WebKit is not branded physical Safari. Do not silently substitute a mocked browser or OfflineAudioContext for a missing real-time lane.

## Historical experiment commands outside the starter

These v7 commands belong to the retained previous bundle. Run from its root, not from this standalone starter:

```bash
node bench/browser-container/server.mjs
python bench/browser-container/validate-result.py path/to/browser-result.json
node bench/audio-recovery/server.mjs
```

Both standalone servers default to port 8765; run **one at a time** or deliberately configure distinct ports. The current supported browser server is a separate environment-specific route described in each experiment README. Server launch alone does not execute a browser test. The recovery page's Run button emits JSON and POSTs a result; the saved result assertions determine success.

Do not copy the old experiment's preload/main-thread feeder behavior into the production implementation. Reuse fixtures and protocol evidence, then test the actual package integration.

## Current v8 companion execution

The actual v8 media harness is in the companion `bench-v8/` tree. Its browser server is `bench-v8/server.py`; the run configuration and supported serving route are recorded by the enclosing evidence bundle. Do not copy the older server commands into a new qualification run without the matching source/hash manifest. Source-only documentation checks do not authorize a concurrent build or test during a reserved timing window.
