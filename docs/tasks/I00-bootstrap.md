# I00 — Bootstrap and agent command contract

**Status:** historical v7 bootstrap validated for the unchanged three packages; this v8 migration is documentation/policy only. **Dependencies:** none. **Owner:** integrator. **Owned paths:** root package/lock/toolchain/tsconfig files, `scripts/`, root `AGENTS.md`, verification records; package-specific owners supply their own scoped instructions. Native design is allowed; native/GPU execution remains deferred.

## v8 package and evidence identity

Resolve npm libav.js 6.11.9 separately from generated ABI 6.11.9.0.2. Pin libmedia 1.3.1/common 2.3.0, focused TrueHD/FLAC 1.66.4 and JASSUB 2.5.38 in each real integration lock; the current starter lock is unchanged. Retain previous bundle/fixture hashes and failed attempts. The evidence-kit verdict owns the zero-eligible-miss full 60 fps/performance 120 fps gate; proposed scripts are not advertised as executed.

## Delivered and retained

The workspace pins Node 24.22.3, npm 11.19.1 and TypeScript 5.9.3. Core, testkit and browser projects build; strict core checking excludes DOM/Node ambient globals; the AST import checker enforces the current graph. `verification.json` and logs record the final clean-install/check/build/23-test run, the earlier 17-test record and the earlier typed-array error. The marker codec is test-only; no fake player is exported.

Do not redo bootstrap or replace npm/Node's runner because another agent prefers a different stack. A new package requires the integrator to extend actual build/project-reference/import-boundary wiring, not silently add a package.json that no root command checks. `apps/vue-player` also requires an explicit workspace entry because the current workspace pattern is only `packages/*`.

## Follow-up method when packages appear

1. Obtain each owner’s package exports, target environment and exact dependency pins. Add the real package and appropriate core dependency; keep source-tree relative imports between packages forbidden.
2. Maintain separate DOM, DedicatedWorker and AudioWorklet TS projects. Root check/build commands must enumerate or reference the real new projects. Keep strict settings; local declarations cannot make unsupported APIs appear implemented.
3. Commit the lockfile produced by the actual pinned installation, including platform/transitive assets. Preserve the old successful record and produce a new validation record instead of editing its outcome.
4. Add scoped `AGENTS.md` when its package exists. Include only executable commands already added and run. Point every agent to this canonical I00–I12 taskbook.
5. Implement `check:docs` to validate existing-command references, local documentation links and DAG IDs. Proposed paths/commands carry an explicit planned status and are not falsely required to exist yet.

## Fixtures and verification

**Existing:** `npm ci --ignore-scripts`, `npm run check`, `npm run build`, `npm run test:unit`, `npm test`; see [command contract](../commands.md). The historical v7 clean npm ci and full npm test ran successfully; logs are validation-clean-install-v7.log and validation-final-v7.log. Initial installation and the earlier validation history remain retained. No builds/tests during a browser reservation.

**TO CREATE:** `npm run check:docs`, with a deliberate broken existing-command/path fixture and cycle/unknown-task fixture. Do not add aesthetic/word-count tests. Future root command wiring must fail when a new production package escapes type/boundary checks.

## Success and failure exits

Success: clean pinned installation/check/build/test on the relevant complete checkout; exact commands/logs/lock/source identity retained; every added package checked and scoped instructions truthful. An unavailable registry/browser/compiler is an explicit blocked environment, not a skipped success. Failed install/integrity/dependency resolution stops that integration; do not float versions or relax checks without a documented migration.

**Next:** I01 is already validated at contract/helper scope; I02/I03/I04 can implement independently under the integrator’s ownership map.
