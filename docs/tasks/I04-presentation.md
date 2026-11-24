# I04 — Qualified HDR output, PCM transport and recovery

**Status:** production integration pending; prior protocol and v8 muted-graph experiments remain scoped evidence. **Dependency:** I01; actual codecs integrate through I03/I05. **Owner:** presentation agent. **Owned paths:** new `packages/presentation/`, distinct renderer/worker/AudioWorklet projects and fixtures. Read ADR004–006 and the v8 proposed rendering/audio policies.

## Output priority and exact color

Preserve native encoded HDR video and an eligible subtitle overlay when the selected route can retain required behavior. Custom composition uses an admitted WebCodecs/WebGPU or original WASM-plane path. WebGPU does not expose a fixed-function bitstream decoder. Native/GPU/physical-output tests are DEFERRED_NOT_QUALIFIED by user request in this environment; source/math/protocol work continues.

Primary raw video is I420P10:10-bit values in little-endian16-bit storage, actual plane offsets/strides and visible rectangle. It is not unchanged MSB-aligned P010. The declared dictionary is bt2020/pq/bt2020-ncl with actual source range. Keep mastering/CLL/FALL in an owned epoch descriptor; VideoColorSpace has no standardized static-HDR injection fields. Preserve16-bit archival planes separately or declare precision reduction.

A custom renderer validates chroma reconstruction, range, PQ-to-linear mapping, output gamut/display policy and subtitle reference white/alpha. Candidate HDR canvas settings include rgba16float, an accepted linear color space and extended tone mapping; configuration success does not prove the display. External textures are color-managed inputs, not untouched YUV storage. Source/reference patterns and a numerical implementation precede actual GPU/display admission.

The old I422P10→8-bit Canvas path remains an explicitly SDR historical profile. It is not full HDR10. Fresh canvases per context attempt, finite attempts, original/override metadata diagnostics, explicit frame closing and truthful opaque browser memory still apply. Do not silently fall back to SDR or omit required subtitles.

## Audio transport and state machine

For a qualified managed or N3 path, a dedicated producer feeds reusable PCM blocks directly to AudioWorklet via MessagePort. Every block carries epoch, exact first source sample, rate/layout/frame count and one ownership transfer. Choose a declared pool sized for the actual channel count. The measured six-channel example uses12×960×6×4=276,480transport bytes; it excludes producer buffers, codec heaps and references. The historical stereo16-block proposal does not bound six-channel playback.

Retain immediate missing-sample latch, controlled silence, frozen nextExpectedMediaSample, stale/late-block rejection and new-epoch reset/reprime/start. Use actual quantum length. Schedule-ack is not started; play resolves after actual source consumption. Pause/seek/dispose require matching barriers, explicit EOS does not create an artificial underrun, and every block returns to its owner.

The supervisor holds video, cancels obsolete work, trims exact source samples, primes the admitted target and prepares the resume picture before a future audio anchor. Retained proposals are200ms prime,50ms future anchor, two recoveries/30s and six/open, with finite retry/readiness limits; none is a newly achieved latency claim. Rebuffering is not uninterrupted playback.

N2 instead gives an accepted media element one A/V clock. N3 uses a measured mapping between native video and AudioContext clocks and separately qualifies drift, interruptions, seek/rate/device changes. PCM/graph success does not prove audible channels or physical synchronization.

## Required output modes and fixtures

Qualify inline, document fullscreen, platform video fullscreen, video PiP and Document PiP separately. A sibling ASS/PGS overlay may disappear in native video modes. A required cue failure cannot become success, and an8-bit captured substitute cannot be called unchanged HDR10. Performance mode may cap subtitle/output raster only with declared layout/timing/fidelity checks;120 unique source pictures remain required.

Fixtures include padded/cropped planes, PQ gray/chroma/low-bit witnesses, metadata/config changes, alpha/reference white, field/order errors, close-on-exception/context loss, all PCM channels, partial-quantum EOS, gaps/overlaps, active-codec starvation, pause/seek/reset races and exact first-picture/start order. Source bytes and API submission are not physical output references.

**Existing:** unchanged starter check/build/unit commands after wiring. **TO CREATE:** test:presentation with real graph/protocol fixtures; native/GPU lane stays deferred. Success is bounded production transport, exact source clock/recovery, declared output semantics and cleanup for the tested scope. I05 integration and I06 full-player evidence remain required.
