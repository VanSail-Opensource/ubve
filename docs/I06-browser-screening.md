# I06 short browser screening

This is a real Chromium integration regression, not an I06 strict gate verdict. The configured route is managed AV1 dav1d + TrueHD + streamed ASS with an explicitly reduced SDR canvas and muted stereo-folded real-time output. The runner verifies source dimensions and track identities, correct frame totals through decoder and Canvas submission, PCM sample-clock EOS, loaded subtitle events/font, paused seek, reopen session replacement and output disposal. Canvas submissions are not per-picture on-time scanout. Loaded subtitle events do not prove their pixels against a reference. EOS counters do not certify zero misses or audible output.

```sh
npm ci --ignore-scripts
npm run build
npx playwright install --with-deps chromium
npm run test:pipeline:browser
```

GitHub Actions is the browser fallback for hosts that cannot launch Chromium. The retained first hosted record proves component execution and a failed combined run. Neither a hosted Linux pass nor a native API probe qualifies Windows, macOS, iOS, iPadOS, Android, GPU or physical output. Do not reinterpret the earlier local browser startup blocker as a pipeline result.

For a compatible Linux x64 host, `UBVE_CHROMIUM` accepts a path to a different executable. The npm-distributed `@sparticuz/chromium@158.0.0` headless binary ran the real worker, WASM, Canvas and AudioWorklet paths when the system Chromium could not start. Its `package/bin/chromium.br` can be extracted from `npm pack --ignore-scripts @sparticuz/chromium@158.0.0` and decompressed with Node's `createBrotliDecompress`. The observed launch wrapper passed `--disable-gpu-compositing --disable-software-rasterizer --use-gl=disabled --in-process-gpu --disable-dev-shm-usage` before Playwright's arguments. This is a CPU browser smoke path, not a browser dependency or an endpoint qualification.

The optional generated 120 Hz case works without a separate media archive. This uses FFmpeg/FFprobe with the SVT-AV1 encoder for setup, never for the measured browser decode. Each generation records the actual toolchain and fixture hash. Source uniqueness, 120 Hz timing, AV1 mastering/CLL metadata, 19,200 decoded TrueHD sample frames and three ASS cues are independently checked before the browser run.

```sh
python3 test/create-720p120-fixture.py --out .local/720p120
UBVE_PIPELINE_MANIFEST=.local/720p120/manifest.json \
UBVE_PIPELINE_MEDIA_ROOT=.local/720p120 \
npm run test:pipeline:browser
```

The same generator accepts `--size` and `--fps` to build a small source-validity cohort from 720p to 4K without downloading the v8 media archive. Run the generator serially because each case appends its verified identity to the same manifest.

```sh
for dimensions in 1280x720 1920x1080 2560x1440 3840x2160; do
  for cadence in 60 120; do
    python3 test/create-720p120-fixture.py --size "$dimensions" --fps "$cadence" --out .local/generated-cohort || exit 1
  done
done
UBVE_PIPELINE_MANIFEST=.local/generated-cohort/manifest.json \
UBVE_PIPELINE_MEDIA_ROOT=.local/generated-cohort \
npm run test:pipeline:browser
```

The generated marker content intentionally compresses easily. Its manifest keeps actual video packet bitrate separate from the compound bitrate. It does not replace high-complexity encodes or a varied-bitrate workload.

To screen the supplied v8 compound cohort without bundling the media files in the repository, unpack its original combined fixtures and run:

```sh
UBVE_PIPELINE_MANIFEST=test/fixtures/primary/v8-combined-cohort.json \
UBVE_PIPELINE_MEDIA_ROOT=/abs/path/to/bench-v8/fixtures/combined \
UBVE_PIPELINE_OUTPUT=/abs/path/to/screening-output \
npm run test:pipeline:browser
```

Each case opens a fresh browser page and is executed serially. Missing or incorrect fixture bytes are retained as bounded failures without substituting another fixture. This manifest binds four resolutions at true 60/1 and 120/1 source cadence to exact hashes. The files contain only 48 source pictures apiece and cover one nominal encode target. The manifest includes each file's actual measured video mean bitrate. It does not establish sustained playback, a bitrate sweep, an equivalent-quality transform or all five physical OS endpoints.
