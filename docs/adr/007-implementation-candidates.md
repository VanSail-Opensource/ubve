# ADR 007 — Implementation candidates and explicit unclosed gates

**Status:** local implementation decision; no production admission.

The implementation keeps the canonical I00–I12 task identities. An implemented
adapter, a successful local build, a committed phase and an exact qualified
playback configuration are separate states. The v8 evaluator and failure ledger
are copied without modification into `qualification/`; the evaluator's SHA-256
continues to match `docs/policies/qualification.proposed.json`.

## Concrete source checking

Core retains the original strict ES2023-only project and no DOM/Node globals.
Browser adapters use separate DOM, worker and AudioWorklet projects. Concrete
DOM packages set `skipLibCheck:true` because pinned Mediabunny 1.66.4's
`@types/dom-webcodecs` declarations collide with TypeScript 5.9.3 DOM declarations.
This skips third-party declaration checking; it does not turn off strict source
checks, exact optional properties, checked indexing or import boundaries.
The Vue app additionally runs `vue-tsc` against source aliases.

## PGS candidate deviation

The selected FFmpeg 9.0.2 PGS C subtitle shim has not been built. I09 supplies a
bounded TypeScript PGS candidate with explicit palette conversion and object,
window, composition, crop, fragment and RLE checks. It is not represented as the
selected C shim or as reference-qualified PGS. Real reference-image and complete
player semantics remain required before admission.

## Browser and release boundary

Chromium failed before navigation in this workspace; the supported cloud browser
could not reach the local preview, and further error-page access was rejected.
No browser workaround was used. Executable harnesses are committed for an
authorized environment; their existence is not execution evidence. Node/WASM
reference hashes remain component correctness records.

The managed route uses a disclosed SDR Canvas transform and optional explicit
stereo channel-index fold-down. It refuses full HDR. N1/N2 preserve encoded
video while changing packaging or conventional audio coding, but their actual
native browser/output behavior is deferred. N3 is unavailable.

I10 now connects bounded classic MP4 tables to selected-track packet playback
for its explicit [candidate profile](../tasks/I10-index-disc.md). The disc package exposes the actual pinned
read-only WASM filesystem/title inventory; it does not yet provide whole-title
clip-transition playback. Neither candidate is promoted by a partial test.

Cloudflare Pages files can be prepared and built without deploying. The user's
condition requires all phases to be complete; unresolved I06/I10/I11/I12 gates
therefore keep deployment disabled.
