# I09 — Required subtitles, selected channel extensions and transforms

**Status:** components source-selected or experimentally exercised; production and complete-player qualification pending. **Dependencies:** parser/renderer components may start after I01; integrated completion depends on I05. **Owner:** provider agents under one integrator. **Owned paths:** provider-specific wasm-adapter/presentation directories and fixtures; shared contracts/manifests remain integrator-owned.

## Primary subtitle work

Pin **JASSUB 2.5.38**, exact package integrity, worker/WASM/fonts and its real raw descriptor ABI. rawRender accepts seconds plus repaint and returns packed Int32 bitmap descriptors with eight words per descriptor. Validate bounds/fields before upload. This version includes the unchanged-frame fix; baseline 2.5.14 returned nonempty lists for static images, so its changedFrames was an API-return count, not pixel mutation.

Own initialization, track/chunk state, fonts, seek reconstruction and shutdown. Control the current explicit pthread pool option: zero extra initialization children for one renderer thread; measure/count all children for larger grants. Preserve karaoke/motion/transforms/clips/vector/blur, ReadOrder/layers, shaping, forced cues and clear-on-disable. Do not freeze effects to obtain a higher number. Public wrapper chunk APIs and raw raster APIs can use different units; bind to the exact pinned interface, not a similarly named method.

Font policy remains explicit and bounded: no automatic remote search or local permission prompt. Retain attached bytes/provenance, supported font identities and visible fallback diagnostics. Latin fixtures do not qualify Arabic/Indic/CJK, variable fonts or malformed attachments. The proposed limits are 32 fonts, 4 MiB per font, 32 MiB total font data, 8 MiB script text and 50,000 events. They require actual preflight; a configured 32 MB cache and 10,000 glyphs are not a hard total heap cap.

PGS needs a versioned FFmpeg 9.0.2 subtitle C shim using avcodec_decode_subtitle2/avsubtitle_free. Emit owned timed state/rectangles/clear events with palette/alpha/forced flags; reconstruct object/palette acquisition state on seek. Missing end remains unknown until update/clear. Native WebVTT conversion is allowed only when exact selected semantics map; arbitrary ASS→plain text is not full quality. TTML/IMSC/legacy captions are exact-profile extensions, not a blanket feature list.

## Conventional audio and selected extensions

Primary TrueHD decoder/FLAC ownership is in I03; I09 completes additional exact channel/rate/output profiles and DTS 1.66.4. No silent DTS core extraction, downmix or object-rendering claim. Resampling uses the selected libsamplerate 0.2.2 stateful API with consumed/generated counts, retained unconsumed input, exact drain/reset and a declared delay/count policy. Mixing/resampling/output transforms have their own reference checks even after exact decoded PCM.

Custom legacy/PGS foundation is npm libav.js 6.11.9, generated ABI 6.11.9.0.2, FFmpeg 9.0.2. Build only required demux/decoder/shim fragments and record actual binaries/toolchain; do not invent a published NUT/FFV1/TrueHD variant. Official ffmpeg.wasm 0.12.10 is an explicitly whole-clip baseline, not a second hidden production media engine. Retain observed automatic NUT/WavPack admission and exact PCM in the published 0.12.10 baseline: FFmpeg 5.1.4 already has the `wvpk` entry in its extra audio table. Do not repeat the corrected mapping-absence inference or require a decoder override for that admitted fixture. Separately reject embedded ASS/NUT cases whose packet durations are lost; changing SSA/ASS codec tags does not repair cue timing.

HDR10 is the primary color requirement. Optional Dolby Vision, Atmos/JOC/TrueHD objects, DTS:X heights, IAMF/MPEG-H/AC4/VVC research remains disabled until exact separate decisions/builds/fixtures. Do not gate primary HDR10 on those optional features. A 16-bit FFV1 archival tuple is not automatically an HDR10 delivery profile.

The [HEVC base-layer fallback](../hdr-base-playback.md) does not implement Dolby Vision reconstruction. It extracts independently decodable HDR10-compatible data from admitted Profile 8.1 and Profile 7 mappings. Full Dolby Vision, object rendering and physical HDR qualification remain separate.

## Resource, fixture and output exits

Coordinate subtitle/video/audio thread grants across the complete player. Count all hosts/children and dispose before replacement. Required subtitle failure must pause/fail or expose an explicit continue-without-subtitles choice; it cannot count as a full gate pass. Optional malformed/oversized tracks can be disabled with a visible reason. Performance raster caps preserve text/timing/layout and are declared spatial reductions.

Fixtures cover multilingual shaping/fonts, animated effects, palette/RLE/clear/forced state, attachment reuse, seek, missing resources, full/capped raster, integer PCM/channel/rate/delay and malformed providers. Test all selected components concurrently in the integrated lane; raw raster timing excludes GPU upload/composition/presentation.

**Existing:** component experiments and unchanged starter checks after actual wiring. **TO CREATE:** test:cinema, exact C/worker build manifests and integrated fixture lanes. Missing providers fail or remain unqualified. I05 consumes the required subtitle subset before I06; I12 promotes only exact passing selected profiles.
