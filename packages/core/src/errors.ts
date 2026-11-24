export type EngineErrorCode =
  | 'INVALID_ARGUMENT' | 'RANGE_OUTSIDE_SOURCE' | 'SOURCE_CHANGED'
  | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'STALE_EPOCH' | 'DISPOSED'
  | 'BACKPRESSURE' | 'ITEM_TOO_LARGE' | 'OWNERSHIP_VIOLATION'
  | 'UNSUPPORTED_CODEC' | 'UNSUPPORTED_PROFILE' | 'UNSUPPORTED_CONTAINER'
  | 'INVALID_PACKET' | 'INVALID_MEDIA' | 'HTTP_PROTOCOL' | 'NETWORK'
  | 'RENDER_BUDGET' | 'OUTPUT_UNAVAILABLE' | 'ENCRYPTED_MEDIA' | 'INTERNAL';

export type Recovery = 'caller-fix' | 'retry-when-capacity' | 'new-session' | 'none';

/** Finite error vocabulary. Automatic retry is never implied by an error. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly recovery: Recovery;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(code: EngineErrorCode, message: string, recovery: Recovery = 'none',
    details: Readonly<Record<string, string | number | boolean | null>> = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.recovery = recovery;
    this.details = Object.freeze({ ...details });
  }
}

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EngineError('INVALID_ARGUMENT', message, 'caller-fix');
}
