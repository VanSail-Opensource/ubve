# Packet-fed software codec candidates

`Av1Decoder` owns a dedicated dav1d worker, the pinned atomic WebAssembly binary,
and the libmedia thread runtime. `TrueHdDecoder` owns the exact Mediabunny 1.66.4
TrueHD worker and emits integer PCM. `TrueHdPacketCodec` and `FlacPacketEncoder`
provide the bounded packet/PCM operations needed by the experimental lossless
native bridge. All codecs consume selected demux packets; none consumes a whole
file, a MEMFS image, a command-line FFmpeg invocation, or native WebCodecs.

Build the self-hosted assets with `node scripts/build-codecs.mjs`. The atomic AV1
binary is verified before build and again by the decoder before instantiation.
The build writes `public/vendor/codecs-manifest.json` with hashes of every asset.
The default SIMD/four-thread candidate remains blocked because the retained v8
evidence found pixel mismatches. Atomic thread counts 1, 2, and 4 are candidates.

## Ownership and limits

Successful `trySubmit` moves the packet lease. `inputConsumed` settles when the
adapter no longer needs that source lease. Output consumers run concurrently
with input production and EOS. A borrowed output stays charged until its owner
releases the lease. `drain` waits for accepted input settlement; it does not wait
for arbitrary consumer-held frames. `flushEndOfStream` seals input and requires
concurrent output consumption. Reset advances the epoch and creates new workers;
disposal is terminal and joins the active command chain.

AV1 detects a decoder-owned frame before reserving worst-case storage for the
worker plane copy. An empty receive therefore cannot block on a recipient-held
frame, including at EOS. The worker copies only the admitted coded planes and
records color/HDR metadata separately from claims about the display. Input is
limited to eight accepted packets, normally 16 MiB total, with one exclusive
packet up to 32 MiB. Reordered output is associated by an opaque per-packet
token. The original rational PTS/duration survive this association unchanged,
including coincident timestamps. Ambiguous output association, unsupported
formats, excess unmatched packets, and unproductive EAGAIN retries fail visibly.

TrueHD commands contain at most 64 packets and 4 MiB, with at most 4 MiB of decoded
output per command. PCM is interleaved signed 32-bit storage with 24 valid MSB
bits, and output blocks contain 1024 sample frames except the EOS tail. Source
timestamp quantization tolerance is explicit; a larger discontinuity fails.
Channel labels supplied by the caller do not establish physical speaker output.
The integer-to-float helper uses a power-of-two scale and admits at most 24 valid
bits. It does not resample, downmix, or silently trim a timeline gap.

## Evidence status

These are **NOT_QUALIFIED** runtime candidates. The existing research baseline
is separate from these implementation results. The development browser harness
at `/tests/codecs.html` records exact plane/PCM hashes, EOS, restart seek, and
disposal. When a browser host is unavailable, the separate Node correctness lane
runs the actual packaged WASM in `worker_threads` via a test-only Web Worker
transport. The bundled 720p60 AV1/HDR10 + TrueHD test compares all 48 ordered
pictures, the HDR descriptor and all 38,400 six-channel PCM frames against
native reference decoders over two decoder epochs. It also retains the only
admitted video frame during EOS. The Node lane does not exercise browser policy,
audio/video presentation, timing gates, subtitle composition, or physical output.

```sh
npm run build:packages
node scripts/build-codecs.mjs
node --test test/codecs-node.evidence.mjs
node test/codec-matrix-node.mjs HDR10_CORPUS_DIR evidence.json COMBINED_CORPUS_DIR
node test/av1-file-node.evidence.mjs "AV1_FIXTURE.mp4" EXPECTED_SHA256
```

The matrix records source hashes and actual container bitrate separately from
encoder targets, and preserves missing sources and failed rows. Its independent
reference commands use native FFmpeg/libaom. No FPS is inferred from those runs.

The external-file probe accepts a disk-backed Blob, can pin the publisher's
SHA-256, and checks every decoded AV1 picture against independent libaom hashes.
It also compares known first-frame color descriptors and static HDR signaling
when present in the reference. This is the video component only. A soundtrack,
if present, is listed as untested rather than dropped from a playback claim.
MP4 timestamps from the current packet adapter remain API-derived.
The probe defaults to one decoder thread. Set `UBVE_AV1_WORKER_THREADS=4` for a
separate control. Set `UBVE_AV1_PREFIX_PICTURES` to compare an explicit prefix of
the original file without claiming EOS or whole-source coverage.

The managed ISO BMFF/MP4 route requests one AV1 decoder thread. On Jellyfin's
video-only 1080p60 SDR 3 Mbps sample, the unmodified four-thread atomic candidate
emitted the correct 1,797 frames but differed in decoded pixels starting at
display index 422. The single-thread candidate matched all 1,797 ordered
hashes independently produced by both native libaom and native libdav1d.
This is a tested correctness constraint, not a throughput improvement.

An experimental four-thread atomic schedule that fused submit and frame copy
skipped most explicit take commands, but one run changed three decoded pictures
in the same 48-picture reference fixture. A subsequent clean repetition series
did not clear that failure. This schedule is not enabled by the player.

The upstream dav1d receive ABI conflates empty output and codec EOF. The adapter
reports accepted flush followed by receive-to-empty, rather than claiming an
independently observed codec EOF. Worker termination is requested after the
runtime close response, but browser APIs do not expose physical child-thread
exit acknowledgement. Internal WASM heap use remains an opaque estimate; the
explicit input/output budgets do not claim a hard ceiling for runtime memory.

Dependencies are exact versions: libmedia avutil/cheap 1.3.1, libmedia common
2.3.0, Mediabunny TrueHD/FLAC 1.66.4. Their upstream license and source obligations
remain applicable. No result qualifies full HDR output, native playback clocks,
channel routing, render throughput, ProRes, or FFV1.
