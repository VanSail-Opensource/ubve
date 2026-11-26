# UBVE source and demux

Local ISO base-media file inspection reads exact box headers and the pinned
provider's requested metadata extents. One local `moov` body up to 128 KiB
can be read once for preflight and handed to the parser without a duplicate
source read. A small local file can reuse its one
cached page, and remote reads keep their existing paged range policy. Selected
packet streaming keeps the bounded page cache. The provider's temporary source
loan is separate from its opaque parser allocations.

Mediabunny 1.66.4 copies each received source chunk into an independent parser
slice with the provider cache disabled. Its cancellation of the completed
readable stream acknowledges the handoff. UBVE then releases the temporary
lease. This avoids retaining every delivered parser-read buffer until session
disposal. A real uncancellable Blob read remains charged until it settles.

## Untimed reference check

Build the package then run the selected case from an exact fixture manifest.

```bash
npm run build:packages
node test/io-mp4-reference.mjs /path/to/manifest.json sdr-av1-4k-40m
```

Set `UBVE_IO_MODULE` to a separately built baseline package to compare the
same input. The reference check verifies the complete fixture SHA-256 and
compares packet payload hashes and presentation timestamps to ffprobe. It does
not turn seconds exposed by the parser into original container DTS evidence.

The 149,528,369-byte Jellyfin 4K60 SDR AV1 fixture reached a 64 MiB read-result
budget refusal at 807 of 1,797 packets before this change. The new path matched
all 1,797 packets, reached EOS, held zero retained results, and peaked at
226,051 temporary provider bytes. The coalesced local open needed 12 source
reads totaling 11,147 bytes. The earlier exact-probe version needed 45 reads
and 11,591 bytes. The original production baseline needed two larger reads
totaling 368,433 bytes. These are byte and call counts, not proof of reduced
open time or better rendering performance.

## Dolby Vision declarations

ISO preflight recognizes dedicated Dolby Vision sample entries and framed
configuration children of compatible visual sample entries. A declared profile,
level and base-compatibility code can support an explicit route decision. An
empty record does not prove absent in-band metadata. A parsed record is
container evidence only. It does not establish Dolby Vision rendering or
physical output.

## Provider bounds

MP4 preflight checks recognized leading boxes and bounded table counts. Large
classic MP4/MOV opens with sparse checkpoints and source-exact sample payloads.
The codec probe passes a small private MP4 with one access unit per track to
the pinned provider. It never passes the actual large tables to that provider.
Application limits are 8 MiB for that temporary probe, 256 KiB for each
description box and 1 MiB of retained codec-private bytes. Exact sample spans
are checked against their `mdat` extent on demand.

Fragment preflight limits each expanded fragment and separately bounds lookup
rows. The ordinary provider may still allocate internal metadata or pending
slice storage. Per-range limits only bound application-owned reads and handoff
leases, not the vendor heap.

Selected packet seeks check cancellation between provider operations. They
do not preempt a running upstream key lookup or packet read. Source range
operations have their own deadlines, and session disposal closes the input
and cache. A local Blob read already in progress remains charged until it
settles. These are source bounds, not an end-to-end seek latency guarantee.
