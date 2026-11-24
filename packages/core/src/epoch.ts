import { EngineError, requireCondition } from './errors.js';

export interface SessionStamp { readonly sessionId: string; readonly generation: number; }

export function sessionStamp(sessionId: string, generation: number): SessionStamp {
  requireCondition(sessionId.length > 0, 'A nonempty session identity is required');
  requireCondition(Number.isSafeInteger(generation) && generation >= 0, 'Generation must be a nonnegative safe integer');
  return Object.freeze({ sessionId, generation });
}

export const sameEpoch = (a: SessionStamp, b: SessionStamp): boolean => a.sessionId === b.sessionId && a.generation === b.generation;

/** dispose is terminal. A later open creates a new controller/session. */
export class EpochController {
  #stamp: SessionStamp;
  #disposed = false;
  constructor(id: string) { this.#stamp = sessionStamp(id, 0); }
  capture(): SessionStamp { return this.#stamp; }
  accepts(stamp: SessionStamp): boolean { return !this.#disposed && sameEpoch(this.#stamp, stamp); }
  advance(): SessionStamp {
    if (this.#disposed) throw new EngineError('DISPOSED', 'Session is disposed', 'new-session');
    this.#stamp = sessionStamp(this.#stamp.sessionId, this.#stamp.generation + 1);
    return this.#stamp;
  }
  dispose(): void { this.#disposed = true; }
}

/** The recipient releases obsolete output rather than merely ignoring it. */
export function acceptCurrent<T extends { release(): void }>(epochs: EpochController, stamp: SessionStamp, owned: T): T | null {
  if (epochs.accepts(stamp)) return owned;
  owned.release();
  return null;
}
