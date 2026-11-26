# Modern software codec candidates

Managed playback uses the same bounded packet source, Canvas/overlay and media clock whether a track has native support or not. Eligible native playback remains preferred in Automatic mode. Managed mode forces software. Standard secure pages use portable libaom for AV1. An isolated document can use the pinned single-thread atomic dav1d candidate. Four requested atomic threads are not a browser default and the retained SIMD failures remain blocked.

| Family | Intended clear-file envelope |
| --- | --- |
| AVC and HEVC | AVC Baseline/Main/High, HEVC Main/Main10, progressive 4:2:0 in MP4/MOV and Matroska |
| AV1, VP8, VP9 | AV1 Main 8/10-bit in MP4/MKV/WebM, VP8 in WebM/MKV, VP9 profiles 0/2 in WebM/MKV/MP4 |
| AAC, Opus, Vorbis, MP3 | AAC-LC and HE-AAC in MP4/M4A/MKV, Opus and Vorbis in Ogg and WebM/MKV, standalone MP3 |
| FLAC, ALAC, PCM | 16/24-bit FLAC in FLAC/MKV, classic one-track ALAC in MP4/M4A, 16/24-bit integer or float32 PCM in WAV/MOV |
| AC-3, E-AC-3, DTS, TrueHD | Conventional Matroska channel audio, including DTS Core, ES, 96/24, DTS-HD HRA and DTS-HD MA. No implicit core extraction or DTS:X object rendering. |

The envelope does not make every codec cross-product an exercised tuple. See the authored manifest for exact tested inputs. Color/range must be signaled for managed presentation. Full HDR software output is not admitted on Canvas, and **Performance** explicitly maps supported HDR10 to SDR. Unknown signal interpretation, unhandled edits or layouts, DRM, Dolby Vision without an admitted base, and missing required subtitles refuse visibly.

The portable FFmpeg DCA decoder leaves extensions enabled and checks the actual
decoded profile and channel layout. DTS-HD MA retains integer PCM. DTS:X,
Express and midstream profile changes still refuse. Native FFmpeg matched the
PCM on five FATE clips covering 5.1/7.1 MA, 5.1 HRA, 6.1 ES and 96 kHz 96/24.
The fixtures were remuxed to Matroska without re-encoding and played through the
managed browser pipeline as a separate short check. These clips are not
redistributed with the player. [FFmpeg's DTS reference fixtures](https://fate-suite.ffmpeg.org/dts/dcadec-suite/)

## Verify or rebuild

```sh
npm run test:codecs
npm run build
npm run test:codecs:browser
```

The component lane verifies the committed source hashes, all ordered video plane hashes, and exact lossless audio samples. Lossy references carry an absolute per-channel tolerance of 0.0001 and RMS tolerance of 0.00001 on normalized float PCM. The real Chromium lane forces software in a standard non-isolated document. It exercises the public SDK, Canvas and AudioWorklet, not hardware decode or physical output.

The decoder-only assets are built for portable non-threaded WASM. A normal npm build verifies and stages the pinned assets and notices. To reproduce them on Linux/WSL, install and activate the pinned Emscripten 6.0.0 SDK and run `bash scripts/build-software-codecs.sh /path/to/emsdk /path/to/clean/build-dir`. The recipe pins the exact FFmpeg and libaom source archives by SHA-256 and records both WASM asset hashes. Upstream sources can be retrieved with the same recipe. This is not a release qualification or a distribution approval.

The Jellyfin corpus is optional and video-only. Use the existing downloader and the full-source AV1 component probe to reproduce the 1080p and 4K regression checks. The 4K probes may need a longer finite `UBVE_AV1_VERIFY_TIMEOUT_MS`. The separately downloadable Fraunhofer HE-AAC samples are not bundled. Download the two locked files in `test/fixtures/he-aac-corpus.json` to a local directory, set `UBVE_MODERN_MEDIA_ROOT` to that directory, and pass the manifest as an argument to either modern test command. The component test for these external cases uses FFmpeg on PATH. [Jellyfin test videos](https://syd1.mirror.jellyfin.org/test-videos/) · [Fraunhofer AAC playback tests](https://www2.iis.fraunhofer.de/AAC/stereo.html)
