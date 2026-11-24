# Experimental native remux and TrueHD bridge

I08 keeps the native path opt-in and reports `NOT_QUALIFIED`. N2 forwards
compressed video unchanged and converts admitted conventional TrueHD channel PCM
to 24-bit FLAC. The selected 5.1(side) fixture retains all six decoded channel
samples and their ordering. The path refuses unknown or changed TrueHD layouts,
missing major-sync recovery, unrepresentable video PTS, selected container HDR
records the muxer would drop, and a missing consumer for selected subtitles.

The pinned writer uses a 1 MHz video timescale. The 1 ms Matroska fixture's 48
video PTS are exact after remux. The writer reconstructs DTS and normalizes
`av1C`. It does not copy Matroska CodecPrivate verbatim or preserve arbitrary
container edits and sample configurations. The fixture's in-band mastering and
content-light metadata survive every unchanged video access unit. Video
durations are written at the MP4 timescale, rather than asserted to be exact
nanosecond Matroska durations.

## Tested component scope

`UBVE_REQUIRE_FFMPEG_EVIDENCE=1 node --test test/native-bridge.test.mjs` runs
after the workspace package build. The test uses the pinned TrueHD and FLAC WASM
workers through a Node worker transport, cross-checks 48 video access units and
timestamps, verifies 24 forwarded timed ASS packets, and checks 38,400
continuous 48 kHz FLAC frames. Independent FFmpeg 7.1.5 decodes byte-identical
6-channel, 24-bit PCM and observes identical HDR10 metadata on all 48 pictures.
The check does not establish physical speaker routing or subtitle composition.

A browser smoke is available with `npm run build:assets`, followed by
`node test/native-bridge-browser.mjs`. It records the exact combined MIME
response, decoded readiness, reported frame counts and non-autoplay seek.
Set `UBVE_CHROMIUM` to use an installed executable. For an authorized hosted
browser, use `UBVE_CDP_URL` and set `UBVE_TEST_ORIGIN` to a reachable Vite test
origin that serves the identical assets. The system Chromium build stopped at
process launch with a denied socket. An alternate headless Chromium
(158.0.8127.0, Linux x86-64) accepted both MIME spellings and completed the
720p60 fixture. With decoded readiness required, the session reported 48 total
video frames, 5 drops, the full 0.800-second duration, and an acknowledged
paused seek to 0.213 seconds. The earlier buffered-only attempt reported 7
drops. Both attempts remain negative evidence for zero missed pictures. These
are isolated short trials, not a controlled performance comparison.

No result here verifies a display, GPU or physical output, closes the 60/120
gate, or qualifies broader AV1/TrueHD/FLAC inputs.
