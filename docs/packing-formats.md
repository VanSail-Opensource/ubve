# Playback containers and disc images

UBVE identifies containers from bytes. A suffix is a file-picker hint, not a promise that every codec, edit list, or track arrangement in that format will play. The [locked fixture matrix](../test/fixtures/packing/manifest.json) lists the exact combinations below, including independent FFmpeg picture and sample counts. Refer to the [codec matrix](modern-software-codecs.md) for the separate codec limits.

| Packing | Tested combinations |
| --- | --- |
| Classic ISO Base Media (`.mp4`, `.m4a`, `.3gp`, `.3g2`) and QuickTime (`.mov`) | H.264 with AAC, and M4A with ALAC. `.m4v` is accepted as a naming variant when the file is actually ISO BMFF. |
| Self-contained fragmented MP4 | In-file initialization and H.264/AAC fragments with a continuous audio timeline. Standalone `.m4s` without its initialization segment is not admitted. |
| Matroska (`.mkv`, `.mka`) | AV1 HDR10/TrueHD/ASS with the declared SDR output transform, and audio-only FLAC. |
| WebM (`.webm`, `.weba`) | VP9 with Opus in the packing matrix. The codec matrix also exercises VP8, AV1, and audio-only Opus/Vorbis. |
| MPEG transport streams (`.ts`, `.m2ts`, `.mts`) | H.264/AAC in 188-byte TS and H.264/AC-3 in 192-byte M2TS. The admitted path checks a single clear program, preserves the relative audio/video clocks, and refuses unhandled declared streams. |
| RIFF WAVE, RF64, AIFF/AIFC and CAF | WAVE float32, RF64 PCM, packed 24-bit AIFF, float32 AIFC and packed 24-bit CAF. The separate codec matrix includes other WAVE sample types. |
| Ogg Opus, native FLAC, MP3 and ADTS AAC | Ogg/Opus end trim, native FLAC, MP3 delay/end padding, and ADTS AAC-LC. |
| Local Blu-ray UDF `.iso` and BDMV folder | Choose a clear, single-angle H.264/AC-3 clip. The original `.m2ts` is read by extent and played as stored. No complete ISO extraction is required. |

MP4 is not a disc image. In the player, select a local ISO or use **Open Blu-ray folder**, then pick a clip. This does not implement DVD-Video, encrypted or remote images, Blu-ray menus, embedded Blu-ray PGS, or playlist splicing and cuts. Legacy AVI/ASF/FLV/MPEG-PS/MXF/NUT mappings are not advertised by this matrix. Native HLS URLs, multi-file adaptive manifests and transport discontinuities are separate scopes. [Mediabunny input formats](https://mediabunny.dev/guide/input-formats) · [VideoLAN libbluray](https://images.videolan.org/developers/libbluray.html) · [Apple CAF specification](https://developer.apple.com/library/archive/documentation/MusicAudio/Reference/CAFSpec/CAF_spec/CAF_spec.html)

## Large files

Source ranges are bounded by each read, not by a universal input size limit. The selected container and codecs still have to be admitted, and the device needs working decoders. Unknown-duration streams are not scanned from beginning to end just to populate the seek slider.

- MP4/MOV automatically chooses paged classic tables above 262,144 aggregate entries or 16 MiB of `moov` metadata. It supports clear audio/video tracks with a static sample description, exact signed composition offsets and the admitted contiguous edit. Fixed-size PCM is coalesced within proven chunk bounds. More complex edits, changing descriptions, unsupported sample groups and protected content still fail explicitly.
- Fragmented MP4 can exceed the old total sample cutoff because the expanded sample budget is per fragment. The initialization and compact lookup metadata still have separate bounds. This is not support for missing initialization segments or every fragment profile.
- The large-file browser screen opens two authored 96-minute timelines and plays their final half-second after a seek. It checks 13 submitted pictures and 24,000 PCM sample frames for AVC/AAC and 24,000 PCM sample frames for fragmented AAC. Separate screens exercise PCM MOV and four 10-bit AV1 pictures with oversized classic metadata. Node checks the same metadata route with HEVC, VP9 and ALAC packets, and verifies sparse MOV offsets beyond 4 GiB. These tests do not establish large-file throughput or device-wide support.

## Reproduce verification

```sh
npm run test:packing
npm run lab:build
npm run test:packing:browser
npm run test:packing:picker
node test/mp4-playback-browser.mjs
```

The browser matrix uses the actual HTTPS lab runner with a trusted loopback certificate. Set `UBVE_LAB_CERT` and `UBVE_LAB_KEY` as in the [lab runbook](device-lab.md). It checks local File and real HTTPS ranges, including Ready without autoplay, exact picture/PCM counts at EOS, paused seek, resume, close and reopen. ISO uses the File lane only. `UBVE_PACKING_TRANSPORT=file` or `range` selects one lane. The picker test exercises the production Vue view for both ISO and BDMV. `node test/disc-browser.mjs` separately compares the clip read from the ISO against the hash of independently authored folder bytes. Raw browser receipts remain under `.local/packing-browser/` and do not change the v8 release verdict.

To run the same set on a paired LAN device, start the lab with `--manifest test/fixtures/packing/manifest.json`, then use `npm run lab:run -- --device NAME --all --fold-down`. The master automatically chooses File for the ISO and ranges for the other fixtures. No per-job gestures are needed after browser enrollment.
