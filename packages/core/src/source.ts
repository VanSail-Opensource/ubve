import { EngineError, requireCondition } from './errors.js';
import type { OperationContext } from './operation.js';
import type { SessionStamp } from './epoch.js';
import type { OwnedLease } from './ownership.js';
import { byteRange, type ByteLength, type ByteRange } from './units.js';

export interface SourceIdentity { readonly id: string; readonly revision: string; }
export function sourceIdentity(id: string, revision: string): SourceIdentity {
  requireCondition(id.length > 0 && revision.length > 0, 'Stable opaque source identity and revision are required');
  return Object.freeze({ id, revision });
}

export interface SourceRead {
  readonly stamp: SessionStamp;
  readonly operationId: string;
  readonly identity: SourceIdentity;
  readonly range: ByteRange;
  /** Caller owns this exact read after resolution and must release or move it. */
  readonly bytes: OwnedLease<Uint8Array>;
}

export interface RandomAccessSource {
  readonly identity: SourceIdentity;
  readonly size: ByteLength;
  /** Exact [start,end), including zero length at EOF. Reject out-of-range; never silently truncate.
   * On observed cancellation/deadline/close, stop delivery and reject exactly once.
   * Abort underlying work where supported. Uninterruptible reads remain accounted
   * until completion or owned-worker termination; discard/release their late bytes.
   * Caller settlement alone is not evidence that the underlying read stopped.
   * SOURCE_CHANGED terminates the source; bytes from different revisions must not mix.
   */
  readExact(range: ByteRange, operation: OperationContext): Promise<SourceRead>;
  /** Idempotent, terminal; resolves after pending work has settled and source-owned resources release.
   * Already delivered leases belong to their recipients and remain their responsibility.
   */
  close(): Promise<void>;
}

export function checkedSourceRange(range: ByteRange, size: ByteLength): ByteRange {
  const checked = byteRange(range.start, range.end);
  if (checked.end > size) throw new EngineError('RANGE_OUTSIDE_SOURCE', 'Exact read extends beyond EOF', 'caller-fix');
  return checked;
}

/** An opaque native URL is not advertised as a random-access byte source. */
export type SourceDescriptor =
  | { readonly kind: 'random-access'; readonly source: RandomAccessSource }
  | { readonly kind: 'native-url'; readonly url: string; readonly credentials: 'omit' | 'include' };
