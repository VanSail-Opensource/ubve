# Proposed v8 policy data

These JSON files are proposed integration controls. They are **not loaded by the retained starter**, not measured universal limits and not production support. Every qualifiedProfiles list remains empty. Current TypeScript interfaces are narrower than the new proposed descriptors; I01 owns any real type migration.

| Policy | Owner and current interpretation |
|---|---|
| [providers.proposed.json](providers.proposed.json) | Exact primary and retained provider selections, npm versus generated ABI identity, known experimental binary pins, no production promotion. |
| [managed-profiles.proposed.json](managed-profiles.proposed.json) | AV1/HDR10/TrueHD/required-subtitle profile candidates, native priority, endpoint-specific resource admission and explicit reduced transforms. |
| [rendering.proposed.json](rendering.proposed.json) | Native HDR preservation, high-depth plane checks and qualified WebGPU/PCM output; native/GPU evidence remains deferred. |
| [qualification.proposed.json](qualification.proposed.json) | Projection of the authoritative v8 evidence-kit evaluator: full 60 fps/performance 120 fps at 1×, zero eligible misses, five sustained trials and separate physical output. |
| [operations.proposed.json](operations.proposed.json) | Retained finite operation/retry proposals; experiment watchdogs are not production latency promises. |
| [audio-recovery.proposed.json](audio-recovery.proposed.json) | Retained exact source-sample recovery protocol; graph progress is not media consumption. |

Original v7 policies are preserved in [archive/v7-policies](../archive/v7-policies/README.md). Their 0.995/three-by-300-second proposal and ProRes 30 fps SDR profile are historical only. They do not satisfy v8's 60/120 gate and are not fallback release authority.

## Admission and accounting

Validate the actual source tuple and its conformance first. Match the exact intended route, required metadata, output semantics, asset/ABI and endpoint profile. Reserve unique backing stores and all worker/runtime/reference/output resources before admission. A popped queue does not release a global allocation. A small view retains its full backing store. Browser/GPU/third-party heap estimates do not become hard limits through this ledger.

The primary policy requires an explicit per-endpoint envelope; a missing budget cannot enable production. Preserve bounded selected-track source queues and exceptional-packet admission. Dense lossless/extreme tuples may require a separate profile or a truthful rejection; do not silently enlarge ordinary limits. Record actual peak windows, largest packets and parser/index expansion separately from nominal bitrate.

The measured six-channel AudioWorklet transport example is12×960×6×4=276,480bytes. That bounds transport only, excluding codec heaps, producer/reference buffers and encoded input. The4,096-frame FLAC aggregation is a measured candidate with rate-dependent buffering latency, not a universal optimum. Correctness hashing temporarily adds a full-plane buffer and is excluded from video performance timing.

## Release authority and deferred evidence

The actual evaluator is `evidence-kit/qualification/verdict.py` in the accompanying v8 evidence bundle, with its record schema and tests. This policy records its hash so changes are explicit; do not maintain a second permissive verdict. PASS_PIPELINE_ONLY is not PASS_EXACT_CONFIGURATION. Required physical HDR/audio/subtitle output, actual refresh, A/V sync and the full mode fidelity checks remain separate.

Native/GPU work skipped at the user's request has status DEFERRED_NOT_QUALIFIED. A positive MIME/MediaCapabilities query, a decoded-frame hash or a component FPS number cannot make it pass. Optional Dolby Vision/Atmos behavior requires separate exact evidence and does not block the primary HDR10 work.
