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

export { createPlayer, ReferencePlayer, prepareDirectPlayback } from './player.js';
export type {
  MediaInput, PlaybackRoute, PlayerSnapshot, PlayerSourceInfo, PlayerTelemetry,
  PlayerTrack, PreparedPlayback, PreparePlayback, QualityMode, ReferencePlayerOptions,
  SubtitleAdapter,
  ManagedTransport, ManagedTransportSnapshot,
} from './player.js';
export { createReferencePlayer, preparePlayback, qualityTarget } from './assembly.js';
export type { ReferencePlayerFactoryOptions, RoutePreference } from './assembly.js';
export { ManagedPlayback, stereoIndexFold } from './managed.js';
export type { ManagedPlaybackOptions } from './managed.js';
export { inspectBluRayClips, isDiscImageName } from './disc-input.js';
export type { BluRayClipInput, BluRayClipChoice, LocalBluRay } from './disc-input.js';
