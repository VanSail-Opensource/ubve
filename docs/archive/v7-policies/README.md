# Proposed policy data

These JSON files are exact proposed constants for implementation. They are **not loaded by the current starter**, not observed universal device limits, and not a support declaration. Every provider production qualification list is empty. I02–I06 implement and test their relevant enforcement; I12 supplies the schema/manifest loader and enables only exact qualified profiles.

| File | Implementation owner and interpretation |
| --- | --- |
| `managed-profiles.proposed.json` | I02/I03/I04/I05: named HD256/4K512 envelopes, explicit queue/worker/metadata bounds; 4K remains screening-only |
| `operations.proposed.json` | I02–I05/I07: finite operation watchdogs and bounded retries, separate from FPS/startup acceptance |
| `audio-recovery.proposed.json` | I04: source-sample protocol, 200 ms prime, 50 ms future anchor, two recoveries/30 s and six/open |
| `rendering.proposed.json` | I04: declared initial color/layout, raw-frame candidate, fresh canvas per attempt, disabled unqualified fallbacks |
| `qualification.proposed.json` | I06/I12: source-frame denominators, zero unintended underruns, actual foreground, explicit device/endurance gates |
| `providers.proposed.json` | I02/I03/I09/I10/I12: immutable source selections; production artifact hashes intentionally null until built/locked |

## Admission order

First validate source/track/format and required metadata. Then match an exact qualified input/output/environment profile (or explicitly experimental development profile), check assets/ABI and compute unique backing-store plus module/worker reservations. Reject before allocating if their total exceeds the selected envelope minus reserve. Category ceilings limit a category; they are not independent free allocations. Hold reservations through transfers and in-flight work. Reuse counts a shared allocation once, but a copy counts as a second allocation until released.

The HD profile allows 32 MiB raw video and the 4K screening profile 128 MiB, each with a maximum of three application frame slots including in-flight slots. Compute bytes from actual coded plane strides, not visible width×height. Reserve transient raw-VideoFrame/browser import copies conservatively in the modeled allowance and disclose that browser/GPU memory remains opaque. Do not describe the global application ledger as a hard process/GPU/WASM cap.

The aggregate raw-audio byte ceiling is 256 KiB for the initial stereo lane. Its transferable worklet pool is 16 × 960 stereo float32 frames = **122,880 bytes**; remaining aggregate space covers explicitly reserved producer fragments/decoded PCM. A full pool cannot be bypassed with an unbounded decoder-output queue. A future 1–8-channel profile must calculate and reserve its own larger PCM bytes.

The exceptional compressed access unit may be up to 32 MiB only after the ordinary compressed queue drains, with exclusive single-item and global byte admission. It does not enlarge all ordinary queue limits. It fails permanently when it cannot fit the selected profile rather than retrying forever as ordinary backpressure.

## Current TypeScript projection

`PlaybackPolicy` accepts native/remux flags, worker ceiling, compressed/raw-video/raw-audio queue bytes and `rebuffer`. Only the nested rebuffer fields `maximumRecoveries`, `windowMs`, `primeMs`, and `onExhaustion` exist in `RebufferPolicy`. The per-open six-recovery cap, operation deadlines, metadata limits, pool/renderer policy and detailed envelope stay in their owning supervisor/adapter configuration until the integrator introduces a reviewed shared type. Do not silently widen a union or use unchecked casts to hide an API mismatch.

Production native/remux, automatic quality-changing fallback, Q16 color conversion, WebGL rendering in this measured environment, resampling, spatial/object rendering and extra providers remain disabled until their specific gate passes. A user/caller can select a declared already-qualified lower spatial output resolution; source decode precision and audio channel semantics remain explicit and unchanged. The default exhaustion action is a structured render-budget error.

A missing source color field is not silently BT.709. The caller may deliberately declare a source-interpretation override with all four fields and an attached visible diagnostic; preserve original unknown values. A benchmark fixture override is evidence about that declared fixture only.
