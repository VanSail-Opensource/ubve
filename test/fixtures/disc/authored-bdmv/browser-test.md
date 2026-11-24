# Browser worker regression

The normal command is `node test/disc-browser.mjs` after `npm run build:packages`
and the usual Playwright Chromium installation. The test opens the fixture Blob
assets via real dedicated workers and checks exact clock and file content.

The retained Linux run used the standalone headless shell from the npm package
`@sparticuz/chromium@158.0.0` because system Chromium could not create its
singleton socket and the Playwright browser download returned HTTP 403.

| Artifact | SHA-256 |
| --- | --- |
| `sparticuz-chromium-158.0.0.tgz` | `216d1badc4df6595fd12a5fc4553f78e041a5c24eee313a251d35b63a1737ed4` |
| Decompressed Linux x86_64 browser executable | `1f698044a68e18c1ce0cce74be25413f176806f19f15a44de5bb02cd578996af` |

Retrieve the pinned tarball with `npm pack @sparticuz/chromium@158.0.0`, extract
`package/bin/chromium.br`, and decompress with Node's `createBrotliDecompress` or
an installed Brotli tool. Mark the executable runnable. If needed for the test
host, point `UBVE_CHROMIUM` at a shell wrapper that executes the resulting
binary with these flags and forwards `"$@"` unchanged:

```text
--disable-gpu-compositing --disable-software-rasterizer --use-gl=disabled
--in-process-gpu --disable-dev-shm-usage
```

Playwright supplies the remote debugging pipe. This is browser execution of
source access and title metadata, not decode, throughput or physical playback.
