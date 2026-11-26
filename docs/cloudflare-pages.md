# Cloudflare Pages release target

The deployment target is the static Vite output at `apps/vue-player/dist`. It contains no backend, Pages Functions or file upload path. Build from the pinned Node/npm environment at the repository root.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run release:check
```

The static audit validates both HTML entries, document-specific isolation, self-hosted assets against the generated hash manifest, cache policies and the public support report. A passing artifact may be published to the Pages production hostname as an implementation candidate. The distribution inventory is still run in CI and its open findings remain recorded.

FPS targets and sustained playback trials are evidence for performance claims, not a deployment prerequisite. `npm run support:generate` uses the unchanged v8 evaluator to report results. The support report's `releaseReady` field describes exact playback qualification, not whether the static site can be published. The Pages project uses manual Direct Upload, with `main` for production and `candidate` for previews.

| Document | Expected response | Playback use |
| --- | --- | --- |
| `/` | No COOP/COEP isolation headers | Standard browser path. No shared-memory codec route is assumed. |
| `/isolated/` | `COOP: same-origin` and `COEP: require-corp` | Required for candidates that need `crossOriginIsolated` and shared memory. Reopen selected local media after changing documents. |
| `/assets/*` | Immutable cache for content-hashed bundles | Bundled Vue app and shared chunks. |
| `/vendor/*` | Revalidate provider assets | Same-origin pinned worker/WASM/font assets. |

Publish the exact audited directory to the intended Pages project. Verify the two live document responses, successful same-origin worker/WASM loads, support report equality and 404 handling for a missing asset. Record the deployment URL/ID, exact Git commit and built asset manifest. A Pages URL does not widen format, device or display qualification.

Self-hosted worker asset responses also carry `COEP: require-corp`. It is required by the isolated player, including the ASS and nested codec workers. The standard document itself remains non-isolated.

Cloudflare configuration references: [response headers](https://developers.cloudflare.com/pages/configuration/headers/) and [static serving](https://developers.cloudflare.com/pages/configuration/serving-pages/).
