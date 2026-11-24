import {
  EngineError, OwnedLease, byteLength, checkOperation, checkedSourceRange,
  rangeLength, sourceIdentity,
  type BudgetLedger, type ByteLength, type ByteRange, type DeadlineScheduler,
  type OperationContext, type RandomAccessSource, type SourceIdentity, type SourceRead,
} from '@ubve/core';

/** Small in-memory test fixture source; never a large-file production adapter. */
export class MemorySource implements RandomAccessSource {
  readonly identity: SourceIdentity;
  readonly size: ByteLength;
  #data: Uint8Array | null;
  #budget: BudgetLedger;
  #scheduler: DeadlineScheduler;
  constructor(data: Uint8Array, budget: BudgetLedger, scheduler: DeadlineScheduler, id = 'memory-fixture') {
    this.#data = data.slice();
    this.size = byteLength(data.byteLength);
    this.identity = sourceIdentity(id, 'immutable-test-copy-v1');
    this.#budget = budget;
    this.#scheduler = scheduler;
  }
  async readExact(range: ByteRange, operation: OperationContext): Promise<SourceRead> {
    if (!this.#data) throw new EngineError('DISPOSED', 'Source is closed', 'new-session');
    checkOperation(operation, this.#scheduler);
    const checked = checkedSourceRange(range, this.size);
    const reservation = this.#budget.tryReserve(rangeLength(checked));
    if (!reservation) throw new EngineError('BACKPRESSURE', 'Read-output capacity exhausted', 'retry-when-capacity');
    try {
      const data = this.#data.slice(checked.start, checked.end);
      const bytes = OwnedLease.adopt<Uint8Array>(reservation, data);
      return Object.freeze({ stamp: operation.stamp, operationId: operation.operationId, identity: this.identity, range: checked, bytes });
    } catch (error) { reservation.release(); throw error; }
  }
  async close(): Promise<void> { this.#data = null; }
}
