# Jellyfin corpus browser screening

Use [Jellyfin's public test video directory](https://syd1.mirror.jellyfin.org/test-videos/) and its published SHA-256 files to select the encodes you want to exercise. The library is credited to Gnattu and distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Media is not vendored. The mirror's MP4 samples are checked individually rather than inferring their stream metadata from filenames.

## Run

After `npm ci --ignore-scripts` and `npm run build`, ensure FFprobe and a real Chromium executable are available. Fetch the 12 originals (approximately 725 MB) with their pinned SHA-256 values. Repeat `--case` with IDs from `test/fixtures/jellyfin-corpus.json` to download a subset.

```sh
python3 test/fetch-jellyfin-corpus.py --out .local/jellyfin-media
```

For a separate corpus, store the downloaded cases under a local media root with a manifest such as the following.

```json
{
  "cases": [
    {
      "id": "sdr-avc-1080p-3m",
      "path": "SDR/AVC/Test Jellyfin 1080p AVC 3M.mp4",
      "sha256": "30f19d65b19f606f5352deb956843692cb6cee9a5bcfb43fce549f94e3bd29ce",
      "bytes": 11302222,
      "expectedVideoCodec": "h264",
      "expect": "observe"
    }
  ]
}
```

`id`, `path` and `sha256` are required. `bytes`, `expectedVideoCodec` and `sourceUrl` are optional. `expect` defaults to `observe`, which allows functioning playback or a specific unsupported-profile refusal. Set `playback` or `refusal` to check a known host expectation. Missing files, checksum mismatches, timeouts and decode failures never count as passing refusals.

```sh
UBVE_JELLYFIN_MANIFEST=.local/jellyfin-media/manifest.json \
UBVE_JELLYFIN_MEDIA_ROOT=.local/jellyfin-media \
UBVE_JELLYFIN_DIST=apps/vue-player/dist \
UBVE_JELLYFIN_OUTPUT=.local/jellyfin-browser \
UBVE_CHROMIUM=/abs/path/to/chromium \
npm run test:jellyfin
```

Without `UBVE_CHROMIUM`, the runner uses Playwright's installed Chromium. `UBVE_JELLYFIN_CASES` optionally selects a comma-separated subset. `UBVE_JELLYFIN_CADENCE_SECONDS` defaults to one media second and accepts 0.25–10. `UBVE_JELLYFIN_HEADED=1` uses a real display if one is available. A launcher can itself apply GPU flags, which remain part of the test setup. Run only one cohort on an exclusive host during a comparison, with the same launch configuration, ordering and source files for both builds.

## What the receipts establish

The production build is served locally and the actual Vue app receives a browser-selected `File`. No media upload or remote media fetch forms part of the test. A source hash and bounded FFprobe check verify the exact media bytes, video profile, codec, dimensions, duration, color signaling and declared cadence separately from the player. The successful path checks native route `N0`, no autoplay, play and pause, a paused seek with a native `seeked` acknowledgement, resume, app-exported diagnostics, and close. Closing requires an empty UI, a detached `HAVE_NOTHING` media element, and rejection of a one-byte local blob range that resolved before close. Chromium may retain the old `currentSrc` string even after revocation. Specific codec-decline messages are preserved with available browser and player error codes.

The runner saves one raw receipt per case and a summary. Startup is measured from the file-input change event to `loadedmetadata` or the app's Ready label. Seek is measured from slider commit to `seeked`. Frame callback counts, media timestamps, compositor submission counters and media-element quality counters are kept separate. The input is already hashed and probed, so startup is not a cold-disk measurement. No result establishes physical scanout, hardware acceleration, audiovisual fidelity, sustained 60/120, or HDR/Dolby Vision output. A 60 Hz source in an MP4 is not a playback gate pass.

## Findings with the pinned 12-file cohort

FFprobe identified every original as a 29.95-second, 60 fps, video-only MP4. The corpus spans 1080p and 4K AVC, AV1, and HEVC, including HDR10 and Dolby Vision profile 5 and 8.1. It cannot verify audio, subtitles, or a 120 fps source. Use the case lock for the exact media, not just an encode with the same label.

All 12 cases produced the expected functional outcome on Linux Headless Chromium 158 with GPU disabled. Seven AVC/AV1 files opened natively and passed play, pause, seek, resume, and close. Three HEVC files were refused with the exact unsupported browser codec tuple. Both local Dolby Vision files were refused explicitly instead of silently treating a Dolby Vision or compatibility base as admitted output. These refusals are not HEVC or Dolby Vision playback passes. The AV1 HDR10 native cases verify transport, not physical HDR fidelity.

The native element now owns playback without retaining a duplicate application metadata cache. It also samples SDK frame telemetry at 250 ms intervals and avoids scheduling a subtitle callback when no native overlay needs it. Live native frame diagnostics remain separate from compositor and element quality counters. Neither bounded measurement work nor lower application memory implies a faster native decoder.

Compare the same test bytes with `node test/io-mp4-reference.mjs .local/jellyfin-media/manifest.json sdr-av1-4k-40m`. The original reader stopped after 807 of 1,797 packets with 67,070,749 temporary provider bytes held. The candidate completed all 1,797 against independent FFprobe payload checksums and timestamps, with a 226,051-byte peak and zero temporary provider bytes held at completion. The 4K HDR10 encode also matched all 1,797 packets. Local metadata coalescing brings startup on the SDR AV1 file to 12 source reads and 11,147 bytes, compared with two larger reads and 368,433 bytes on the baseline. The coalesced `moov` window is released or handed off before Ready. Those are application-side byte counts, not a wall-clock, whole-process memory, or provider-internal allocation claim.

The previous four-thread software adapter completed the 1080p SDR AV1 file but did not match reference pixels. The first mismatch was at zero-based display index 422. One thread matched all 1,797 ordered pictures against both native libaom and libdav1d. Managed ISO BMFF now requests one AV1 decoder thread. The separate native and Matroska routes are unchanged. The first 120 decoded pictures of the 4K60 HDR10 AV1 original also matched libaom with one thread and paged demux, but this did not exercise the rest of the file's decode or establish HDR rendering. A full software browser lifecycle was exercised on the 1080p HDR10 case. Unknown SDR transfer metadata is not silently reinterpreted in the player.

## Native startup and seek tradeoffs

Three counterbalanced pairs of short playback runs on the same GPU-disabled browser compared the final coalesced build with `d19be22`. The table gives the median for each build in milliseconds. Every run exercised the same fixture and seek action. Startup was still about 6–10 ms slower for these three cases, while the app retained no duplicate parser cache after handoff. Seek timings varied, and the small sample does not establish a seek speedup.

| Input | File → Ready original → candidate | Seek original → candidate | App-owned bytes reported after handoff |
| --- | ---: | ---: | ---: |
| 1080p AVC SDR | 44.3 → 50.6 ms | 29.5 → 27.3 ms | 292,174 → 0 |
| 4K AV1 SDR | 45.5 → 53.0 ms | 1,180.2 → 1,140.5 ms | 368,433 → 0 |
| 4K AV1 HDR10 | 43.1 → 52.8 ms | 1,061.1 → 1,047.1 ms | 419,551 → 0 |

## The CPU conversion improvement

Three frames starting at 5 seconds of each named Jellyfin SDR AV1 input were decoded to 10-bit planes before timing. The original `d19be22` and the candidate were compiled separately and received the same aligned planes and output reuse policy. We ran three independent processes per profile with seven alternating pairs on each of three pictures. The table gives the median of the three process medians. Every compared output was byte-identical RGBA8. The files do not declare a transfer characteristic, so the test explicitly chooses a BT.709 interpretation for this component test only. It does not change product admission or tone-map HDR.

| Input and raster | Original | Candidate | Less conversion time |
| --- | ---: | ---: | ---: |
| 1080p 3M → 1080p | 56.92 ms | 49.01 ms | 13.9% |
| 4K 40M → 4K | 198.63 ms | 161.86 ms | 18.5% |
| 4K 40M → 720p | 26.81 ms | 22.24 ms | 17.0% |

`test/presentation-sdr10-benchmark.mjs` accepts `UBVE_SDR10_BASELINE_MODULE` pointing to the separately built baseline's `packages/presentation/dist/index.js`. Set `UBVE_SDR10_TRANSFER_OVERRIDE=bt709` for the named SDR inputs and pass the local file, maximum output height, and start second as arguments. The timer includes only CPU conversion into a reused output buffer. It excludes source decoding, canvas upload, video scheduling and the display. Do not convert these measurements into a 60/120 fps claim.
