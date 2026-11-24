import { EngineError, requireCondition } from './errors.js';
import { byteLength, type ByteLength } from './units.js';

export interface BudgetLimits {
  readonly bytes: ByteLength;
  readonly items: number;
  /** Explicit upper bound for one admitted item; must fit this budget. */
  readonly maxSingleItemBytes: ByteLength;
}
export interface BudgetSnapshot { readonly bytes: number; readonly items: number; readonly peakBytes: number; readonly peakItems: number; }
export interface MemoryObservation { readonly explicitOwnedBytes: ByteLength; readonly opaqueEstimatedBytes: ByteLength | null; }

/** Reservation happens before allocation. Moving ownership does not free bytes. */
export class BudgetLedger {
  readonly limits: BudgetLimits;
  #bytes = 0;
  #items = 0;
  #peakBytes = 0;
  #peakItems = 0;
  constructor(limits: BudgetLimits) {
    byteLength(limits.bytes); byteLength(limits.maxSingleItemBytes);
    requireCondition(Number.isSafeInteger(limits.items) && limits.items > 0, 'Item budget must be positive');
    requireCondition(limits.maxSingleItemBytes <= limits.bytes, 'Single-item bound exceeds total budget');
    this.limits = Object.freeze({ ...limits });
  }
  tryReserve(bytes: ByteLength): Reservation | null {
    byteLength(bytes);
    if (bytes > this.limits.maxSingleItemBytes) throw new EngineError('ITEM_TOO_LARGE', 'Item exceeds explicitly admitted size', 'caller-fix');
    if (this.#items >= this.limits.items || bytes > this.limits.bytes - this.#bytes) return null;
    this.#bytes += bytes; this.#items++;
    this.#peakBytes = Math.max(this.#peakBytes, this.#bytes);
    this.#peakItems = Math.max(this.#peakItems, this.#items);
    return new Reservation(bytes, () => { this.#bytes -= bytes; this.#items--; });
  }
  snapshot(): BudgetSnapshot { return Object.freeze({ bytes: this.#bytes, items: this.#items, peakBytes: this.#peakBytes, peakItems: this.#peakItems }); }
}

export class Reservation {
  readonly bytes: ByteLength;
  #release: (() => void) | null;
  #claimed = false;
  constructor(bytes: ByteLength, release: () => void) { this.bytes = bytes; this.#release = release; }
  /** Claim once when allocation succeeds. Unclaimed reservations can be cancelled. */
  claim(): () => void {
    if (this.#claimed || !this.#release) throw new EngineError('OWNERSHIP_VIOLATION', 'Reservation already claimed or released');
    this.#claimed = true;
    const release = this.#release;
    this.#release = null;
    return release;
  }
  release(): void { const release = this.#release; this.#release = null; release?.(); }
}

interface Cell<T> { value: T; releaseBudget: () => void; destroy: (value: T) => void; bytes: ByteLength; }

/** Borrowed references may only be used during this owner's lifetime; JS cannot revoke aliases. */
export class OwnedLease<T> {
  #cell: Cell<T> | null;
  #state: 'owned' | 'moved' | 'released' = 'owned';
  private constructor(cell: Cell<T>) { this.#cell = cell; }
  static adopt<T>(reservation: Reservation, value: T, destroy: (value: T) => void = () => {}): OwnedLease<T> {
    return new OwnedLease({ value, destroy, bytes: reservation.bytes, releaseBudget: reservation.claim() });
  }
  get state(): 'owned' | 'moved' | 'released' { return this.#state; }
  get bytes(): ByteLength { return this.#owned().bytes; }
  borrow(): T { return this.#owned().value; }
  #owned(): Cell<T> {
    if (!this.#cell || this.#state !== 'owned') throw new EngineError('OWNERSHIP_VIOLATION', 'Lease is no longer owned by this handle');
    return this.#cell;
  }
  move(): OwnedLease<T> {
    const cell = this.#owned();
    this.#cell = null; this.#state = 'moved';
    return new OwnedLease(cell);
  }
  release(): void {
    if (this.#state !== 'owned') return;
    const cell = this.#owned();
    this.#cell = null; this.#state = 'released';
    try { cell.destroy(cell.value); } finally { cell.releaseBudget(); }
  }
}
