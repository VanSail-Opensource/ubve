# I10 — Complete paged indexes and local UDF/BDMV

**Status:** paged classic MP4 packet playback, bounded fragment scanning and clear BDMV navigation candidates implemented. Playback qualification remains open. **Dependencies:** I02 and I09 for the complete cinema/disc profile; the paged-index subpart may begin after I02. **Owner:** index/disc agents with separate owned directories. **Owned paths:** `packages/io-demux` paged indexes, new `packages/disc`, exact C build/ABI manifests and fixtures. HTTP is an additional dependency only for a separately claimed HTTP index lane; remote ISO stays unsupported.

## v8 scope

Primary AV1/HDR10 file playback does not imply a valid AV1-in-BDMV disc. Retain the restricted real disc essence/title contract and exact selected-track metadata. NUT/Matroska extreme tuples belong to explicit source/mapping profiles, not invented disc formats. Native MKV support with other tracks does not prove the selected compound plays; stock AVI/ASS and examined NUT/TrueHD mappings remain invalid. Optional disc completion does not block unrelated primary file work.

## Paged index delivery

Replace the initial rejected-large-metadata policy with bounded on-demand semantics for all needed MP4 tables, not only stsz: stsz/stz2, stts, signed/unsigned ctts, stsc, stco/co64, stsd/config changes, stss/recovery/sample groups, edit lists, fragment tfhd/tfdt/trun defaults/offsets and encryption rejection. Pin exact source/parser patch and make page/cache ownership explicit. Validate every count×stride/offset and table relationship before reading; retain checked rational timing and source spans.

Seek composes page-level prefix sums/checkpoints without expanding all samples. Preserve signed PTS/DTS/durations and recovery preroll. A canceled page read never enters the new generation cache as live output. Bound page bytes, pending reads and indexes against the same global source budget. Record exact additional policy constants in a reviewed profile before enabling large metadata.

The classic candidate in `openMp4PagedIndex` supports size/offset/time/run/sync
tables with exact decode ticks, signed or unsigned composition offsets, source
spans and sample-description indices. It does not turn a decode-order search
into a PTS seek. It retains only a checkpoint per 4096 time/chunk rows, uses the
shared source-byte LRU and reads sample size data on demand. Unit-rate v0/v1
edit lists preserve explicit gaps and exact fractional movie-to-media mapping.
There is an aggregate bound of 24,576 index checkpoints and edit segments.
`openMedia` automatically uses the paged packet adapter when classic tables
cross the initial preflight cutoff. It preserves the original byte ranges and
normalized signed PTS/DTS. The pinned provider sees a bounded decoder-config
probe, not the original tables. The baseline playback profile admits a single
static description and a contiguous unit-rate edit. The common fixed-width
audio roll group supplies conservative seek preroll. Other group schemas,
configuration switches, non-unit-rate/dwell edits and protection remain
outside this playback path. [FFmpeg's audio roll writer](https://ffmpeg.org/doxygen/9.0/movenc_8c_source.html)

Fragmented MP4 stays on the pinned fragment reader. Preflight applies
262,144 samples and 16 MiB of metadata to each fragment, plus its independent
initialization and lookup bounds. A large aggregate count across small
fragments does not force the classic tables route.

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

The executed I10 suite adds six classic index cases, including a synthetic
sparse 1 TiB address space with 5,000,000 entries and co64 offsets. It adds an
authored two-clip H.264/AC-3 fixture with independently parsed trims and FFprobe
PIDs to the actual WASM tests. The disc fixture revealed and regresses a native
persistent-preferences filesystem trap. These are navigation/index correctness
checks, not evidence of real-large-file throughput or A/V playback.

After package compilation, `node test/disc-browser.mjs` runs the actual module
Worker and FileReaderSync under Playwright. Run evidence records the exact
runtime and fixture hashes, browser version, hash matches and worker closure.
The recorded Linux headless result is component evidence only.

The [packing matrix](../packing-formats.md) adds actual browser playback of an explicitly chosen original Blu-ray clip from a local ISO or BDMV folder. It does not substitute raw clip playback for the playlist span or prove transitions, PGS, remote ISO, or whole-title support.

Run `node test/mp4-playback-browser.mjs` after building for the large-index
seek-to-EOS browser regression. The generated media has actual encoded AVC
and AAC payloads. The test covers a 96-minute timeline without running a
96-minute endurance trial. Node checks the same classic seek over ETag-bound
ranges and a sparse MOV address space beyond 4 GiB.
