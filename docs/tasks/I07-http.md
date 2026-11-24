# I07 — Exact HTTP range source

**Status:** pending; no current HTTP/CDN qualification. **Dependency:** I02. **Owner:** I/O agent. **Owned paths:** `packages/io-demux` HTTP adapter, deterministic local HTTP/CORS server and fixtures. No production backend/proxy.

## Contract and state

Implement RandomAccessSource over Fetch with checked known size, stable source identity/revision and exact half-open read delivery. Use one shared source cache and at most2 concurrent range requests; a separately admitted bounded remote cache (the retained16/32MiB values are initial proposals, not universal v8 limits). Convert `[start,end)` to `Range: bytes=start-(end-1)` only for nonempty reads. Never issue an underflowed end for a zero-byte request.

Establish known size and stable revision through validated range/metadata responses. Prefer a strong ETag with If-Match or a correctly validated equivalent; a Last-Modified/size observation alone is not a cryptographic immutable identity. The initial exact HTTP profile requires a usable stable revision validator; otherwise reject with a documented unsupported-source reason. A caller can open a new session after mutation; the adapter must not stitch old/new bytes.

Validate status, Content-Range bounds/total, content encoding, Content-Length when available, expected body length and exposed validators before delivering. Cancel excess body bytes and reject truncated/oversized/misaligned206.416 at a requested range inconsistent with admitted size means source changed or invalid range; it never becomes empty success for an in-range read. Auth/CORS/error HTML is not media data.

A200 response to a range request is not automatically a correct slice. Initial policy accepts200 only when requesting the entire known source and that source fits the admitted cache/body cap; otherwise cancel and fail `E_RANGE_REQUIRED`. Do not silently buffer a movie because the server ignored Range. Require headers exposed by CORS; no proxy or URL rewrite workaround.

## v8 source demand

Coordinate AV1, TrueHD and required subtitle reads through the same selected-track owner. Peak bitrate windows, largest admitted packets and index expansion determine resource pressure independently of file extension or average rate. Backpressure reaches the source; no whole-file prefetch or enlarged hidden cache can turn component timing into streaming qualification. Preserve metadata/configuration epochs through source recovery.

## Retry, cancellation and privacy

Use original operation deadline plus header10s/complete attempt30s watchdogs, at most3 transient transport/5xx attempts with delays0,200,800ms. Respect Retry-After only within that total bound and record the decision; no unbounded extension. Do not retry authentication/CORS/malformed/truncated-success/source-change as identical requests. Abort underlying Fetch where supported; reject delivery upon observed cancellation and keep owned accounting until body/worker work settles. Recheck deadline on completion even if timer was delayed.

Redact URL query credentials, headers, cookies and private filenames from logs. Store a stable opaque source ID and non-secret origin/status/range metadata. Credentials policy is explicit; never turn on include because a request failed.

## Fixtures

Deterministic server cases: exact 206, ranges near EOF/>4GiB virtual offset, zero length, ignored Range 200 small/large, wrong total/start/end, compressed response, chunked truncation, extra bytes, 416, ETag change between reads, weak/no validator, authentication, redirects with allowed/forbidden origin behavior, CORS missing exposed header, cancellation while body stalls, delayed callback completion and bounded retry exhaustion. Virtual offsets are protocol arithmetic evidence, not huge real media.

## Verification and exits

**Existing:** check/build/unit after integration. **TO CREATE:** `npm run test:http` running actual Fetch/browser/CORS tests with the deterministic server. I06 later qualifies a real streaming profile, with environment/network policy saved.

Success: bounded exact bytes, stable identity, one cache, finite retry/cancel behavior and no secret diagnostics. Failures map to SOURCE_CHANGED, RANGE_OUTSIDE_SOURCE, DEADLINE_EXCEEDED or precise unsupported/invalid/runtime reasons without whole-file fallback. Source.close cancels/settles readers and releases cache ownership.

**Next:** optional HTTP support in I12; remote ISO remains disabled even after this adapter passes.
