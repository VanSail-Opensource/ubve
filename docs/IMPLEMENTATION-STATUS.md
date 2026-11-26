# UBVE phase and qualification status

The [v8 specification](specification/Universal-Browser-Video-Engine-v8.0.md) remains authoritative for playback qualification. The I00–I12 implementation PRs are separate from their production-evidence exits. **No exact playback configuration is qualified. Publishing the candidate to Cloudflare Pages does not change that status.**

| Phase | Verified implementation boundary | Still open |
| --- | --- | --- |
| I00 bootstrap | Reproducible pinned install, compiler wiring and CI | None for the bootstrap scope |
| I01 contracts | Strict core metadata, timing, memory and PCM tests | Provider-specific conformance remains downstream |
| I02 sources/demux | Bounded selected Matroska reads, exact payload/PTS and font reference | Generic container timing and complete large-file integration |
| I03 codecs | 1,104 AV1 pictures across 23 available sources and 211,200 selected TrueHD PCM frames matched independent references | Nine exact external source slots unavailable. This does not qualify playback |
| I04 presentation | Real AudioWorklet starts, cancellation, re-prime, seek and EOS. Actual WebGPU SDR/PQ pixel readback and a managed HDR candidate screen | Physical display output, HDR metadata transport and sustained timing |
| I05 SDK/UI | Native Vue open/play/pause/seek, compact viewport and language controls. Managed EOS/seek and explicit GPU route | No claim about native or GPU acceleration or device output |
| I06 evidence | 15 real short Chromium combined cases, 720p–4K at genuine 60/120 source cadence. All 720 decoded/submitted, 441,600 PCM frames, zero first-play underruns/recoveries | 645 Canvas submissions flagged late. One exact stress fixture missing. No sustained or physical-output pass |
| I07 HTTP | Actual Fetch loopback, pinned redirects/ETag and virtual ranges above 4 GiB | Cross-origin/device and bandwidth starvation profiles are not qualified |
| I08 native bridge | Seven exact AV1/TrueHD/ASS files preserve 336 video packets and 211,200 PCM frames across N2; real MSE opened, played and sought on all seven | Every short run dropped pictures. The 4K60/120 cases dropped 23/25 of 48. Rendered ASS and physical output not verified |
| I09 cinema | Real ASS raster/seek and IMSC timing, bounded PGS and font state, plus HDR10 base-layer decode in supported Dolby Vision MP4/MKV | Full Dolby Vision rendering, complete cinema semantics across modes and devices |
| I10 indexes/disc | Automatic paged classic MP4/MOV packets, bounded fragmented MP4, sparse high-offset PCM and clear two-clip BDMV/UDF reads | Further codec/edit combinations, sustained large-film evidence and complete selected-title playback |
| I11 optimization | Faster bounded CPU tone-map component. Smaller 360p raster rejected after paired short browser measurements | No promoted strict playback improvement |
| I12 release | Static build, standard/isolated document checks, asset hashes, staged notices, raw-receipt integrity and fail-closed support report | Exact sustained and physical-output records, complete corresponding-source inventory and remaining playback exits |

The short software screens use a declared SDR output transform, muted PCM graph and browser-observed counters. They do not establish physical cadence, full HDR fidelity or 60/120 fps. The native short screens establish actual MIME admission and media-element behavior, not acceleration. The strict evaluator and all originally retained failures remain unchanged. Unsupported, missing and deferred evidence is not a pass.

## Portable software and LAN follow-up

I02/I03 add pinned software video and audio coverage and exact audio-end handling. The locked authored matrix passed all 29 component and non-isolated Chromium screens. Two independently referenced Fraunhofer HE-AAC samples passed separately. The [codec notes](modern-software-codecs.md) distinguish the admitted format envelope from the exact tested tuples.

I04/I07 add an authenticated HTTPS runner and master-only orchestration. A real iPad Air M3 on iPadOS 27.0.1 and Edge 158 enrolled both 44,100 and 48,000 Hz graphs. On build `28870cf757eb`, six of seven jobs completed over LAN ranges without gestures after enrollment. Both primary lifecycle jobs decoded and submitted 48 pictures and consumed 38,400 PCM sample frames. The remaining Opus job produced 62,088 instead of 61,440 samples. Trusted Chromium reproduced the same failure on that build, then build `24a14f85217d` passed the exact Opus and MP3 end checks plus both primary lifecycle repetitions. The trim fix has not been rerun on iPad. The [lab runbook](device-lab.md) describes unattended playlists and the one-time browser setup.

I06/I11 retain bounded stage histograms and an opt-in worker conversion candidate. Three comparable short Windows browser pairs did not establish a playback timing improvement, so the default stays inline. See the [optimization assessment](I11-optimization-assessment.md). The next performance target remains the per-picture conversion cost, with sustained exact evidence still open.

## Packing-format follow-up

I02/I07 verify 21 locked container/profile fixtures through the isolated HTTPS lab in Chromium 151.0.7922.34. All 21 File jobs and all 20 applicable HTTPS range jobs passed. Refusal coverage includes corrupt/scrambled transport, truncated PCM chunks, and remote ISO. The [packing matrix](packing-formats.md) records the exact codecs and exclusions rather than assigning support by suffix alone.

I10 verifies the production Vue picker in Windows Chromium 158.0.8127.37. An explicitly selected clip played from both a clear Blu-ray UDF ISO and its authored BDMV folder. The real disc worker matched the ISO clip bytes to the separate folder reference. The playback checks observed 36 submitted pictures and 73,728 PCM sample frames. Whole-title transitions remain open.

The [large-file regression](packing-formats.md#large-files) verifies managed tail playback on an authored 96-minute AVC/AAC MP4 and a 96-minute fragmented AAC file, plus exact PCM indexing above 4 GiB in a sparse MOV. This is short seek-to-EOS and address-space evidence, not uninterrupted movie-length playback or a device-wide qualification.
