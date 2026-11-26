# Authored paged MP4 seeds

`paged-mp4-seed.mp4` is generated black video and mono silence. SHA-256
`951137beee59873f2c95f2e16def9596e2d46717eb415fc3a77532dc19b8db65`.

```sh
ffmpeg -f lavfi -i 'color=c=black:s=32x24:r=25' \
  -f lavfi -i 'anullsrc=r=48000:cl=mono' -t 0.64 \
  -c:v libx264 -pix_fmt yuv420p -preset medium -threads:v 1 \
  -g 16 -keyint_min 16 -sc_threshold 0 -bf 2 \
  -x264-params 'colorprim=bt709:transfer=bt709:colormatrix=bt709' \
  -bsf:v 'filter_units=remove_types=6' \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:a aac -b:a 32k -map_metadata -1 \
  -movflags '+faststart+negative_cts_offsets+write_colr' paged-mp4-seed.mp4
ffprobe -v error -show_streams -show_packets -show_data_hash sha256 -of json paged-mp4-seed.mp4
```

The checked seed and packet positions use FFmpeg/FFprobe 9.1. The I10 generator
repeats a complete closed AVC GOP and AAC payload into independently framed
classic and fragmented ISO files. FFprobe reports a 5,760 s duration for
each generated file, with 144,000 AVC pictures and 270,001 AAC packets in the
classic file. The sparse PCM case uses generated linear samples and a fixed
size table. Repeated encoded content and sparse address checks are not
endurance or complex-scene performance evidence.

`paged-av1-seed.mp4` is four black 10-bit AV1 pictures with BT.709 signaling.
SHA-256 `a4677a2b10e0a5349eae386918abc525ce158a7e1c544b9418a521292dc3b8d9`.

```sh
ffmpeg -f lavfi -i 'color=c=black:s=32x24:r=25' -frames:v 4 -an \
  -c:v libaom-av1 -cpu-used 8 -crf 40 -g 4 -threads:v 1 -row-mt 0 -pix_fmt yuv420p10le \
  -bsf:v 'av1_metadata=color_primaries=1:transfer_characteristics=1:matrix_coefficients=1:color_range=tv' \
  -movflags '+faststart+write_colr' paged-av1-seed.mp4
```

The metadata-size regression adds a framed free box without moving the
encoded payload. It is an oversized-metadata input, not a long AV1 movie.
