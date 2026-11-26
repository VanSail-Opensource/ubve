# Packing fixtures

The content is authored or repacked from existing synthetic repository fixtures. The manifest locks the actual file bytes, detected format and selected stream reference. The normal tests require neither FFmpeg nor tsMuxeR.

The new video and AAC files use `test/fixtures/modern/avc-aac.mp4` as the source. With the FFmpeg build named in `manifest.json`, these are the format-specific output arguments after input selection.

| Outputs | FFmpeg args |
| --- | --- |
| `compound.mov`, `compound.3gp`, `compound.3g2` | `-c copy`. Set `-f 3gp` or `-f 3g2` for the mobile files. |
| `frag-negative_cts_offsets.mp4` | `-c copy -movflags +frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets` |
| `sample.ts` | `-c copy -f mpegts` |
| `compound-ac3.m2ts` | Use `compound.mov` as input and set `-c:v copy -ar 48000 -c:a ac3 -b:a 192k -mpegts_m2ts_mode 1 -f mpegts`. |
| `sample.aac` | `-map 0:a:0 -c copy -f adts` |
| `sample.aiff`, `float.aifc`, `sample.caf`, `sample.rf64.wav` | Map audio at 48 kHz. Encode `pcm_s24be` for AIFF, then make `float.aifc` from AIFF using `pcm_f32be -f aiff`. Encode `pcm_s24le` for CAF and RF64. Use `-rf64 always` for RF64. |

`vp9-opus.webm` stream-copies picture data from `modern/vp9-profile0.webm` and audio from `modern/opus-webm.webm`. `flac.mka` copies `modern/flac-24.mkv` with the new audio-only package. The non-copied fixtures refer directly to the original locks.

The Blu-ray fixture uses FFmpeg `smptebars=size=1280x720:rate=24`, 1.5 seconds of progressive `yuv420p`, `libx264` at level 4.1, and a closed 12-picture GOP. The source is encoded with `bluray-compat=1:open-gop=0` and the `h264_metadata` filter explicitly specifies limited-range BT.709 primaries, transfer, and matrix. The audio is `sine=frequency=523.25:sample_rate=48000:duration=1.5`, stereo AC-3 at 192 kbps. tsMuxeR 2.7.0 uses `MUXOPT --blu-ray --vbr` with `V_MPEG4/ISO/AVC` at `fps=24` and `A_AC3`. It writes both the `.iso` and an independent folder. The ISO hash is tied to the checked-in image since filesystem timestamps can differ on re-authoring. The `.m2ts` read from the ISO must match `clipSha256` from the separately authored folder. [FFmpeg formats](https://ffmpeg.org/ffmpeg-formats.html) · [tsMuxeR 2.7.0](https://github.com/justdan96/tsMuxer/releases/tag/2.7.0)

The reference uses `ffprobe -count_frames` and FFmpeg scalar normalized float32 PCM. QuickTime and classic mobile MP4 audio are compared to the declared 56,448 audible samples after the AAC edit. The browser checks delivery counts rather than physical video or speaker output.
