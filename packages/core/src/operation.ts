import { EngineError, requireCondition } from './errors.js';
import type { SessionStamp } from './epoch.js';

/** Core has no DOM/Node ambient dependency; platform AbortSignal adapters live outside core. */
export interface Cancellation {
  readonly aborted: boolean;
  readonly reason: EngineError | null;
  subscribe(listener: (reason: EngineError) => void): () => void;
}

export interface DeadlineScheduler {
  nowMs(): number;
  /** Schedule independently of operation completion, at the earliest runnable
   * callback at/after the deadline. A blocked event loop can delay callbacks;
   * adapters also checkOperation at admission and before delivering completion.
   */
  at(deadlineMs: number, callback: () => void): () => void;
}

export interface OperationContext {
  readonly stamp: SessionStamp;
  readonly operationId: string;
  readonly deadlineMs: number;
  readonly cancellation: Cancellation;
}

export function checkOperation(context: OperationContext, scheduler: DeadlineScheduler): void {
  requireCondition(context.operationId.length > 0, 'Operation identity is required');
  requireCondition(Number.isFinite(context.deadlineMs), 'Operations require a finite deadline');
  if (context.cancellation.aborted) throw context.cancellation.reason ?? new EngineError('CANCELLED', 'Operation cancelled');
  if (scheduler.nowMs() >= context.deadlineMs) throw new EngineError('DEADLINE_EXCEEDED', 'Operation deadline elapsed');
}

export class CancellationController {
  #reason: EngineError | null = null;
  #listeners = new Set<(reason: EngineError) => void>();
  readonly signal: Cancellation;
  constructor() {
    const self = this;
    this.signal = Object.freeze({
      get aborted() { return self.#reason !== null; },
      get reason() { return self.#reason; },
      subscribe(listener: (reason: EngineError) => void): () => void {
        if (self.#reason) { listener(self.#reason); return () => {}; }
        self.#listeners.add(listener);
        return () => { self.#listeners.delete(listener); };
      },
    });
  }
  abort(reason = new EngineError('CANCELLED', 'Operation cancelled')): void {
    if (this.#reason) return;
    this.#reason = reason;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    const failures: unknown[] = [];
    for (const listener of listeners) {
      try { listener(reason); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Cancellation listeners failed after all were notified');
  }
}
