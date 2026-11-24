import { EngineError, checkOperation, type Cancellation, type DeadlineScheduler, type OperationContext, type SessionStamp } from '@ubve/core';

export const browserScheduler: DeadlineScheduler = {
  nowMs: () => performance.now(),
  at(deadline, callback) { const timer = setTimeout(callback, Math.max(0, deadline - performance.now())); return () => clearTimeout(timer); },
};

export function operationContext(stamp: SessionStamp, id: string, signal?: AbortSignal, timeoutMs = 5000): OperationContext {
  const cancellation: Cancellation = {
    get aborted() { return signal?.aborted ?? false; },
    get reason() { return signal?.aborted ? new EngineError('CANCELLED', 'Operation cancelled') : null; },
    subscribe(listener) {
      if (signal?.aborted) { listener(new EngineError('CANCELLED', 'Operation cancelled')); return () => {}; }
      const abort = () => listener(new EngineError('CANCELLED', 'Operation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      return () => signal?.removeEventListener('abort', abort);
    },
  };
  return { stamp, operationId: id, cancellation, deadlineMs: performance.now() + timeoutMs };
}

/** The returned cleanup removes deadline and cancellation listeners after settlement. */
export function abortForOperation(operation: OperationContext): { signal: AbortSignal; cleanup(): void } {
  checkOperation(operation, browserScheduler);
  const controller = new AbortController();
  const unsubscribe = operation.cancellation.subscribe(reason => controller.abort(reason));
  const cancelTimer = browserScheduler.at(operation.deadlineMs, () => controller.abort(new EngineError('DEADLINE_EXCEEDED', 'Operation deadline elapsed')));
  return { signal: controller.signal, cleanup() { unsubscribe(); cancelTimer(); } };
}

export async function withOperation<T>(operation: OperationContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = abortForOperation(operation);
  try { const value = await work(abort.signal); checkOperation(operation, browserScheduler); return value; }
  finally { abort.cleanup(); }
}
