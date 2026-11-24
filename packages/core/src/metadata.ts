import { requireCondition } from './errors.js';
import type { MediaTime } from './timeline.js';

/** The original carrier is retained. An unknown value is never filled from a filename. */
export type MetadataOrigin = 'container' | 'bitstream' | 'decoder' | 'browser-api' | 'explicit-policy';
export type MetadataValue<T> =
  | { readonly state: 'known'; readonly value: T; readonly origin: MetadataOrigin }
  | { readonly state: 'unknown'; readonly reason: string }
  | { readonly state: 'conflict'; readonly observations: readonly { readonly value: T; readonly origin: MetadataOrigin }[] };

export interface ExactRational { readonly numerator: bigint; readonly denominator: bigint; }
export interface Chromaticity { readonly x: ExactRational; readonly y: ExactRational; }
export interface MasteringDisplay {
  readonly red: Chromaticity;
  readonly green: Chromaticity;
  readonly blue: Chromaticity;
  readonly white: Chromaticity;
  /** cd/m². Both values preserve the carrier's rational representation. */
  readonly minimumLuminance: ExactRational;
  readonly maximumLuminance: ExactRational;
}
export interface ContentLightLevel {
  /** cd/m²; a carrier's unspecified zero must be represented as null. */
  readonly maximumContentLightLevel: number | null;
  readonly maximumFrameAverageLightLevel: number | null;
}
export interface VideoSignalMetadata {
  readonly epoch: number;
  readonly bitDepth: MetadataValue<number>;
  readonly chromaSubsampling: MetadataValue<'420' | '422' | '444' | 'monochrome'>;
  readonly primaries: MetadataValue<string>;
  readonly transfer: MetadataValue<string>;
  readonly matrix: MetadataValue<string>;
  readonly range: MetadataValue<'limited' | 'full'>;
  readonly chromaLocation: MetadataValue<string>;
  readonly masteringDisplay: MetadataValue<MasteringDisplay>;
  readonly contentLightLevel: MetadataValue<ContentLightLevel>;
}

export const knownMetadata = <T>(value: T, origin: MetadataOrigin): MetadataValue<T> => Object.freeze({ state: 'known', value, origin });
export const unknownMetadata = <T>(reason: string): MetadataValue<T> => {
  requireCondition(reason.length > 0, 'Unknown metadata needs a reason');
  return Object.freeze({ state: 'unknown', reason });
};

export function mergeMetadata<T>(left: MetadataValue<T>, right: MetadataValue<T>, equal: (a: T, b: T) => boolean): MetadataValue<T> {
  if (left.state === 'unknown') return right;
  if (right.state === 'unknown') return left;
  const observations = [
    ...(left.state === 'known' ? [{ value: left.value, origin: left.origin }] : left.observations),
    ...(right.state === 'known' ? [{ value: right.value, origin: right.origin }] : right.observations),
  ];
  const first = observations[0];
  requireCondition(first, 'Conflicting metadata needs observations');
  if (observations.every(item => equal(first.value, item.value))) return knownMetadata(first.value, first.origin);
  return Object.freeze({ state: 'conflict', observations: Object.freeze(observations) });
}

export function validateMasteringDisplay(value: MasteringDisplay): void {
  const rational = (v: ExactRational) => requireCondition(typeof v.numerator === 'bigint' && typeof v.denominator === 'bigint' && v.denominator > 0n && v.numerator >= 0n, 'Invalid nonnegative HDR rational');
  for (const point of [value.red, value.green, value.blue, value.white]) {
    rational(point.x); rational(point.y);
    requireCondition(point.x.numerator <= point.x.denominator && point.y.numerator <= point.y.denominator, 'Chromaticity is outside [0,1]');
  }
  rational(value.minimumLuminance); rational(value.maximumLuminance);
  requireCondition(value.maximumLuminance.numerator > 0n, 'Mastering peak must be positive');
  requireCondition(value.minimumLuminance.numerator * value.maximumLuminance.denominator <= value.maximumLuminance.numerator * value.minimumLuminance.denominator, 'Mastering luminance bounds are reversed');
}

/** Signal-metadata admission only. It makes no decoder, display, or performance claim. */
export function assessPrimaryHdr10(metadata: VideoSignalMetadata): { readonly admitted: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  requireCondition(Number.isSafeInteger(metadata.epoch) && metadata.epoch >= 0, 'Invalid metadata epoch');
  const check = <T>(name: string, value: MetadataValue<T>, accepts: (v: T) => boolean) => {
    if (value.state !== 'known') reasons.push(`${name}: ${value.state}`);
    else if (!accepts(value.value)) reasons.push(`${name}: outside primary HDR10 profile`);
  };
  check('bitDepth', metadata.bitDepth, value => value === 10);
  check('chromaSubsampling', metadata.chromaSubsampling, value => value === '420');
  check('primaries', metadata.primaries, value => value === 'bt2020');
  check('transfer', metadata.transfer, value => value === 'smpte2084');
  check('matrix', metadata.matrix, value => value === 'bt2020-ncl');
  check('range', metadata.range, value => value === 'limited' || value === 'full');
  check('chromaLocation', metadata.chromaLocation, value => value.length > 0);
  if (metadata.masteringDisplay.state !== 'known') reasons.push(`masteringDisplay: ${metadata.masteringDisplay.state}`);
  else { try { validateMasteringDisplay(metadata.masteringDisplay.value); } catch { reasons.push('masteringDisplay: invalid'); } }
  check('contentLightLevel', metadata.contentLightLevel, value =>
    value.maximumContentLightLevel !== null && value.maximumFrameAverageLightLevel !== null &&
    Number.isSafeInteger(value.maximumContentLightLevel) && Number.isSafeInteger(value.maximumFrameAverageLightLevel) &&
    value.maximumContentLightLevel > 0 && value.maximumFrameAverageLightLevel > 0 &&
    value.maximumFrameAverageLightLevel <= value.maximumContentLightLevel);
  return Object.freeze({ admitted: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export type SpeakerLabel = 'FL' | 'FR' | 'FC' | 'LFE' | 'BL' | 'BR' | 'SL' | 'SR' | 'BC' | 'FLC' | 'FRC' | 'TC' | 'TFL' | 'TFC' | 'TFR' | 'TBL' | 'TBC' | 'TBR';
export interface AudioSignalMetadata {
  readonly epoch: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly channelOrder: MetadataValue<readonly SpeakerLabel[]>;
  readonly validBits: MetadataValue<number>;
  readonly objectAudio: 'absent' | 'present-unrendered' | 'unknown';
}
export interface SubtitleTrackMetadata {
  readonly id: string;
  readonly format: 'webvtt' | 'srt' | 'ass' | 'ssa' | 'pgs' | 'ttml' | 'imsc' | 'unknown';
  readonly language: string | null;
  readonly label: string | null;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  readonly metadataEpoch: number;
}
export interface SubtitleCueTiming {
  readonly id: string;
  readonly trackId: string;
  readonly start: MediaTime;
  readonly end: MediaTime | null;
  readonly timing: 'container-exact' | 'text-exact' | 'api-seconds';
  readonly metadataEpoch: number;
}
export interface FontAttachmentMetadata {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string | null;
  readonly source: 'container-attachment' | 'user-selected' | 'bundled';
}
export type PlaybackQuality = 'full' | 'performance';
export type PresentationMode = 'inline' | 'container-fullscreen' | 'video-fullscreen' | 'picture-in-picture';
export type EvidenceState = 'UNTESTED' | 'API_ADMITTED' | 'COMPONENT_VERIFIED' | 'QUALIFIED' | 'REFUSED' | 'FAILED' | 'DEFERRED_NOT_QUALIFIED';
export interface OutputAdmission {
  readonly mode: PresentationMode;
  readonly color: 'native-hdr10-unverified' | 'hdr10-verified' | 'sdr-source' | 'explicit-sdr-tone-map';
  readonly audio: 'native-unverified' | 'pcm-float-output' | 'lossless-flac-bridge' | 'none';
  readonly subtitleSemantics: 'complete-for-selected-profile' | 'unverified' | 'unavailable';
  readonly evidence: EvidenceState;
  readonly limitations: readonly string[];
}
