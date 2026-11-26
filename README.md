# Universal Browser Video Engine

UBVE is a browser-only playback SDK and Vue reference player. It opens selected local files or URLs in the browser without uploading media or requiring an installed helper. This repository is an **implementation candidate**, not a qualified release.

## Run the player locally

Use Node 24.22.3 and npm 11.19.1.

```sh
npm ci --ignore-scripts
npm run dev
```

The standard document is `/`. Portable software codecs work without shared memory. Use `/isolated/` to try the shared-memory AV1 candidate. Changing documents requires reopening a selected local file. Browser and output capability checks may refuse a specific route. The app reports the selected route, transforms and qualification separately.

### What is implemented

- Bounded Blob and strict HTTP range reads, selected-track Matroska demuxing, and exact packet provenance where available.
- Packet-fed AV1 and TrueHD software candidates, an AudioWorklet clock, and ASS/PGS/IMSC and timed-text components.
- Bounded software fallback for the [modern codec matrix](docs/modern-software-codecs.md), including AVC, HEVC, VP8/VP9, AAC, Opus, ALAC, and conventional AC-3/E-AC-3/DTS Core.
- Browser-native direct playback candidates, bounded stream-copy remuxing, and a lossless TrueHD-to-FLAC candidate for one native media clock.
- Canvas presentation with declared SDR transforms and an explicit, unqualified WebGPU presentation candidate. WebGPU does not decode the compressed AV1 stream.
- [HDR10-compatible base playback](docs/hdr-base-playback.md) for admitted Dolby Vision Profile 8.1 and single-video-track Profile 7 files. Software decodes the HEVC base without applying Dolby Vision metadata or enhancement layers.
- A [verified packing matrix](docs/packing-formats.md) spanning MP4/MOV, MKV/WebM, MPEG-TS/M2TS, common audio containers and clear local Blu-ray ISO/BDMV clip playback. Large classic MP4/MOV uses paged sample tables, and fragmented MP4 bounds sample metadata per fragment. This is not whole-disc or release qualification.

## Verify the build

```sh
npm test
npm run test:codecs
npm run build
npm run check:static
```

[Command reference](docs/commands.md) · [Canonical phases and status](docs/IMPLEMENTATION-STATUS.md) · [Cloudflare Pages target](docs/cloudflare-pages.md) · [Distributed asset audit](docs/distributed-assets.md)

The optional [LAN test lab](docs/device-lab.md) lets the master pair browser devices, queue software playback and timing screens, and retain every attempt. It is not deployed with the static player.

## Playback qualification

The [v8 specification](docs/specification/Universal-Browser-Video-Engine-v8.0.md) requires genuine 60/120 source cadence, no late or dropped eligible pictures, exact selected audio/subtitle behavior, sustained trials and separate physical-output evidence. Full HDR10 and declared performance mode are separate admissions. Dolby Vision and object-audio rendering are not claimed.

FPS targets are not deployment gates. `npm run release:check` validates the static artifact for publication. `npm run support:generate` records playback evidence separately. Component correctness, short-clip playback and API admission do not qualify 4K60 HDR10, 120 fps playback or cross-platform physical HDR output.
