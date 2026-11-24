import type { SessionStamp } from './epoch.js';
import type { OwnedLease } from './ownership.js';
import type { MediaTime } from './timeline.js';

export interface PlaneLayout { readonly offsetBytes: number; readonly strideBytes: number; readonly rows: number; }
export interface VideoPixels {
  readonly kind: 'video';
  readonly format: 'I422P10' | 'I420P8' | 'RGBA8';
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly planes: readonly PlaneLayout[];
  readonly data: Uint8Array;
  readonly color: Readonly<{ primaries: string | null; transfer: string | null; matrix: string | null; range: 'limited' | 'full' | null }>;
}
export interface AudioPCM {
  readonly kind: 'audio';
  readonly format: 'f32-interleaved' | 'f32-planar';
  readonly sampleRate: number;
  readonly frames: number;
  readonly channelLabels: readonly string[];
  readonly planes: readonly Float32Array[];
}

export interface OwnedOutput<Payload> {
  readonly stamp: SessionStamp;
  readonly operationId: string;
  readonly sourcePacketId: string;
  readonly pts: MediaTime;
  readonly durationTicks: bigint | null;
  readonly codecConfigEpoch: number;
  /** One lease accounts for all backing stores owned by this payload. */
  readonly payload: OwnedLease<Payload>;
}
export type DecodedOutput = OwnedOutput<VideoPixels | AudioPCM>;

export interface AudioAnchor {
  readonly stamp: SessionStamp;
  readonly graphStartFrame: bigint;
  readonly mediaStartSample: bigint;
  readonly sampleRate: number;
}

export type WorkletEvent =
  | { readonly type: 'started'; readonly anchor: AudioAnchor }
  | { readonly type: 'underrun'; readonly stamp: SessionStamp; readonly graphFrame: bigint; readonly nextExpectedMediaSample: bigint }
  | { readonly type: 'stopped'; readonly stamp: SessionStamp; readonly lastConsumedMediaSample: bigint | null };

/** Implementation contract: after the first missing active sample, the worklet
 * stops consuming and produces controlled silence until a new epoch is primed.
 * The supervisor freezes logical media, holds video, resets/prerolls, and waits
 * for a new start acknowledgement. Graph-frame count alone is not media progress.
 */
export interface RebufferIntent {
  readonly from: SessionStamp;
  readonly next: SessionStamp;
  readonly resumeMediaSample: bigint;
  readonly minimumPrimedFrames: number;
  readonly reason: 'audio-underrun' | 'render-budget';
}
export interface RebufferPolicy {
  readonly maximumRecoveries: number;
  readonly windowMs: number;
  readonly primeMs: number;
  readonly onExhaustion: 'declared-spatial-resolution-fallback' | 'render-budget-error';
}
