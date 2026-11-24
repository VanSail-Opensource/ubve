# I08 — Native HDR, remux and lossless audio bridge

**Status:** priority design/implementation; native/GPU/physical-output measurements remain DEFERRED_NOT_QUALIFIED by user request. **Dependencies:** I01/I02; N2 additionally uses I03's owned TrueHD/FLAC seam. **Owner:** native/timing agent. **Owned paths:** future `packages/native/`, exact timing/metadata accessors coordinated with I02 and native-specific fixture records. No installed helper or server transcoder is introduced.

## Concrete routes

N0 supplies an accepted original tuple to one media element. N1 demuxes and stream-copies admitted compressed tracks into compatible MSE/MMS segments. N2 explicitly decodes conventional TrueHD channel PCM, aggregates contiguous samples and losslessly encodes FLAC/fMP4 while keeping native video access units unchanged. N3 uses native video plus a separately clocked PCM graph only after its own synchronization/output qualification. Custom WebCodecs/WebGPU is selected when actual pixel composition requires it.

Keep N1's no-re-encoding claim separate from N2's intentional lossless audio re-encoding. FLAC exact PCM does not preserve TrueHD bitstream identity or Atmos objects. Source TrueHD/ASS rejection does not alone require managed video decode. A browser can own decode, media scheduling, accepted audio output and eligible compositor surfaces; website JS cannot directly invoke arbitrary VideoToolbox/MediaCodec/Media Foundation APIs.

Exact MIME/codec/profile/rate/layout/output queries are preliminary admission evidence. Probe the actual AV1/HDR10/FLAC destination, including applicable fLaC spelling, without assuming independently supported tracks compose. Hardware preference is a hint. Preserve API support, chosen implementation, actual output and performance as separate records. Native-only URLs remain opaque source descriptors.

## Timing and HDR gate

For every sample preserve PTS/DTS/duration, decode order, codec configuration, priming/padding, edits, source gaps, discontinuities and recovery/configuration epochs. Retain raw stored timing, edit-adjusted presentation and downstream observations separately. Do not replace unknown DTS with PTS or derive a contiguous audio clock over intentional gaps. Add exact-version source accessors or proven reconstruction where required; otherwise refuse the route with a precise missing-timing reason.

Preserve AV1 sequence color fields and metadata OBUs plus applicable container mastering/CLL/FALL records. Validate after every rewrap and seek epoch. Native encoded video can retain OS interpretation opportunities; basic raw VideoColorSpace cannot inject standardized mastering/CLL/FALL fields. Actual metadata preservation and actual display mapping are separate checks.

N2 requires complete integer PCM before/after round-trip equality, channel identity, rate/sample count and every-sample timeline. Batch latency is explicit: 4,096 samples are 85.33/42.67/21.33 ms at 48/96/192 kHz. The current two-package experiment does not prove a colocated single-worker production bridge or combined native output. Prefer the single media clock only when the exact complete route qualifies.

Speaker identity must survive the actual destination reader and decoder. At the reviewed [Chromium revision](https://chromium.googlesource.com/chromium/src/+/8aff45122317ba7b921cdc8fcb3c9af9773d54df/media/formats/mp4/mp4_stream_parser.cc), MSE FLAC forwards STREAMINFO and guesses layout from channel count; that path does not forward an arbitrary Vorbis-comment channel mask. The six-channel guess is explicitly FL/FR/FC/LFE/SL/SR, and the same revision's Symphonia wrapper retains a valid configured layout while the decoded channel count agrees. This is a narrow source-supported candidate for the selected 5.1(side) input, not arbitrary-mask or physical-output qualification. Record the actual shipped browser/backend and refuse mismatching layouts; leave unknown mappings unqualified. Do not equate side with back speakers or assume WebKit's closed AVFoundation reader follows Chromium.

## Output and failure fixtures

Required ASS/PGS must survive the selected inline/document-fullscreen/native-fullscreen/PiP mode. Native video PiP does not automatically carry sibling overlays. Verify subtitle reference white/alpha in HDR and refuse missing required cues. N3 separately covers pause/resume/seek/rate changes, interruptions, output-device changes and bounded drift correction; repeated currentTime seeking is not its synchronization algorithm.

Fixtures cover B-frames, signed composition offsets, priming/end padding, edits, multiple sample descriptions, fragmented defaults, VFR, rollover, deliberate gaps, seek recovery and metadata/config epochs. Actual future device work covers MSE append/remove/abort/error, eviction, native decoder reset/flush, audio channels, decoder reclamation and output mode changes. Current source/CPU checks do not impersonate those tests.

**Existing:** pure timeline/contract checks and named component experiments. **TO CREATE:** native/remux tests for the implemented routes, with hardware execution deferred here. Design completion supplies exact seams and refused defaults. Route qualification requires matching full timing/fidelity/device evidence. I12 adds a native claim only for an actually admitted endpoint; this work can proceed alongside the managed DAG.
