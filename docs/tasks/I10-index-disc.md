# I10 — Complete paged indexes and local UDF/BDMV

**Status:** pending. **Dependencies:** I02 and I09 for the complete cinema/disc profile; the paged-index subpart may begin after I02. **Owner:** index/disc agents with separate owned directories. **Owned paths:** `packages/io-demux` paged indexes, new `packages/disc`, exact C build/ABI manifests and fixtures. HTTP is an additional dependency only for a separately claimed HTTP index lane; remote ISO stays unsupported.

## v8 scope

Primary AV1/HDR10 file playback does not imply a valid AV1-in-BDMV disc. Retain the restricted real disc essence/title contract and exact selected-track metadata. NUT/Matroska extreme tuples belong to explicit source/mapping profiles, not invented disc formats. Native MKV support with other tracks does not prove the selected compound plays; stock AVI/ASS and examined NUT/TrueHD mappings remain invalid. Optional disc completion does not block unrelated primary file work.

## Paged index delivery

Replace the initial rejected-large-metadata policy with bounded on-demand semantics for all needed MP4 tables, not only stsz: stsz/stz2, stts, signed/unsigned ctts, stsc, stco/co64, stsd/config changes, stss/recovery/sample groups, edit lists, fragment tfhd/tfdt/trun defaults/offsets and encryption rejection. Pin exact source/parser patch and make page/cache ownership explicit. Validate every count×stride/offset and table relationship before reading; retain checked rational timing and source spans.

Seek composes page-level prefix sums/checkpoints without expanding all samples. Preserve signed PTS/DTS/durations and recovery preroll. A canceled page read never enters the new generation cache as live output. Bound page bytes, pending reads and indexes against the same global source budget. Record exact additional policy constants in a reviewed profile before enabling large metadata.

## Local disc implementation

Pin libudfread 1.2.0 and libbluray 1.5.0 with archive hashes from provider policy. Build exact Emscripten 6.0.0 static libraries using checked-in Meson cross file and external staged libudfread, no fallback source resolution. Use the provider record's verified options; bdj_jar=disabled does not remove native BD-J/menu C/JVM source. Patch away dynamic library loading and expose only read-only shims; audit final imports/exports/assets. No decryption/key lookup/menu runtime.

Reuse the dedicated I/O owner worker. FileReaderSync reads local File/Blob slices ≤ 1 MiB for synchronous C callbacks. UDF 2,048-byte block arithmetic uses checked BigInt at the boundary; the provider's 32-bit logical-block callback caps image size at `(2^32−1)×2048` bytes. Implement open_input, directory iteration and file open/size/seek/read/close over bounded extents. Folder mode uses normalized relative-path File map, rejects ambiguous duplicates and never copies all clips into a virtual filesystem.

Use bd_init/bd_open_files/bd_get_titles/bd_get_title_info/bd_free_title_info/bd_close. Output title/clip/chapter spans and stable track/PID/config mapping with exact documented clocks. First admitted titles are linear, angle0; ambiguity requires explicit user title selection. Unsupported angles/branches or encrypted source fail visibly. Don't multiply public converted times as if they were raw MPLS fields.

Synchronous reads cannot process cancellation during an active C call. Cancel delivery as soon as observed, bound work/chunks, retain ownership until it settles or owner worker terminates, and use hard shutdown deadline for unresponsive work. Do not advertise immediate physical abort of FileReaderSync.

## Fixtures and verification

Index fixtures include fixed/variable samples, large co64 offsets, fragmented defaults, edit/config changes, sparse and five-million-entry metadata, malformed count/parent extents and exact fractional seeks. Separate virtual/sparse arithmetic from actual large-media throughput and memory.

Disc fixtures include fragmented UDF extents, short reads, directory/path limits, malformed lengths, chapters/clip cuts, PID/config/audio layout changes, unsupported angle/branch, encrypted refusal and real large local files. Compare title spans and seek outputs to independent reference metadata. A virtual1TiB source or MP4co64 pass does not qualify UDF/libbluray.

**Existing:** check/build/unit after package wiring. **TO CREATE:** `npm run test:disc`, actual C build/ABI audits and paged-index fixture lane within `test:io`. Expensive media/build/endurance work waits for its reservation.

Success: complete bounded index semantics and exact admitted local-title playback/seek with resource cleanup, separate real-large-input evidence. Failure: reject unsupported/malformed/oversized structures before expansion; keep remote/encrypted/menu/unsupported titles unavailable. No full-ISO extraction or unlimited memory fallback.

**Next:** I12 disc/large-media claim only after the exact corresponding evidence passes.
