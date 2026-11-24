import type { EngineError } from './errors.js';
import type { SessionStamp } from './epoch.js';
import type { OperationContext } from './operation.js';
import type { OwnedOutput, VideoPixels } from './output.js';
import type { EncodedPacket } from './packet.js';
import type { ByteLength } from './units.js';

/** Track metadata is explicit: nullable codec-private bytes cannot stand in for
 * the sample rate/layout or coded geometry/color that a provider needs. Unknown
 * color remains null until a route's admission policy accepts or rejects it.
 */
export type DecoderMediaConfiguration =
  | { readonly kind: 'audio'; readonly sampleRate: number; readonly channelLabels: readonly string[] }
  | {
      readonly kind: 'video';
      readonly codedWidth: number;
      readonly codedHeight: number;
      readonly visibleRect: VideoPixels['visibleRect'];
      readonly color: VideoPixels['color'];
    };

export interface DecoderConfiguration {
  readonly codecId: string;
  readonly media: DecoderMediaConfiguration;
  readonly codecConfigEpoch: number;
  readonly description: Uint8Array | null;
  readonly requestedWorkers: number;
  readonly sharedMemory: 'required' | 'allowed' | 'forbidden';
  readonly acceptedOutputLayouts: readonly string[];
}
export interface DecoderResources {
  readonly explicitInputBudgetEnforced: boolean;
  readonly explicitOutputBudgetEnforced: boolean;
  readonly internalHeap: 'hard-cap' | 'estimated' | 'opaque';
  readonly internalHeapLimitBytes: ByteLength | null;
  readonly internalHeapEstimateBytes: ByteLength | null;
  /** Retained modules/worker pools belong to the application ledger if reusable. */
  readonly runtimeLifetime: 'session' | 'application-reusable';
  readonly completeShutdown: 'implemented-and-tested' | 'not-established';
}
export interface EffectiveDecoderConfiguration {
  readonly codecId: string;
  readonly workers: number;
  readonly sharedMemory: boolean;
  readonly outputLayout: string;
  readonly resources: DecoderResources;
}

export type Submission =
  | { readonly status: 'accepted'; readonly inputConsumed: Promise<void> }
  | { readonly status: 'backpressure'; readonly reason: 'items' | 'bytes' | 'capacity' }
  | { readonly status: 'rejected'; readonly error: EngineError };

export interface Decoder<Payload> {
  readonly effective: EffectiveDecoderConfiguration;
  /** Accepted synchronously moves packet.bytes; every other result leaves it
   * with the caller. inputConsumed settles once when the codec no longer needs
   * the encoded bytes; it does NOT promise an output for that packet. Delayed and
   * reordered outputs arrive through readOutput. Abort/deadline/reset/dispose release accepted input and
   * undelivered output; already delivered outputs remain recipient-owned.
   */
  trySubmit(packet: EncodedPacket, operation: OperationContext): Submission;
  /** One output consumer. Waits with cancellation/deadline when temporarily empty;
   * null means EOS has been flushed and all queued output has been delivered.
   * Adapters bound output by bytes AND count, including codec-delayed frames.
   */
  readOutput(operation: OperationContext): Promise<OwnedOutput<Payload> | null>;
  /** Resolves when all submissions accepted before this call have settled.
   * It does not release delivered outputs or admit later submissions into its wait.
   */
  drain(operation: OperationContext): Promise<void>;
  /** Stop input admission, flush delayed/tail codec output, and seal the output
   * channel. The caller must keep reading concurrently if output capacity fills.
   */
  flushEndOfStream(operation: OperationContext): Promise<void>;
  /** Invalidate the old epoch synchronously; pending promises reject STALE_EPOCH.
   * The promise is the explicit readiness barrier. No admission before it resolves.
   */
  reset(next: SessionStamp, operation: OperationContext): Promise<void>;
  /** Terminal/idempotent; invalidate synchronously and await actual shutdown.
   * Implementations need a finite configured shutdown deadline; reject if shutdown
   * cannot be established instead of claiming complete release.
   */
  dispose(): Promise<void>;
}

export interface WorkerEnvelope<Body> {
  readonly protocolVersion: 1;
  readonly stamp: SessionStamp;
  readonly operationId: string;
  readonly body: Body;
  readonly ownership: 'move' | 'shared-reference' | 'none';
  readonly transferIds: readonly string[];
}
