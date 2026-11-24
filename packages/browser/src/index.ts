import type {
  Cancellation, Decoder, DecoderConfiguration, DeadlineScheduler, OperationContext,
  RebufferPolicy, Session, SessionSnapshot, SourceDescriptor,
} from '@ubve/core';

/** Composition boundary, not a core dependency. Concrete adapters and default
 * selection are implemented here in the next delivery slice; none are faked.
 */
export interface BrowserAdapterRegistry {
  readonly scheduler: DeadlineScheduler;
  openSession(source: SourceDescriptor, context: OperationContext, policy: PlaybackPolicy): Promise<Session>;
  createDecoder(configuration: DecoderConfiguration, context: OperationContext): Promise<Decoder<unknown>>;
}
export interface PlaybackPolicy {
  readonly allowNative: boolean;
  /** Remux stays false until independent timeline/MSE qualification passes. */
  readonly allowUnqualifiedRemux: false;
  readonly workerCeiling: number;
  readonly compressedQueueBytes: number;
  readonly rawVideoQueueBytes: number;
  readonly rawAudioQueueBytes: number;
  readonly rebuffer: RebufferPolicy;
}
export interface OpenOptions { readonly cancellation: Cancellation; readonly deadlineMs: number; }
export interface PlayerOptions {
  readonly host: HTMLElement;
  readonly policy: PlaybackPolicy;
  /** Explicit injection is required until the built-in registry is implemented. */
  readonly adapters: BrowserAdapterRegistry;
}
export interface BrowserPlayer {
  /** A new open first disposes the old Session, then creates a fresh session ID.
   * Resolves when metadata/route preparation is ready; it does not imply autoplay.
   */
  open(source: SourceDescriptor, options: OpenOptions): Promise<SessionSnapshot>;
  currentSession(): Session | null;
  /** Terminal player teardown, including application-owned reusable adapter pools. */
  dispose(): Promise<void>;
}
export type CreatePlayer = (options: PlayerOptions) => BrowserPlayer;

// No createPlayer success stub is exported. This package currently freezes the
// assembly/public-API contract. Implement it with real adapters and lifecycle tests.
