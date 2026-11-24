import test from 'node:test';
import assert from 'node:assert/strict';
import { byteRange, sessionStamp } from '../packages/core/dist/index.js';
import { HttpRangeSource, operationContext } from '../packages/io-demux/dist/index.js';
const op = () => operationContext(sessionStamp('http-test', 0), crypto.randomUUID(), undefined, 2500);
const mock = (hook = () => {}) => async (_url, init) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range), start = Number(match[1]), last = Number(match[2]);
  const response = { status: 206, headers: { ETag: '"immutable"', 'Content-Range': `bytes ${start}-${last}/100` } };
  hook(response, init, start); return new Response(Uint8Array.from({ length: last - start + 1 }, (_, n) => n + start), response);
};
test('strict HTTP source validates ranges and binds every read to its strong ETag', async () => {
  const source = await HttpRangeSource.open('https://example.test/media', op(), { fetch: mock((_response, init, start) => { if (start) assert.equal(init.headers['If-Match'], '"immutable"'); }) });
  const read = await source.readExact(byteRange(40, 45), op()); assert.deepEqual([...read.bytes.borrow()], [40, 41, 42, 43, 44]); read.bytes.release(); await source.close();
});
test('HTTP source refuses 200 fallbacks and weak validators', async () => {
  await assert.rejects(HttpRangeSource.open('https://example.test/media', op(), { fetch: mock(r => { r.status = 200; }) }), { code: 'UNSUPPORTED_CODEC' });
  await assert.rejects(HttpRangeSource.open('https://example.test/media', op(), { fetch: mock(r => { r.headers.ETag = 'W/"v1"'; }) }), { code: 'UNSUPPORTED_CODEC' });
});
test('HTTP identity changes invalidate further reads; wrong ranges are rejected', async () => {
  const source = await HttpRangeSource.open('https://example.test/media', op(), { fetch: mock((r, _init, start) => { if (start) r.headers.ETag = '"changed"'; }) });
  await assert.rejects(source.readExact(byteRange(3, 5), op()), { code: 'SOURCE_CHANGED' });
  await assert.rejects(source.readExact(byteRange(0, 1), op()), { code: 'DISPOSED' });
  const wrong = await HttpRangeSource.open('https://example.test/media', op(), { fetch: mock((r, _init, start) => { if (start) r.headers['Content-Range'] = 'bytes 9-10/100'; }) });
  await assert.rejects(wrong.readExact(byteRange(3, 5), op()), { code: 'INVALID_PACKET' }); await wrong.close();
});
test('HTTP transient retries are capped at three total attempts', async () => {
  let attempts = 0;
  const source = await HttpRangeSource.open('https://example.test/media', op(), { fetch: mock((r, _init, start) => { if (start) { attempts++; r.status = 503; } }) });
  await assert.rejects(source.readExact(byteRange(3, 5), op())); assert.equal(attempts, 3); await source.close();
});
test('source mutation aborts a concurrent fetch and close joins both operations', async () => {
  let pendingStarted, pendingAborted = false;
  const started = new Promise(resolve => { pendingStarted = resolve; });
  const fetcher = async (url, init) => {
    if (init.headers.Range === 'bytes=20-29') {
      pendingStarted();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => { pendingAborted = true; reject(init.signal.reason); }, { once: true }));
    }
    return mock((response, _options, start) => { if (start === 40) response.headers.ETag = '"mutated"'; })(url, init);
  };
  const source = await HttpRangeSource.open('https://example.test/media', op(), { fetch: fetcher });
  const inflight = source.readExact(byteRange(20, 30), op()), rejected = assert.rejects(inflight, { code: 'SOURCE_CHANGED' });
  await started;
  await assert.rejects(source.readExact(byteRange(40, 45), op()), { code: 'SOURCE_CHANGED' });
  const closed = source.close(); assert.equal(closed, source.close()); await Promise.all([rejected, closed]);
  assert.equal(pendingAborted, true); assert.equal(source.stats.activeReads, 0); assert.equal(source.ledger.snapshot().bytes, 0);
});

test('an immutable HTTP source accepts only a bounded whole-object 200, never a partial fallback', async () => {
  const request = async (_url, init) => init.headers['If-Match'] ?
    new Response(new Uint8Array(100), { status: 200, headers: { ETag: '"immutable"' } }) : mock()(_url, init);
  const source = await HttpRangeSource.open('https://example.test/media', op(), { fetch: request });
  await assert.rejects(source.readExact(byteRange(0, 99), op()), { code: 'HTTP_PROTOCOL' });
  const whole = await source.readExact(byteRange(0, 100), op()); assert.equal(whole.bytes.borrow().length, 100); whole.bytes.release();
  assert.notEqual(source.identity.revision, '"immutable"'); await source.close();
});

test('malformed responses are retired once, without retry, source mutation or secret diagnostics', async () => {
  const cases = [
    ['bad length', () => new Response(new Uint8Array(2), { status: 206, headers: { ETag: '"immutable"', 'Content-Range': 'bytes 3-4/100', 'Content-Length': '3' } }), 'INVALID_PACKET'],
    ['oversize', () => new Response(new Uint8Array(3), { status: 206, headers: { ETag: '"immutable"', 'Content-Range': 'bytes 3-4/100' } }), 'INVALID_PACKET'],
    ['short', () => new Response(new Uint8Array(1), { status: 206, headers: { ETag: '"immutable"', 'Content-Range': 'bytes 3-4/100' } }), 'INVALID_PACKET'],
    ['coded', () => new Response(new Uint8Array(2), { status: 206, headers: { ETag: '"immutable"', 'Content-Range': 'bytes 3-4/100', 'Content-Encoding': 'gzip' } }), 'INVALID_PACKET'],
    ['missing headers', () => new Response(new Uint8Array(2), { status: 206 }), 'INVALID_PACKET'],
    ['401', () => new Response('private authorization failure', { status: 401 }), 'HTTP_PROTOCOL'],
    ['416 unchanged', () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */100' } }), 'INVALID_PACKET'],
    ['browser-fetch failure', () => { throw new TypeError('secret-url-token'); }, 'NETWORK'],
  ];
  for (const [name, response, code] of cases) {
    let calls = 0;
    const fetcher = (url, init) => { calls++; return init.headers.Range === 'bytes=3-4' ? response() : mock()(url, init); };
    const source = await HttpRangeSource.open('https://example.test/media?secret-url-token', op(), { fetch: fetcher });
    await assert.rejects(source.readExact(byteRange(3, 5), op()), error => error.code === code && !JSON.stringify(error).includes('secret-url-token') && !error.message.includes('secret-url-token'), name);
    assert.equal(calls, 2, name); assert.equal(source.stats.activeReads, 0, name); assert.equal(source.ledger.snapshot().bytes, 0, name);
    const empty = await source.readExact(byteRange(100, 100), op()); empty.bytes.release(); await source.close();
  }
});

test('a 416 changed size invalidates even pages already retained by a cache', async () => {
  const { SourceCache } = await import('../packages/io-demux/dist/index.js');
  const source = await HttpRangeSource.open('https://example.test/media', op(), { fetch: (url, init) => init.headers.Range === 'bytes=16-31' ?
    new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */13' } }) : mock()(url, init) });
  const cache = new SourceCache(source, 64, 16);
  assert.deepEqual(await cache.readValue(0, 2, op(), data => [...data]), [0, 1]);
  await assert.rejects(cache.readOwned(20, 25, op()), { code: 'SOURCE_CHANGED' });
  await assert.rejects(cache.readOwned(0, 2, op()), { code: 'SOURCE_CHANGED' });
  await cache.close(); assert.equal(source.ledger.snapshot().bytes, 0);
});

test('real HTTP Fetch follows the probe redirect, pins the final representation, then checks exact ranges above 4 GiB', async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const size = 2 ** 32 + 21, calls = [];
  const server = createServer((request, response) => {
    calls.push([request.url, request.headers.range, request.headers['if-match'] ?? null]);
    if (request.url === '/entry') { response.writeHead(302, { Location: '/media' }); response.end(); return; }
    const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
    const start = Number(lo), last = Number(hi);
    const bytes = Uint8Array.from({ length: last - start + 1 }, (_, n) => (start + n) % 251);
    response.writeHead(206, { ETag: '"immutable"', 'Content-Range': `bytes ${start}-${last}/${size}`, 'Content-Length': bytes.length, 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Encoding' });
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const source = await HttpRangeSource.open(`http://127.0.0.1:${server.address().port}/entry`, op());
  assert.equal(source.size, size);
  const read = await source.readExact(byteRange(size - 3, size), op());
  assert.deepEqual([...read.bytes.borrow()], [size - 3, size - 2, size - 1].map(v => v % 251)); read.bytes.release();
  const empty = await source.readExact(byteRange(size, size), op()); empty.bytes.release();
  assert.deepEqual(calls, [['/entry', 'bytes=0-0', null], ['/media', 'bytes=0-0', null], ['/media', `bytes=${size - 3}-${size - 1}`, '"immutable"']]);
  await source.close();
});
