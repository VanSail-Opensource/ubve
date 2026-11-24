import { BudgetLedger, EngineError, OwnedLease, byteLength, byteRange, checkedSourceRange, checkOperation, sourceIdentity, type ByteRange, type OperationContext, type RandomAccessSource, type SourceRead } from '@ubve/core';
import { browserScheduler, withOperation } from './operations.js';

export interface SourceStatistics { requestedBytes: number; deliveredBytes: number; reads: number; activeReads: number; peakActiveReads: number; cacheBytes: number; cacheHits: number; peakCacheBytes: number; }
export interface SourceOptions { readonly maxReadBytes?: number; readonly maxOwnedBytes?: number; readonly maxConcurrentReads?: number; }

export abstract class BoundedSource implements RandomAccessSource {
  abstract readonly identity: RandomAccessSource['identity'];
  abstract readonly size: RandomAccessSource['size'];
  readonly ledger: BudgetLedger;
  readonly stats: SourceStatistics = { requestedBytes: 0, deliveredBytes: 0, reads: 0, activeReads: 0, peakActiveReads: 0, cacheBytes: 0, cacheHits: 0, peakCacheBytes: 0 };
  readonly maxConcurrentReads: number;
  protected closed = false;
  readonly #active = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #shutdown: Promise<void> | null = null;
  #invalidated: EngineError | null = null;
  constructor(options: SourceOptions = {}) {
    const maximum = options.maxReadBytes ?? 32 * 1024 * 1024;
    if (options.maxConcurrentReads !== undefined && (!Number.isSafeInteger(options.maxConcurrentReads) || options.maxConcurrentReads < 1)) throw new EngineError('INVALID_ARGUMENT', 'Invalid source concurrency limit');
    this.maxConcurrentReads = options.maxConcurrentReads ?? 2;
    this.ledger = new BudgetLedger({ bytes: byteLength(options.maxOwnedBytes ?? 64 * 1024 * 1024), items: 256, maxSingleItemBytes: byteLength(maximum) });
  }
  protected abstract load(range: ByteRange, signal: AbortSignal): Promise<Uint8Array>;
  async readExact(range: ByteRange, operation: OperationContext): Promise<SourceRead> {
    if (this.closed) throw new EngineError('DISPOSED', 'Source has been closed');
    checkOperation(operation, browserScheduler); checkedSourceRange(range, this.size);
    const length = byteLength(range.end - range.start);
    if (this.stats.activeReads >= this.maxConcurrentReads) throw new EngineError('BACKPRESSURE', 'Source read concurrency is full', 'retry-when-capacity');
    const reservation = this.ledger.tryReserve(length);
    if (!reservation) throw new EngineError('BACKPRESSURE', 'Source owned-byte budget is full', 'retry-when-capacity');
    this.stats.reads++; this.stats.requestedBytes += length; this.stats.activeReads++;
    this.stats.peakActiveReads = Math.max(this.stats.peakActiveReads, this.stats.activeReads);
    const work = withOperation(operation, async signal => {
      const combined = AbortSignal.any([signal, this.#abort.signal]);
      const data = length === 0 ? new Uint8Array(0) : await this.load(range, combined);
      if (combined.aborted) throw combined.reason;
      if (this.closed) throw new EngineError('DISPOSED', 'Source closed during read');
      if (data.byteLength !== length || data.buffer.byteLength !== length) throw new EngineError('INVALID_PACKET', 'Exact source read returned a short or oversized backing store');
      checkOperation(operation, browserScheduler);
      const bytes = OwnedLease.adopt(reservation, data);
      this.stats.deliveredBytes += length;
      return { stamp: operation.stamp, operationId: operation.operationId, identity: this.identity, range, bytes };
    });
    this.#active.add(work);
    try { return await work; }
    catch (error) { reservation.release(); throw error; }
    finally { this.#active.delete(work); this.stats.activeReads--; }
  }
  assertReadable(): void { if (this.closed) throw this.#invalidated ?? new EngineError('DISPOSED', 'Source has been closed'); }
  protected invalidate(reason: EngineError): void { this.#invalidated = reason; this.closed = true; this.#abort.abort(reason); }
  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.closed = true; this.#abort.abort(new EngineError('DISPOSED', 'Source closed'));
    this.#shutdown = Promise.allSettled([...this.#active]).then(() => {});
    return this.#shutdown;
  }
}

/** Blob is immutable; only bounded slices are materialized. No full-source copy. */
export class BlobSource extends BoundedSource {
  readonly identity;
  readonly size;
  readonly blob: Blob;
  constructor(blob: Blob, options: SourceOptions = {}) {
    super(options); this.blob = blob; this.size = byteLength(blob.size);
    const id = crypto.randomUUID(); this.identity = sourceIdentity(id, `immutable-blob:${id}:${blob.size}`);
  }
  protected async load(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw signal.reason;
    const bytes = new Uint8Array(await this.blob.slice(range.start, range.end).arrayBuffer());
    if (signal.aborted) throw signal.reason;
    return bytes;
  }
}

/** One shared LRU, used by every parser/track. The backing leases stay charged. */
export class SourceCache {
  readonly source: RandomAccessSource;
  readonly capacity: number;
  readonly pageBytes: number;
  #bytes = 0; #peak = 0; #hits = 0;
  #pages = new Map<number, OwnedLease<Uint8Array>>();
  #pending = new Map<number, Promise<OwnedLease<Uint8Array>>>();
  #closed = false;
  #shutdown: Promise<void> | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  readonly #results = new BudgetLedger({ bytes: byteLength(64 * 1024 * 1024), items: 262144, maxSingleItemBytes: byteLength(32 * 1024 * 1024) });
  readonly #retained = new Set<OwnedLease<Uint8Array>>();
  constructor(source: RandomAccessSource, capacity = 8 * 1024 * 1024, pageBytes = 256 * 1024) {
    if (!Number.isSafeInteger(capacity) || !Number.isSafeInteger(pageBytes) || pageBytes < 1 || capacity < pageBytes) throw new EngineError('INVALID_ARGUMENT', 'Invalid cache bounds');
    this.source = source; this.capacity = capacity; this.pageBytes = pageBytes;
  }
  /** Adapter results with no release callback remain charged for the cache lifetime. */
  async read(start: number, end: number, operation: OperationContext): Promise<Uint8Array> {
    const result = await this.readOwned(start, end, operation);
    if (this.#closed) { result.release(); throw new EngineError('DISPOSED', 'Cache closed before retained parser result delivery'); }
    this.#retained.add(result); return result.borrow();
  }
  /** Synchronous field parsing cannot retain this lease past the callback. */
  async readValue<T>(start: number, end: number, operation: OperationContext, parse: (bytes: Uint8Array) => T): Promise<T> {
    const result = await this.readOwned(start, end, operation);
    try { return parse(result.borrow()); } finally { result.release(); }
  }
  async readOwned(start: number, end: number, operation: OperationContext): Promise<OwnedLease<Uint8Array>> {
    checkedSourceRange(byteRange(start, end), this.source.size);
    if (this.#closed) throw new EngineError('DISPOSED', 'Cache closed');
    if (end - start > 32 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'One parser read exceeds 32 MiB');
    // Serial copies ensure eviction cannot release a page another read is borrowing.
    const run = async () => {
      if (this.#closed) throw new EngineError('DISPOSED', 'Cache closed while parser read was queued');
      if (this.source instanceof BoundedSource) this.source.assertReadable();
      checkOperation(operation, browserScheduler);
      const reservation = this.#results.tryReserve(byteLength(end - start));
      if (!reservation) throw new EngineError('BACKPRESSURE', 'Parser read-result ownership exceeds 64 MiB', 'retry-when-capacity');
      try {
      const result = new Uint8Array(end - start);
      for (let offset = start; offset < end;) {
        const page = Math.floor(offset / this.pageBytes), base = page * this.pageBytes;
        const lease = await this.#page(page, operation), bytes = lease.borrow();
        if (this.#closed) throw new EngineError('DISPOSED', 'Cache closed while copying a parser result');
        const count = Math.min(end - offset, bytes.length - (offset - base));
        result.set(bytes.subarray(offset - base, offset - base + count), offset - start); offset += count;
      }
      checkOperation(operation, browserScheduler);
      if (this.#closed) throw new EngineError('DISPOSED', 'Cache closed before parser result delivery');
      if (this.source instanceof BoundedSource) this.source.assertReadable();
      return OwnedLease.adopt<Uint8Array>(reservation, result);
      } catch (error) { reservation.release(); throw error; }
    };
    const work = this.#serial.then(run, run); this.#serial = work.catch(() => {}); return work;
  }
  async #page(page: number, operation: OperationContext): Promise<OwnedLease<Uint8Array>> {
    const existing = this.#pages.get(page);
    if (existing) { this.#pages.delete(page); this.#pages.set(page, existing); this.#hits++; return existing; }
    const pending = this.#pending.get(page); if (pending) return pending;
    const start = page * this.pageBytes, end = Math.min(this.source.size, start + this.pageBytes);
    while (this.#bytes + end - start > this.capacity) {
      const first = this.#pages.entries().next().value as [number, OwnedLease<Uint8Array>] | undefined;
      if (!first) break;
      this.#pages.delete(first[0]); this.#bytes -= first[1].bytes; first[1].release();
    }
    const work = this.source.readExact({ start: start as ByteRange['start'], end: end as ByteRange['end'] }, operation).then(read => {
      if (this.#closed) { read.bytes.release(); throw new EngineError('DISPOSED', 'Cache closed during read'); }
      this.#pages.set(page, read.bytes); this.#bytes += read.bytes.bytes; this.#peak = Math.max(this.#peak, this.#bytes); return read.bytes;
    }).finally(() => this.#pending.delete(page));
    this.#pending.set(page, work); return work;
  }
  snapshot() { return { bytes: this.#bytes, peakBytes: this.#peak, hits: this.#hits, pages: this.#pages.size, readResults: this.#results.snapshot(), retainedParserResults: this.#retained.size }; }
  close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#closed = true;
    const sourceClose = this.source.close();
    this.#shutdown = (async () => { await this.#serial; await Promise.allSettled([...this.#pending.values()]);
    for (const page of this.#pages.values()) page.release();
    for (const result of this.#retained) result.release(); this.#retained.clear();
    this.#pages.clear(); this.#bytes = 0; await sourceClose; })();
    return this.#shutdown;
  }
}
