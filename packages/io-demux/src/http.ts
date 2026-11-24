import { EngineError, byteLength, sourceIdentity, type ByteRange, type OperationContext } from '@ubve/core';
import { BoundedSource, type SourceOptions } from './source.js';
import { withOperation } from './operations.js';

export interface HttpSourceOptions extends SourceOptions { readonly credentials?: RequestCredentials; readonly fetch?: typeof fetch; }
function strongTag(value: string | null): value is string { return value !== null && /^"[^"\r\n]*"$/.test(value); }
export function parseContentRange(value: string | null): { start: number; end: number; size: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) throw new EngineError('INVALID_PACKET', 'A readable exact Content-Range header is required');
  const values = match.slice(1).map(BigInt);
  if (values.some(value => value > BigInt(Number.MAX_SAFE_INTEGER))) throw new EngineError('ITEM_TOO_LARGE', 'HTTP range exceeds exact address space');
  const [start, last, size] = values.map(Number) as [number, number, number];
  if (last < start || last >= size) throw new EngineError('INVALID_PACKET', 'Invalid HTTP Content-Range extent');
  return { start, end: last + 1, size };
}
async function readBounded(response: Response, expected: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new EngineError('INVALID_PACKET', 'HTTP source has no body');
  const reader = response.body.getReader(), bytes = new Uint8Array(expected); let offset = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read(); if (next.done) break;
      if (offset + next.value.length > expected) throw new EngineError('INVALID_PACKET', 'HTTP body exceeds declared range');
      bytes.set(next.value, offset); offset += next.value.length;
    }
    if (offset !== expected) throw new EngineError('INVALID_PACKET', 'HTTP source returned a short range body'); return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Strict immutable HTTP representation: CORS-readable strong ETag + exact 206. */
export class HttpRangeSource extends BoundedSource {
  readonly identity;
  readonly size;
  readonly #url: string;
  readonly #etag: string;
  readonly #fetch: typeof fetch;
  readonly #credentials: RequestCredentials;
  private constructor(url: string, size: number, etag: string, options: HttpSourceOptions) {
    super(options); this.#url = url; this.size = byteLength(size); this.#etag = etag;
    this.#fetch = options.fetch ?? fetch; this.#credentials = options.credentials ?? 'omit';
    this.identity = sourceIdentity(crypto.randomUUID(), etag);
  }
  static async open(url: string, operation: OperationContext, options: HttpSourceOptions = {}): Promise<HttpRangeSource> {
    const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new EngineError('INVALID_ARGUMENT', 'Use an HTTP(S) media URL without embedded credentials');
    return withOperation(operation, async signal => {
      const response = await (options.fetch ?? fetch)(url, { headers: { Range: 'bytes=0-0' }, credentials: options.credentials ?? 'omit', mode: 'cors', redirect: 'follow', signal, cache: 'no-store' });
      const reject = async (message: string): Promise<never> => { await response.body?.cancel(); throw new EngineError('UNSUPPORTED_CODEC', message, 'caller-fix'); };
      if (response.status !== 206) return reject(`Strict remote input requires 206 byte ranges (received ${response.status})`);
      const encoding = response.headers.get('Content-Encoding'); if (encoding && encoding !== 'identity') return reject('Encoded HTTP representations are not admitted for byte offsets');
      const etag = response.headers.get('ETag'); if (!strongTag(etag)) return reject('Strict remote input requires a CORS-exposed strong ETag');
      const range = parseContentRange(response.headers.get('Content-Range'));
      if (range.start !== 0 || range.end !== 1) return reject('Initial HTTP probe returned the wrong range');
      await readBounded(response, 1, signal);
      return new HttpRangeSource(response.url || url, range.size, etag, options);
    });
  }
  protected async load(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw signal.reason;
      try {
        const response = await this.#fetch(this.#url, {
          headers: { Range: `bytes=${range.start}-${range.end - 1}`, 'If-Match': this.#etag },
          credentials: this.#credentials, mode: 'cors', signal, cache: 'no-store',
        });
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) { await response.body?.cancel(); lastError = new EngineError('INTERNAL', `Transient HTTP response ${response.status}`); continue; }
        const changed = response.status === 412 || response.headers.get('ETag') !== this.#etag;
        if (changed) { const error = new EngineError('SOURCE_CHANGED', 'HTTP source representation changed', 'new-session'); this.invalidate(error); await response.body?.cancel(); throw error; }
        if (response.status !== 206) { await response.body?.cancel(); throw new EngineError('INVALID_PACKET', `Exact byte range was refused (${response.status})`); }
        const actual = parseContentRange(response.headers.get('Content-Range'));
        if (actual.size !== this.size) { const error = new EngineError('SOURCE_CHANGED', 'HTTP source size changed', 'new-session'); this.invalidate(error); await response.body?.cancel(); throw error; }
        if (actual.start !== range.start || actual.end !== range.end) { await response.body?.cancel(); throw new EngineError('INVALID_PACKET', 'HTTP source returned the wrong byte range'); }
        const encoding = response.headers.get('Content-Encoding');
        if (encoding && encoding !== 'identity') { await response.body?.cancel(); throw new EngineError('INVALID_PACKET', 'HTTP range uses unsupported content coding'); }
        return await readBounded(response, range.end - range.start, signal);
      } catch (error) {
        if (signal.aborted || error instanceof EngineError) throw error;
        lastError = error; // Transport errors alone may retry, inside the original operation deadline.
      }
    }
    throw lastError ?? new EngineError('INTERNAL', 'HTTP source exhausted three attempts');
  }
}
