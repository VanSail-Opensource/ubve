# UBVE phase and qualification status

The [v8 specification](specification/Universal-Browser-Video-Engine-v8.0.md) remains authoritative. The I00–I12 implementation PRs are separate from their production-evidence exits. **No exact production configuration is qualified. Cloudflare Pages deployment has not occurred.**

| Phase | Verified implementation boundary | Still open |
| --- | --- | --- |
| I00 bootstrap | Reproducible pinned install, compiler wiring and CI | None for the bootstrap scope |
| I01 contracts | Strict core metadata, timing, memory and PCM tests | Provider-specific conformance remains downstream |
| I02 sources/demux | Bounded selected Matroska reads, exact payload/PTS and font reference | Generic container timing and complete large-file integration |
| I03 codecs | 1,104 AV1 pictures across 23 available sources and 211,200 selected TrueHD PCM frames matched independent references | Nine exact external source slots unavailable. This does not qualify playback |
| I04 presentation | Real AudioWorklet starts, cancellation, re-prime, seek and EOS | GPU and physical output remain unverified |
| I05 SDK/UI | Native Vue open/play/pause/seek, compact viewport and language controls. Managed EOS/seek and explicit GPU route | No claim about native or GPU acceleration or device output |
| I06 evidence | 15 real short Chromium combined cases, 720p–4K at genuine 60/120 source cadence. All 720 decoded/submitted, 441,600 PCM frames, zero first-play underruns/recoveries | 645 Canvas submissions flagged late. One exact stress fixture missing. No sustained or physical-output pass |
| I07 HTTP | Actual Fetch loopback, pinned redirects/ETag and virtual ranges above 4 GiB | Cross-origin/device and bandwidth starvation profiles are not qualified |
| I08 native bridge | Seven exact AV1/TrueHD/ASS files preserve 336 video packets and 211,200 PCM frames across N2; real MSE opened, played and sought on all seven | Every short run dropped pictures. The 4K60/120 cases dropped 23/25 of 48. Rendered ASS and physical output not verified |
| I09 cinema | Real ASS raster/seek and IMSC timing, bounded PGS and font state, first-render font regression fixed | Complete cinema output semantics across modes/devices remain unqualified |
| I10 indexes/disc | Sparse five-million-entry classic index, exact edit mapping, actual clear two-clip BDMV and UDF ranges in a real browser worker | Generic large MP4 admission, fragmented tables and complete selected-title playback |
| I11 optimization | Faster bounded CPU tone-map component. Smaller 360p raster rejected after paired short browser measurements | No promoted strict playback improvement |
| I12 release | Static build, standard/isolated document checks, asset hashes, staged notices, raw-receipt integrity and fail-closed support report | Exact sustained and physical-output records, complete corresponding-source inventory and remaining playback exits |

The short software screens use a declared SDR output transform, muted PCM graph and browser-observed counters. They do not establish physical cadence, full HDR fidelity or 60/120 fps. The native short screens establish actual MIME admission and media-element behavior, not acceleration. The strict evaluator and all originally retained failures remain unchanged. Unsupported, missing and deferred evidence is not a pass.
