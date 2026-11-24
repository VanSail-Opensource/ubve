# I02 — Incremental local source and admitted demux

**Status:** pending production integration. **Dependency:** I01. **Owner:** I/O agent. **Owned paths:** new `packages/io-demux/`, I/O fixtures/tests; integrator owns shared manifests/core migrations. **Providers:** Mediabunny 1.66.4. Read ADR003/006 and [managed policy](../policies/managed-profiles.proposed.json).

## Delivery and methods

Implement File/Blob `RandomAccessSource` with immutable identity/revision, checked size, exact half-open `readExact`, cancellation/deadline and terminal `close`. Own one 8 MiB local cache in the I/O worker; borrow/move charged slices rather than duplicating a whole source. File/Blob objects are cloneable references, not a reason to call whole-file arrayBuffer. Bound active reads and retain no source credentials/private filenames in diagnostics.

Implement the proposed internal `openDemux`/DemuxSession seam in [contracts.md](../contracts.md): bounded immutable tracks, serialized per-track `readPacket`, exact recovery-point seek result and awaited close. One bounded provider supplies all selected video, audio and subtitle tracks. Inspect the pinned provider API/source before wrapping; no invented rational DTS accessor. When it exposes floating timestamps, keep `api-seconds`, original floats and explicit rescaling, nullable source spans and representation. Required unavailable remux timing fails admission.

Primary v8 candidate: actual AV1 10-bit HDR10 + conventional TrueHD channel audio + required ASS in Matroska, with exact manifest/profile admission; accepted native fMP4 output is a separate I08 mapping. Retain the former ProRes/AC-3 SDR fixture as historical regression only. TS/disc/other mappings need their own valid fixtures; broad parser feature lists do not enable them automatically.

The inspected Mediabunny public track seam does not expose the embedded ASS track in the combined fixtures, though attached font bytes are available from AttachedFile metadata. Add a narrow central-cluster/track adapter preserving CodecPrivate, BlockGroup durations, lacing, cue order and attachments; do not add an independent unbounded second scan. Preserve AV1 access units, sequence metadata/OBUs, actual profile/level/tier/tiles, static HDR rationals and every configuration epoch. Unknown or conflicting container/bitstream metadata is explicit. Encoder flags and decoded pixel hashes do not alone prove complete source-level conformance.

Codec tags alone do not admit a packaged subtitle track. The v8 ASS-in-NUT fixtures exposed a concrete failure: the examined stock FFmpeg 7.1.5/5.1.4 NUT packet path does not preserve ASS packet duration, so round-tripped cues have zero display interval. Retain those failures. A valid Matroska route or an explicitly declared NUT video/audio plus separate ASS asset is a different admission case; do not relabel a missing subtitle workload as successful embedded playback.

Before upstream table allocation, scan bounded box metadata/counts/depth and cross-check lengths/parent extents. Reject moov over 16 MiB or aggregate expanded entries over 262,144; count timing/chunk/sync/config/edit tables as well as sizes. Limit parsed tracks to 32 and nesting to 32. This deliberately restrictive first path is replaced by complete paged semantics in I10, not by raising the limit on a failing file.

## Queue and seek behavior

Ordinary selected-track compressed queue is 128 items and 8/16 MiB by profile. A packet over ordinary capacity but at most 32 MiB uses an **explicit separate exclusive admission state**: drain ordinary queue, reserve its complete global bytes, admit exactly one exceptional packet, then restore normal admission. Do not insert it into an unchanged smaller OwnedQueue or repeatedly return temporary backpressure for an item that can never fit. Above 32 MiB or global inability is permanent ITEM_TOO_LARGE.

Seek reports actual recovery/preroll points. The coordinator decodes to the target and presents the covering video interval; audio trims by sample position. Config/track changes create explicit epochs. End-of-track null is distinct from a temporary read wait. Source error stops producers and releases undelivered packets/cache leases.

## Fixtures

Use the frozen v8 HDR10/combined manifests and actual source hashes as primary real fixtures; retain the supplied MOV/hash as historical regression, but stream through the new source rather than preloading it. Add exact EOF/empty/high-offset reads; canceled reads; one-cache accounting; oversized/malformed/nested moov; a five-million-entry declared table rejected before expansion; negative/edit/composition timestamps; repacked packet bytes; unknown DTS; fractional 1.017 s seek to interval [1, 1.03333…); and source replacement.

Add instrumentation proving bounded requested bytes, metadata allocation and active cache, without full-input copying. Sparse/virtual offsets test arithmetic only. Retain fixture hashes, generator/provenance and expected metadata.

## Verification and exits

**Existing:** `npm run check`, `npm run build`, `npm test` after integrator wires the actual package. Existing root commands alone currently cover only three starter packages.

**TO CREATE:** `npm run test:io` executing real source/demux boundary fixtures, plus a browser File/Blob worker smoke through `test:browser` when I05 provides that runner. No dependency on native execution.

Success: actual incremental source→packet route, original provenance retained, preflight rejection before expansion, bounded queues, seek/close/cancel behavior and real fixture comparisons. Failure: INVALID_PACKET for malformed metadata, ITEM_TOO_LARGE with exact reason for admission ceilings, UNSUPPORTED_CODEC with missing timing/layout/color reason, SOURCE_CHANGED for mutation. No whole-file fallback or fabricated metadata.

**Next:** I05 consumes this with I03/I04; I07 HTTP and I10 paged indexing are independent extensions.
