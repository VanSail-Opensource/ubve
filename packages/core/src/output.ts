import type { SessionStamp } from './epoch.js';
import type { OwnedLease } from './ownership.js';
import type { MediaTime } from './timeline.js';
import { requireCondition } from './errors.js';
import type { VideoSignalMetadata } from './metadata.js';

export interface PlaneLayout { readonly offsetBytes: number; readonly strideBytes: number; readonly rows: number; }
export interface VideoPixels {
  readonly kind: 'video';
  readonly format: 'I422P10' | 'I420P10' | 'I420P8' | 'RGBA8';
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly planes: readonly PlaneLayout[];
  readonly data: Uint8Array;
  readonly color: Readonly<{ primaries: string | null; transfer: string | null; matrix: string | null; range: 'limited' | 'full' | null }>;
  /** Source/decoder evidence, never a claim about the browser's physical output. */
  readonly signalMetadata?: VideoSignalMetadata;
}
export interface FloatAudioPCM {
  readonly kind: 'audio';
  readonly format: 'f32-interleaved' | 'f32-planar';
  readonly sampleRate: number;
  readonly frames: number;
  readonly channelLabels: readonly string[];
  readonly planes: readonly Float32Array[];
}
export interface IntegerAudioPCM {
  readonly kind: 'audio';
  readonly format: 's32-interleaved' | 's32-planar';
  readonly sampleRate: number;
  readonly frames: number;
  readonly channelLabels: readonly string[];
  readonly planes: readonly Int32Array[];
  readonly validBits: 16 | 20 | 24 | 32;
  readonly alignment: 'least-significant' | 'most-significant';
  readonly provenance: 'exact-decoder-pcm' | 'transformed-pcm';
}
export type AudioPCM = FloatAudioPCM | IntegerAudioPCM;

/** Checks storage before a renderer or transferable owner can access it. */
export function validateVideoPixels(frame: VideoPixels): void {
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  requireCondition(positive(frame.codedWidth) && positive(frame.codedHeight), 'Invalid coded geometry');
  const rect = frame.visibleRect;
  requireCondition(Number.isSafeInteger(rect.x) && Number.isSafeInteger(rect.y) && rect.x >= 0 && rect.y >= 0 && positive(rect.width) && positive(rect.height) && rect.x + rect.width <= frame.codedWidth && rect.y + rect.height <= frame.codedHeight, 'Visible rectangle exceeds coded geometry');
  const bytesPerSample = frame.format === 'I420P10' || frame.format === 'I422P10' ? 2 : 1;
  const layouts: readonly (readonly [number, number])[] = frame.format === 'RGBA8'
    ? [[frame.codedWidth * 4, frame.codedHeight]]
    : [[frame.codedWidth * bytesPerSample, frame.codedHeight],
      [Math.ceil(frame.codedWidth / 2) * bytesPerSample, frame.format === 'I422P10' ? frame.codedHeight : Math.ceil(frame.codedHeight / 2)],
      [Math.ceil(frame.codedWidth / 2) * bytesPerSample, frame.format === 'I422P10' ? frame.codedHeight : Math.ceil(frame.codedHeight / 2)]];
  requireCondition(frame.planes.length === layouts.length, 'Wrong number of video planes');
  const intervals: { start: number; end: number }[] = [];
  frame.planes.forEach((plane, index) => {
    const shape = layouts[index];
    requireCondition(shape, 'Unexpected plane');
    const [rowBytes, rows] = shape;
    const end = plane.offsetBytes + plane.strideBytes * (rows - 1) + rowBytes;
    requireCondition(Number.isSafeInteger(plane.offsetBytes) && plane.offsetBytes >= 0 && positive(plane.strideBytes) && plane.strideBytes >= rowBytes && plane.rows === rows && Number.isSafeInteger(end) && end <= frame.data.byteLength, 'Plane exceeds storage or has invalid stride/rows');
    if (bytesPerSample === 2) requireCondition(plane.offsetBytes % 2 === 0 && plane.strideBytes % 2 === 0, '10-bit planes require aligned 16-bit words');
    intervals.push({ start: plane.offsetBytes, end });
  });
  intervals.sort((a, b) => a.start - b.start);
  for (let i = 1; i < intervals.length; i++) requireCondition(intervals[i]!.start >= intervals[i - 1]!.end, 'Video planes overlap');
}

export function validateAudioPCM(pcm: AudioPCM): void {
  requireCondition(Number.isSafeInteger(pcm.sampleRate) && pcm.sampleRate > 0 && Number.isSafeInteger(pcm.frames) && pcm.frames > 0, 'Invalid audio sample geometry');
  const channels = pcm.channelLabels.length;
  requireCondition(channels > 0 && channels <= 32 && pcm.channelLabels.every(label => label.length > 0) && new Set(pcm.channelLabels).size === channels, 'Channel identities must be explicit and distinct');
  const planar = pcm.format.endsWith('-planar');
  requireCondition(pcm.planes.length === (planar ? channels : 1), 'Invalid audio plane count');
  const expected = pcm.frames * (planar ? 1 : channels);
  requireCondition(Number.isSafeInteger(expected), 'Audio sample count overflow');
  for (const plane of pcm.planes) {
    requireCondition(plane.length === expected, 'Audio plane has wrong sample count');
    requireCondition(pcm.format.startsWith('s32-') ? plane instanceof Int32Array : plane instanceof Float32Array, 'Audio storage does not match declared format');
  }
  if (pcm.format === 's32-interleaved' || pcm.format === 's32-planar') {
    requireCondition([16, 20, 24, 32].includes(pcm.validBits), 'Unsupported integer PCM precision');
    requireCondition(pcm.alignment === 'least-significant' || pcm.alignment === 'most-significant', 'PCM alignment must be explicit');
  }
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
