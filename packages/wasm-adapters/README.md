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

AV1 reserves worst-case frame storage before requesting each worker plane copy.
The worker copies only the admitted coded planes and records color/HDR metadata
separately from claims about the display. Input is limited to eight accepted
packets, normally 16 MiB total, with one exclusive packet up to 32 MiB. Reordered
frame provenance is associated by the timestamp supplied to the codec. Unknown
timestamp associations, timestamp collisions, unsupported formats, and
unproductive EAGAIN retries fail explicitly.

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
disposal. In the implementation environment, local Chromium launch and the
supported cloud browser's localhost access were blocked, so browser execution
must run in CI or a permitted environment. Component execution under Node, when
recorded, does not qualify browser playback or performance.

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
