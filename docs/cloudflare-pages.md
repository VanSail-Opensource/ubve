# Cloudflare Pages release target

The deployment target is the static Vite output at `apps/vue-player/dist`. It contains no backend, Pages Functions or file upload path. Build from the pinned Node/npm environment at the repository root.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run check:static
npm run release:check
```

The static audit validates both HTML entries, document-specific isolation, self-hosted assets against the generated hash manifest, cache policies and the public support report. **A successful static audit is not release qualification.** Production deployment is conditional on the strict evidence verdict, completion of the claimed phase exits and the distributed-source/license audit. An unqualified checkout must not trigger a production deployment. Do not configure an automatic release-on-push integration before these conditions hold.

| Document | Expected response | Playback use |
| --- | --- | --- |
| `/` | No COOP/COEP isolation headers | Standard browser path. No shared-memory codec route is assumed. |
| `/isolated/` | `COOP: same-origin` and `COEP: require-corp` | Required for candidates that need `crossOriginIsolated` and shared memory. Reopen selected local media after changing documents. |
| `/assets/*` | Immutable cache for content-hashed bundles | Bundled Vue app and shared chunks. |
| `/vendor/*` | Revalidate provider assets | Same-origin pinned worker/WASM/font assets. |

After a release is eligible, publish the exact audited directory to the intended Pages project. Verify the two live document responses, successful same-origin worker/WASM loads, support report equality and 404 handling for a missing asset. Record the deployment URL/ID, exact Git commit and built asset manifest. A chosen Pages URL does not widen format, device or display qualification.

Self-hosted worker asset responses also carry `COEP: require-corp`. It is required by the isolated player, including the ASS and nested codec workers. The standard document itself remains non-isolated.

Cloudflare configuration references: [response headers](https://developers.cloudflare.com/pages/configuration/headers/) and [static serving](https://developers.cloudflare.com/pages/configuration/serving-pages/).
