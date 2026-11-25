# Native VP9/Opus fixture

This 43,365-byte WebM is a stream-copy subset of the existing synthetic `vp9-opus-ass.mkv` fixture. The VP9 picture is 128×72. No subtitle or attachment is selected. CI reads the pinned bytes directly and does not need FFmpeg to execute the UI smoke test.

SHA-256 `ed6464c20dcec96e0f1aa6be8baa194b2f7688616b53752e304957fcdbfaeaa2`.

```sh
ffmpeg -nostdin -loglevel error -i test/fixtures/vp9-opus-ass.mkv \
  -map 0:v:0 -map 0:a:0 -c copy -map_metadata -1 -fflags +bitexact \
  test/fixtures/native-vp9-opus.webm
```

The pinned file was made with FFmpeg 7.1.5. Container byte layout may change across versions. The test is native browser behavior, not acceleration, cadence or physical-output evidence.
