import { EngineError, byteLength, sourceIdentity, type ByteRange, type OperationContext } from '@ubve/core';
import { BoundedSource, type SourceOptions } from './source.js';
import { withOperation } from './operations.js';

export interface HttpSourceOptions extends SourceOptions { readonly credentials?: RequestCredentials; readonly fetch?: typeof fetch; }

const RETRY_DELAYS = [0, 200, 800] as const;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 5_000;
const HEADERS_MS = 10_000, ATTEMPT_MS = 30_000;
function strongTag(value: string | null): value is string { return value !== null && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value); }

export function parseContentRange(value: string | null): { start: number; end: number; size: number } {
  const match = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/i.exec(value ?? '');
  if (!match) throw new EngineError('INVALID_PACKET', 'A readable exact Content-Range header is required');
  const values = match.slice(1).map(BigInt);
  if (values.some(n => n > BigInt(Number.MAX_SAFE_INTEGER))) throw new EngineError('ITEM_TOO_LARGE', 'HTTP range exceeds exact address space');
  const [start, last, size] = values.map(Number) as [number, number, number];
  if (last < start || last >= size) throw new EngineError('INVALID_PACKET', 'Invalid HTTP Content-Range extent');
  return { start, end: last + 1, size };
}
function validateHeaders(response: Response, expected: number): void {
  const encoding = response.headers.get('Content-Encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new EngineError('INVALID_PACKET', 'HTTP range uses unsupported content coding');
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d{1,16}$/.test(length) || Number(length) !== expected)) throw new EngineError('INVALID_PACKET', 'HTTP Content-Length does not match the exact requested range');
}
async function cancelBody(response: Response): Promise<void> { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}); }
async function readBounded(response: Response, expected: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new EngineError('INVALID_PACKET', 'HTTP source has no body');
  validateHeaders(response, expected);
  const reader = response.body.getReader(), bytes = new Uint8Array(expected); let offset = 0;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read(); if (next.done) break;
      if (offset + next.value.length > expected) throw new EngineError('INVALID_PACKET', 'HTTP body exceeds declared range');
      bytes.set(next.value, offset); offset += next.value.length;
    }
    if (signal.aborted) throw signal.reason;
    if (offset !== expected) throw new EngineError('INVALID_PACKET', 'HTTP source returned a short range body');
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) throw signal.reason;
    if (error instanceof EngineError) throw error;
    // Headers already signalled a successful body. Do not retry a malformed/truncated 206.
    throw new EngineError('INVALID_PACKET', 'HTTP range body could not be read to completion');
  } finally { signal.removeEventListener('abort', stop); reader.releaseLock(); }
}
function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (ms === 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    const stop = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
function timeout(controller: AbortController, ms: number, message: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => controller.abort(new EngineError('DEADLINE_EXCEEDED', message)), ms);
}
function transientTransport(error: unknown): boolean {
  // The Fetch Standard deliberately hides CORS, redirect and transport failures
  // behind the same browser TypeError. Retry only an explicitly identified fault.
  const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return cause !== undefined && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause);
}
async function request<T>(url: string, init: RequestInit, fetcher: typeof fetch, outer: AbortSignal, use: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
  let retryAfter = 0, lastError: EngineError | null = null;
  for (const backoff of RETRY_DELAYS) {
    // Do not ignore a server's minimum delay merely to force another attempt.
    if (retryAfter > MAX_RETRY_WAIT_MS) break;
    await delay(Math.max(backoff, retryAfter), outer);
    const controller = new AbortController(), signal = AbortSignal.any([outer, controller.signal]);
    const attemptStarted = performance.now();
    const headers = timeout(controller, HEADERS_MS, 'HTTP range response headers timed out');
    const entire = timeout(controller, ATTEMPT_MS, 'HTTP range attempt timed out');
    let response: Response | undefined;
    try {
      response = await fetcher(url, { ...init, signal });
      clearTimeout(headers);
      if (performance.now() - attemptStarted >= HEADERS_MS && !signal.aborted) controller.abort(new EngineError('DEADLINE_EXCEEDED', 'HTTP range response headers timed out'));
      if (signal.aborted) throw signal.reason;
      if (TRANSIENT_STATUS.has(response.status)) {
        retryAfter = retryAfterMs(response.headers.get('Retry-After'));
        lastError = new EngineError('NETWORK', 'Transient HTTP source response', 'none', { status: response.status });
        continue;
      }
      const value = await use(response, signal);
      if (signal.aborted) throw signal.reason;
      if (performance.now() - attemptStarted >= ATTEMPT_MS) throw new EngineError('DEADLINE_EXCEEDED', 'HTTP range attempt timed out');
      return value;
    } catch (error) {
      if (outer.aborted) throw outer.reason;
      if (controller.signal.aborted) { lastError = controller.signal.reason as EngineError; retryAfter = 0; continue; }
      if (error instanceof EngineError) throw error;
      // Never surface fetch URL, error cause, request headers or credentials.
      const fault = new EngineError('NETWORK', 'HTTP source request failed (transport, CORS or redirect)');
      if (response || !transientTransport(error)) throw fault;
      lastError = fault; retryAfter = 0;
    } finally {
      clearTimeout(headers); clearTimeout(entire);
      if (response) await cancelBody(response);
    }
  }
  throw lastError ?? new EngineError('NETWORK', 'HTTP source exhausted its bounded retry policy');
}

/** Strict immutable HTTP representation: CORS-readable strong ETag and checked ranges. */
export class HttpRangeSource extends BoundedSource {
  readonly identity;
  readonly size;
  readonly #url: string;
  readonly #etag: string;
  readonly #fetch: typeof fetch;
  readonly #credentials: RequestCredentials;
  private constructor(url: string, size: number, etag: string, options: HttpSourceOptions) {
    super({ ...options, maxConcurrentReads: Math.min(2, options.maxConcurrentReads ?? 2) });
    this.#url = url; this.size = byteLength(size); this.#etag = etag;
    this.#fetch = options.fetch ?? fetch; this.#credentials = options.credentials ?? 'omit';
    const id = crypto.randomUUID();
    this.identity = sourceIdentity(id, `validated-http-representation:${id}`);
  }
  static async open(url: string, operation: OperationContext, options: HttpSourceOptions = {}): Promise<HttpRangeSource> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new EngineError('INVALID_ARGUMENT', 'Use a valid HTTP(S) media URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new EngineError('INVALID_ARGUMENT', 'Use an HTTP(S) media URL without embedded credentials');
    return withOperation(operation, outer => request(parsed.href, { headers: { Range: 'bytes=0-0' }, credentials: options.credentials ?? 'omit', mode: 'cors', redirect: 'follow', cache: 'no-store' }, options.fetch ?? fetch, outer, async (response, signal) => {
      if (response.status !== 206) throw new EngineError('UNSUPPORTED_CODEC', 'Strict remote input requires an exact 206 probe', 'caller-fix', { status: response.status });
      const etag = response.headers.get('ETag');
      if (!strongTag(etag)) throw new EngineError('UNSUPPORTED_CODEC', 'Strict remote input requires a CORS-exposed strong ETag', 'caller-fix');
      const range = parseContentRange(response.headers.get('Content-Range'));
      if (range.start !== 0 || range.end !== 1) throw new EngineError('INVALID_PACKET', 'Initial HTTP probe returned the wrong range');
      const finalUrl = new URL(response.url || parsed.href);
      if (!['https:', 'http:'].includes(finalUrl.protocol) || (parsed.protocol === 'https:' && finalUrl.protocol !== 'https:') || finalUrl.username || finalUrl.password) throw new EngineError('HTTP_PROTOCOL', 'HTTP probe reached an inadmissible redirect target');
      await readBounded(response, 1, signal);
      return new HttpRangeSource(finalUrl.href, range.size, etag, options);
    }));
  }
  protected async load(range: ByteRange, outer: AbortSignal): Promise<Uint8Array> {
    const changed = (message: string): never => { const error = new EngineError('SOURCE_CHANGED', message, 'new-session'); this.invalidate(error); throw error; };
    return request(this.#url, {
      headers: { Range: `bytes=${range.start}-${range.end - 1}`, 'If-Match': this.#etag },
      credentials: this.#credentials, mode: 'cors', redirect: 'error', cache: 'no-store',
    }, this.#fetch, outer, async (response, signal) => {
      if (response.status === 412) return changed('HTTP source representation changed');
      if (response.status === 416) {
        const size = /^bytes \*\/(\d{1,16})$/i.exec(response.headers.get('Content-Range') ?? '')?.[1];
        if (size !== undefined && BigInt(size) !== BigInt(this.size)) return changed('HTTP source size changed');
        throw new EngineError('INVALID_PACKET', 'HTTP server rejected an already-admitted byte range', 'caller-fix', { status: 416 });
      }
      const full = response.status === 200 && range.start === 0 && Number(range.end) === Number(this.size);
      if (response.status !== 206 && !full) throw new EngineError('HTTP_PROTOCOL', 'Exact byte range was refused', 'caller-fix', { status: response.status });
      const etag = response.headers.get('ETag');
      if (!strongTag(etag)) throw new EngineError('INVALID_PACKET', 'Range response lacks a CORS-exposed strong ETag');
      if (etag !== this.#etag) return changed('HTTP source representation changed');
      if (!full) {
        const actual = parseContentRange(response.headers.get('Content-Range'));
        if (actual.size !== this.size) return changed('HTTP source size changed');
        if (actual.start !== range.start || actual.end !== range.end) throw new EngineError('INVALID_PACKET', 'HTTP source returned the wrong byte range');
      }
      return readBounded(response, range.end - range.start, signal);
    });
  }
}
