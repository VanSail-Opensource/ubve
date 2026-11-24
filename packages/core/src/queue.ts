import { EngineError, requireCondition } from './errors.js';
import { OwnedLease, type BudgetLimits } from './ownership.js';
import { byteLength } from './units.js';

/** Queue occupancy is distinct from the global allocation ledger. */
export class OwnedQueue<T> {
  #queue: OwnedLease<T>[] = [];
  #bytes = 0;
  #disposed = false;
  readonly limits: BudgetLimits;
  constructor(limits: BudgetLimits) {
    byteLength(limits.bytes); byteLength(limits.maxSingleItemBytes);
    requireCondition(Number.isSafeInteger(limits.items) && limits.items > 0, 'Queue item capacity must be positive');
    requireCondition(limits.maxSingleItemBytes <= limits.bytes, 'Single item must fit queue budget');
    this.limits = Object.freeze({ ...limits });
  }
  /** true moves ownership; false leaves it with the caller. */
  tryPush(lease: OwnedLease<T>): boolean {
    if (this.#disposed) throw new EngineError('DISPOSED', 'Queue is disposed');
    const bytes = lease.bytes;
    if (bytes > this.limits.maxSingleItemBytes) throw new EngineError('ITEM_TOO_LARGE', 'Item exceeds queue single-item limit', 'caller-fix');
    if (this.#queue.length >= this.limits.items || bytes > this.limits.bytes - this.#bytes) return false;
    this.#queue.push(lease.move()); this.#bytes += bytes;
    return true;
  }
  pop(): OwnedLease<T> | null {
    const item = this.#queue.shift();
    if (!item) return null;
    this.#bytes -= item.bytes;
    return item;
  }
  snapshot(): Readonly<{ bytes: number; items: number }> { return Object.freeze({ bytes: this.#bytes, items: this.#queue.length }); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const queue = this.#queue; this.#queue = []; this.#bytes = 0;
    const failures: unknown[] = [];
    for (const item of queue) { try { item.release(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Queue resource destruction failed');
  }
}
