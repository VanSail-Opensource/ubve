# ADR 003 — Preserve source bytes, timing and interpretation provenance

**Status:** core contracts/helpers validated; real source/demux implementation pending I02, full paged indexes I10.

## Exact reads and identity

Use checked BigInt-derived byte positions and half-open `[start,end)` ranges. A `readExact` resolves exactly the admitted range or rejects; zero length including EOF succeeds; outside known size fails. Convert to Number only after checking a specific API's safe representable domain. Do not use bitwise offset arithmetic. Source identity/revision is immutable for an open session. A native opaque URL is a separate source descriptor and never pretends to offer exact byte reads.

Source cancellation is observed cancellation: reject delivery once observed and abort underlying work where the API supports it. FileReaderSync and other uninterruptible work remain charged until completion or owned-worker termination. Timers execute at their earliest runnable callback; check the deadline at admission and completion as well.

I02 owns one bounded source cache. Parser/codec consumers borrow or move explicitly charged buffers; no second invisible cache or whole-file preload is required. Check metadata sizes/counts/depth before constructing upstream objects that expand tables. Initial progressive MOV admission rejects moov over 16 MiB or more than 262,144 aggregate expanded sample/timing/chunk/recovery/config/edit entries; this is a finite initial restriction, not a claim of a fully paged parser.

## Timing and bytes are independent provenance

`EncodedPacket` keeps signed rational PTS, nullable original DTS/duration, decode order, recovery flags, configuration epoch and timing provenance. `container-exact` means read from or rigorously reconstructed against source semantics; `api-seconds` records the exposed original float and conversion description. Converting a floating timestamp to bigint does not restore unavailable container evidence. Preserve DTS null when unknown; do not set it equal to PTS to make remux accept it.

Representation is `source-exact`, `repacked` with named transformations, or `opaque-adapter` with reason. Original source spans can be null. Source-exact spans must sum to encoded bytes; repacking/header removal can change byte counts. A payload-byte comparison does not establish timestamp, priming, edit-list, delay or configuration preservation.

An output retains packet/session/config identity even when reordered or emitted after later input. Rational conversions specify floor/ceil/nearest behavior, including negative timestamps. Decode preroll is not presented content. At a seek, present the video interval containing the target and trim decoded audio to the exact target sample; the next video PTS is not necessarily the correct picture.

## v8 primary metadata policy

The primary candidate is AV1 Main/Profile 0, 10-bit 4:2:0, PQ/BT.2020 HDR10 with conventional TrueHD channel audio and required ASS subtitles. Retain the exact original channel layout, precision and sample rate. Progressive ProRes 422 HQ with stereo AC-3/E-AC-3 and SDR BT.709 is a historical fixture, not the v8 default. Keep dimensions, source field/interlace flags, sample aspect, display transform, source color, audio labels/rate, codec private data, language/default/forced flags and track identity in bounded descriptors even when a selected route cannot render them.

Preserve decoded mastering-display chromaticities and luminance as exact rationals, and content-light levels as exact integers. Preserve encoded AV1 metadata OBUs and their ordering through a stream-copy route; retain the corresponding container color/configuration metadata. Encoder arguments are intent, not proof: admission uses independently parsed profile, bit depth, level, tier, tiles and HDR signaling from the actual file. A matching pixel reference does not establish full AV1 Annex A/E conformance or physical HDR output. The companion fixture audit identifies the current corpus and any remaining conformance limits.

Subtitle packets, timing, fonts/attachments, shaping dependencies and codec-private state belong to the same bounded source session. Add the shared descriptor and I420P10/HDR/integer-PCM type migrations through I01 before production adapters claim those fields. The preserved core source does not yet implement those additions.

Unknown or unsupported color is not guessed from resolution. A deliberate caller source-interpretation override must name primaries, transfer, matrix and range, preserve original unknown values, and appear in diagnostics. It is not conformance evidence. Unknown required interlace/layout metadata or an unimplemented orientation/aspect/HDR transformation returns an explicit unsupported-metadata reason until its adapter and fixture exist. The current output union cannot silently describe 12-bit, 4:1:1, HDR side data or another layout as I422P10; add centrally reviewed types before admission.

## Full index and remux boundaries

I10's paged MP4 work must cover variable/fixed sample sizes, signed composition offsets, timing runs, chunk mapping, co64/stco, sample descriptions/config changes, sync/recovery groups, edits, fragment sequence/defaults and encryption rejection. An index that pages only stsz is incomplete. Preserve exact timestamps and known source spans without materializing every record.

I08 is a priority implementation branch with separately deferred device qualification. Remux acceptance compares source semantics, raw output-container timing and downstream interpretation for every sample. Native API availability alone cannot qualify it. Missing required DTS/priming/edit evidence or unpreserved HDR metadata keeps that exact route disabled. A TrueHD-to-FLAC bridge changes the audio encoding and must verify conventional PCM identity, priming/delay and timing independently; it does not preserve Atmos objects or compressed TrueHD identity.

## Evidence and validation

The common-container prototype uses one MOV/Input and retains `api-seconds` provenance. Its source PTS/duration observations matched an independent ffprobe reference within declared 1e-8-second tolerance; this remains a floating API observation and synthetic intraframe fixture. It does not qualify B-frames, arbitrary edits, remux, huge media or original rational DTS.

Test EOF/high offsets, odd range boundaries, negative/fractional timestamps, repacked bytes, decoder delay, configuration changes and fractional seek. Malformed or oversized metadata must fail before upstream expansion, with evidence that the input was not wholly copied or scanned.
