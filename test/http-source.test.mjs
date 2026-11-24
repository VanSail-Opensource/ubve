import test from 'node:test';
import assert from 'node:assert/strict';
import { byteRange, sessionStamp } from '../packages/core/dist/index.js';
import { HttpRangeSource, operationContext } from '../packages/io-demux/dist/index.js';
const op = () => operationContext(sessionStamp('http-test', 0), crypto.randomUUID(), undefined, 1000);
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
