# Command reference

Run commands at the repository root with Node **24.22.3** and npm **11.19.1**. The committed lockfile pins TypeScript and the media providers. Use `npm ci --ignore-scripts`. Keep builds/tests out of an actual reserved performance run.

| Command | Scope |
| --- | --- |
| `npm test` | Strict core, package, worklet and Vue type checks, AST import boundaries, Node correctness tests and the Python qualification/failure-ledger tests. |
| `npm run test:io` / `npm run test:http` | Local exact source and selected-packet checks, or strict HTTP source checks including actual loopback Fetch. |
| `npm run test:codecs` | Real pinned AV1/TrueHD workers on Node with exact plane/PCM/HDR reference and lifecycle checks. No browser presentation measurements. |
| `npm run test:native:wasm` | Real pinned TrueHD/FLAC workers and bounded fMP4 bridge. `UBVE_REQUIRE_FFMPEG_EVIDENCE=1` requires native FFmpeg cross-checks as test preparation, not browser-native evidence. |
| `npm run test:disc` | Disc/title/range correctness against actual pinned UDF WASM and authored fixtures. |
| `npm run build` | Compile packages and build self-hosted assets and both Vue documents. |
| `npm run check:assets` / `npm run check:static` | Verify built media-provider hashes or the complete static output's two entry documents, headers and packaging. |
| `npm run audit:assets` | Inspect dependency notices and emitted asset/source provenance. The report is not a distribution approval. |
| `npm run support:generate` / `npm run release:check` | Derive status with the pinned evaluator. The release command fails if the deployment condition is unmet. |

## Browser evidence

Install a compatible Playwright Chromium, then run `npm run build` and the applicable lane. On an environment with an alternate compatible executable, set `UBVE_CHROMIUM` to its path. The repository does not install alternate browser packages into the player.

- `npm run test:presentation:browser` checks the real audio graph and selected subtitle timing/rendering.
- `npm run test:pipeline:browser` checks all selected tracks on the committed short compound fixture; [screening options](I06-browser-screening.md) cover generated multi-resolution cases and evidence collection.
- `npm run test:native:browser` checks the short MSE candidate against actual MIME admission and records dropped frames, subtitle-forward counts and lifecycle. It does not measure physical output.
- `node test/disc-browser.mjs` checks real browser worker/Blob range access and the exact authored title/UDF hashes, not playback.

A short browser test may fail or pass independently of the strict release verdict. Retain failed attempts, use a clean matching build and do not substitute a component result for measured sustained presentation.
