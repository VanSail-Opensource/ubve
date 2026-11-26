# HDR10-compatible playback from Dolby Vision files

In **Automatic**, a readable local MP4 with a single unambiguous Dolby Vision
video track can use native direct playback when the browser advertises the
exact Dolby Vision codec tuple and the selected tracks fit the native route.
The original encoded file is passed unchanged. The probe does not establish
that the display renders Dolby Vision. Automatic/native opaque URLs still
belong to the browser. For software fallback with a readable remote source,
select **Managed** and use a server that supports the existing strict range
and validator contract.

For **Profile 8.1** and the supported **single-video-track Profile 7** mappings
in MP4 and MKV, the software fallback keeps the HDR10-compatible HEVC base
layer. It does not decode Dolby Vision dynamic metadata or composite an
enhancement layer. The reader validates the declaration, HEVC Main 10
configuration, NAL lengths and layer headers. It strips RPU and, where
applicable, enhancement data from the selected access units while retaining
base-layer parameter sets, static SEI, packet timing and original spans where
available. The decoder must confirm limited-range 10-bit BT.2020 PQ. A
generic HEVC tag alone does not authorize a Dolby Vision transformation.

**Profile 10.1** uses a single AV1 picture layer in MKV and MP4. Its declared
HDR10 compatibility must agree with the actual decoded 10-bit limited-range
BT.2020 PQ output. The software route decodes the original AV1 access units
and does not apply the Dolby Vision metadata in their ITU-T T.35 messages.
The proprietary Profile 10.0 and HLG Profile 10.4 do not become HDR10.
[Dolby Vision bitstream profiles](https://ott.dolby.com/OnDelKits/Dolby_Vision_Online_Delivery_Kit/v1/Documentation/Specs/Visio_Profiles/help_files/topics/c_dovi_profiles_public.html) · [Matroska block-addition mappings](https://www.matroska.org/technical/block_additional_mappings.html)

Choose **Performance** for explicitly tone-mapped SDR. For the HDR candidate,
choose **Full** and enable **Try WebGPU presentation** before opening. It
requires admitted frame metadata and a browser that retains an extended
`rgba16float` Display P3 linear canvas. No automatic HDR-to-SDR downgrade is
performed under Full. Profile 5, other unverified compatibility IDs,
ambiguous video-track mappings, and unsupported per-block additions,
encryption or edits remain outside the fallback. No installed decoder or
server-side processing is required. [WebGPU canvas color spaces](https://developer.chrome.com/blog/new-in-webgpu-155-156)

## Verification

After the ordinary build, `node test/dolby-base-browser.mjs` uses generated
Matroska metadata around independently checked HEVC and AV1 picture sequences.
Synthetic declarations and RPU/EL bytes are carriage tests only. The unit tests
also verify exact MKV cue offsets beyond 4 GiB on a sparse source and preserve
the original selected MKV payload spans through filtering.

The real-sample checks use the locked Jellyfin Profile 8.1 and Profile 5 MP4s
and FFmpeg FATE's Profile 7 MKV and MP4, without redistributing those clips in the
app. The short P8.1 input is cut with FFmpeg 9.1 using `-t 0.8` and
`-c:v copy -strict unofficial` to retain the Dolby configuration. The same payload is
remuxed to Matroska. Independent native references filter NAL types 62/63
and decode planar 10-bit frames with FFmpeg. The software component probe
compares those SHA-256 hashes before browser playback. The genuine Profile 5
file is refused when native support is unavailable.
[Jellyfin fixture lock](../test/fixtures/jellyfin-corpus.json) · [FFmpeg FATE Profile 7 MKV](https://fate-suite.ffmpeg.org/mkv/dovi-p7-hvce.mkv) · [FFmpeg FATE Profile 7 MP4](https://fate-suite.ffmpeg.org/mov/dovi-p7-hvce.mp4)

For Profile 10.1, FFmpeg 9.1 with `libsvtav1 -dolbyvision 1` encoded a short
640×360 excerpt with actual Dolby metadata from the locked Profile 8.1 input.
FFprobe confirmed the AV1 profile, HDR10 compatibility ID and frame-side
metadata. All 18 planar picture hashes matched native libdav1d in both the
MKV and MP4 remux, without redistributing either clip.

The short P8.1 MP4 contains a B-picture after its `mdhd` duration but inside
its `elst` presentation interval. The managed clock now uses the mapped
movie edit. On the same MP4, the base-layer browser check reached EOS with
all 50 pictures. MP4 frame timing from the provider is still labeled as
API seconds, not original container DTS.

The WebGPU command reads pixels from the actual canvas textures and compares
them against an independent numerical reference built from D65 primaries.
It covers padded planes, odd crops, chroma siting, SDR, PQ-to-SDR downscaling
and unclamped linear-P3 HDR values. A numerical readback and a short browser
screen do not measure physical display luminance, HDR signaling, or sustained
cadence. The recorded screen used Chromium 158 on Windows with a non-fallback
NVIDIA Lovelace adapter. Its maximum channel error was below 0.0043 for the
extended linear output and 0.0020 in the two normalized 8-bit output cases.
The screen does not qualify iPad or another device.
