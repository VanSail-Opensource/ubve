import {
  BudgetLedger, EngineError, OwnedLease, byteLength, checkedSourceRange, checkOperation,
  sourceIdentity, type ByteRange, type OperationContext, type RandomAccessSource,
  type SourceRead,
} from '@ubve/core';
import { DiscFolder, UDF_MAX_IMAGE_BYTES, normalizeDiscPath, type DiscInventory, type LocalDiscFile } from './folder.js';

const MAX_READ = 1024 * 1024;
const scheduler = { nowMs: () => performance.now(), at: (at: number, cb: () => void) => {
  const timer = setTimeout(cb, Math.max(0, at - performance.now())); return () => clearTimeout(timer);
} };
const neverCancelled = { aborted: false, reason: null, subscribe: () => () => {} } as const;
interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (reason: unknown) => void; readonly cleanup: () => void; readonly operation: OperationContext; }
export interface DiscOpenOptions {
  readonly workerUrl?: string | URL;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** UDF filesystem inspection alone does not admit a Blu-ray title. */
  readonly udfOnly?: boolean;
  /** Host injection permits worker protocol testing; production defaults to a real module Worker. */
  readonly workerFactory?: (url: string | URL) => Worker;
}
export interface DiscDirectoryEntry { readonly name: string; readonly directory: boolean; }

/** One worker owns one immutable disc. Cancellation retires the owner, because a synchronous
 * C callback cannot process another message until it returns. Terminate is a request, not
 * an observation of physical memory reclamation. Delivered byte leases remain charged. */
export class DiscSession {
  readonly identity = sourceIdentity(crypto.randomUUID(), 'immutable-local-disc-v1');
  readonly ledger = new BudgetLedger({ bytes: byteLength(4 * MAX_READ), items: 4, maxSingleItemBytes: byteLength(MAX_READ) });
  readonly inventory: DiscInventory | null;
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #timeout: number;
  #nextId = 0;
  #state: 'open' | 'closing' | 'closed' = 'open';
  #close: Promise<void> | null = null;
  private constructor(worker: Worker, timeout: number, inventory: DiscInventory | null = null) {
    this.#worker = worker; this.#timeout = timeout; this.inventory = inventory;
    worker.onmessage = event => this.#message(event.data as unknown);
    worker.onerror = event => { event.preventDefault(); this.#retire(new EngineError('INTERNAL', 'Disc worker failed')); };
    worker.onmessageerror = () => this.#retire(new EngineError('INVALID_PACKET', 'Disc worker message could not be decoded'));
  }
  static async open(input: Blob | readonly LocalDiscFile[], options: DiscOpenOptions = {}): Promise<DiscSession> {
    const timeout = options.timeoutMs ?? 15000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000) throw new EngineError('INVALID_ARGUMENT', 'Disc deadline must be 1..120000 ms');
    if (options.signal?.aborted) throw new EngineError('CANCELLED', 'Disc open cancelled');
    let payload: Record<string, unknown>;
    if (input instanceof Blob) {
      if (!Number.isSafeInteger(input.size) || input.size < 2048 || input.size % 2048 !== 0 || BigInt(input.size) > UDF_MAX_IMAGE_BYTES)
        throw new EngineError('UNSUPPORTED_PROFILE', 'Image exceeds the admitted local 2048-byte UDF block profile');
      payload = { image: input };
    } else payload = { files: new DiscFolder(input).files };
    const worker = (options.workerFactory ?? (url => new Worker(url, { type: 'module', name: 'ubve-disc' })))(options.workerUrl ?? '/vendor/disc/disc-worker.mjs');
    const session = new DiscSession(worker, timeout);
    const abort = () => session.#retire(new EngineError('CANCELLED', 'Disc open cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await session.#request('open', { ...payload, udfOnly: options.udfOnly ?? false });
      if (!options.udfOnly) {
        if (!result || typeof result !== 'object' || (result as DiscInventory).provider !== 'libbluray-1.5.0' ||
            (result as DiscInventory).timeBase !== '1/90000' || !Array.isArray((result as DiscInventory).titles) || (result as DiscInventory).titles.length > 1024)
          throw new EngineError('INVALID_MEDIA', 'Disc worker returned an invalid title inventory');
        Object.defineProperty(session, 'inventory', { value: result, enumerable: true });
      }
      if (session.#state !== 'open') throw new EngineError('CANCELLED', 'Disc open was retired');
      return session;
    } catch (error) { session.#retire(error); throw error; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
  #operation(id: number): OperationContext {
    return { stamp: { sessionId: this.identity.id, generation: 0 }, operationId: `disc:${id}`, deadlineMs: performance.now() + this.#timeout, cancellation: neverCancelled };
  }
  #request(type: string, body: Record<string, unknown>, operation?: OperationContext): Promise<unknown> {
    if (this.#state === 'closed' || (this.#state === 'closing' && type !== 'close')) return Promise.reject(new EngineError('DISPOSED', 'Disc is closed'));
    if (this.#pending.size >= 4) return Promise.reject(new EngineError('BACKPRESSURE', 'Disc RPC admission is full', 'retry-when-capacity'));
    const id = ++this.#nextId, context = operation ?? this.#operation(id);
    try { checkOperation(context, scheduler); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const timer = scheduler.at(context.deadlineMs, () => this.#retire(new EngineError('DEADLINE_EXCEEDED', 'Disc worker deadline expired; source retired')));
      this.#pending.set(id, { resolve, reject, operation: context, cleanup: () => { timer(); unsubscribe(); } });
      unsubscribe = context.cancellation.subscribe(reason => this.#retire(reason));
      if (this.#state === 'closed') { unsubscribe(); return; }
      try { this.#worker.postMessage({ ...body, type, id, stamp: context.stamp, operationId: context.operationId }); }
      catch (error) { this.#retire(error); }
    });
  }
  #message(data: unknown): void {
    if (!data || typeof data !== 'object') { this.#retire(new EngineError('INVALID_PACKET', 'Invalid disc response')); return; }
    const message = data as { id?: number; stamp?: { sessionId?: string; generation?: number }; operationId?: string; error?: string; result?: unknown };
    const item = message.id === undefined ? undefined : this.#pending.get(message.id);
    if (!item) return; // Retired owner's late delivery cannot become live output.
    const context = item.operation;
    if (message.operationId !== context.operationId || message.stamp?.sessionId !== context.stamp.sessionId || message.stamp.generation !== context.stamp.generation) {
      this.#retire(new EngineError('INVALID_PACKET', 'Disc response identity mismatch')); return;
    }
    try { checkOperation(context, scheduler); }
    catch (error) { this.#retire(error); return; }
    if (message.error !== undefined) { this.#retire(new EngineError('INVALID_MEDIA', message.error)); return; }
    this.#pending.delete(message.id!); item.cleanup(); item.resolve(message.result);
  }
  #retire(reason: unknown): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed'; this.#worker.terminate();
    for (const item of this.#pending.values()) { item.cleanup(); item.reject(reason); }
    this.#pending.clear();
  }
  async list(path = ''): Promise<readonly DiscDirectoryEntry[]> {
    const result = await this.#request('list', { path: path ? normalizeDiscPath(path) : '' });
    if (!Array.isArray(result) || result.length > 4096 || result.some(item => !item || typeof item.name !== 'string' || typeof item.directory !== 'boolean')) {
      const error = new EngineError('INVALID_MEDIA', 'Malformed disc directory response'); this.#retire(error); throw error;
    }
    return result as DiscDirectoryEntry[];
  }
  async source(path: string): Promise<RandomAccessSource> {
    const normalized = normalizeDiscPath(path), result = await this.#request('stat', { path: normalized }) as { size?: number } | null;
    if (!result || !Number.isSafeInteger(result.size) || result.size! < 0) {
      const error = new EngineError('INVALID_MEDIA', 'Malformed disc file size'); this.#retire(error); throw error;
    }
    const size = byteLength(result.size!), identity = sourceIdentity(`${this.identity.id}/${normalized}`, this.identity.revision);
    let closed = false; const active = new Set<Promise<SourceRead>>();
    const owner = this;
    return {
      identity, size,
      async readExact(range: ByteRange, operation: OperationContext): Promise<SourceRead> {
        if (closed) throw new EngineError('DISPOSED', 'Disc file source is closed');
        checkedSourceRange(range, size); checkOperation(operation, scheduler);
        const length = byteLength(range.end - range.start), reservation = owner.ledger.tryReserve(length);
        if (!reservation) throw new EngineError('BACKPRESSURE', 'Disc read budget is full', 'retry-when-capacity');
        const work = (async () => {
          try {
            const result = await owner.#request('read', { path: normalized, offset: range.start, length }, operation);
            if (closed) throw new EngineError('DISPOSED', 'Disc file closed during read');
            checkOperation(operation, scheduler);
            if (!(result instanceof Uint8Array) || result.byteLength !== length || result.buffer.byteLength !== length) {
              const error = new EngineError('INVALID_PACKET', 'Disc read was not exact'); owner.#retire(error); throw error;
            }
            return { identity, range, stamp: operation.stamp, operationId: operation.operationId, bytes: OwnedLease.adopt(reservation, result) };
          } catch (error) { reservation.release(); throw error; }
        })();
        active.add(work); try { return await work; } finally { active.delete(work); }
      },
      async close() { closed = true; await Promise.allSettled([...active]); },
    };
  }
  snapshot(): { readonly state: string; readonly pending: number; readonly ownedBytes: number; readonly wasmMaximumBytes: number; readonly physicalMemoryReclamation: 'unobserved' } {
    return { state: this.#state, pending: this.#pending.size, ownedBytes: this.ledger.snapshot().bytes, wasmMaximumBytes: 128 * 1024 * 1024, physicalMemoryReclamation: 'unobserved' };
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'closing';
    this.#close = (async () => { try { await this.#request('close', {}); } finally { this.#retire(new EngineError('DISPOSED', 'Disc disposed')); } })();
    return this.#close;
  }
}
