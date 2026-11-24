import type { EngineError } from './errors.js';
import type { SessionStamp } from './epoch.js';
import type { OperationContext } from './operation.js';
import type { MediaTime } from './timeline.js';

export type SessionState = 'opening' | 'ready' | 'playing' | 'paused' | 'seeking' | 'rebuffering' | 'ended' | 'failed' | 'disposed';
export interface SessionSnapshot {
  readonly stamp: SessionStamp;
  readonly state: SessionState;
  readonly mediaTime: MediaTime | null;
  readonly duration: MediaTime | null;
  readonly error: EngineError | null;
}

/** Contract only. The starter does not supply a player/session implementation. */
export interface Session {
  snapshot(): SessionSnapshot;
  /** Resolve after the output's start acknowledgement, not merely request enqueue. */
  play(operation: OperationContext): Promise<SessionSnapshot>;
  /** Resolve after output stops consuming and the logical-media anchor is captured. */
  pause(operation: OperationContext): Promise<SessionSnapshot>;
  /** Invalidate epoch, cancel old work, seek/preroll, prime and preserve playback intent. Paused seeks resolve paused; a seek that
   * resumes playing waits for actual-start acknowledgement. Before first play,
   * preparation may remain ready. No physical scanout/audible output is asserted.
   */
  seek(target: MediaTime, operation: OperationContext): Promise<SessionSnapshot>;
  /** Idempotent and terminal; closes outputs and session-owned resources, and
   * settles pending operations. Application-reusable runtimes have another owner.
   */
  dispose(): Promise<void>;
}
