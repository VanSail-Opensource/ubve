import { EngineError } from './errors.js';
import type { SessionStamp } from './epoch.js';
import type { OwnedLease } from './ownership.js';
import type { SourceIdentity } from './source.js';
import { timeBase, type TimeBase } from './timeline.js';
import { rangeLength, type ByteRange } from './units.js';

export interface SourceSpan { readonly source: SourceIdentity; readonly range: ByteRange; }
export type PacketRepresentation =
  | { readonly kind: 'source-exact' }
  | { readonly kind: 'repacked'; readonly transformations: readonly string[] }
  | { readonly kind: 'opaque-adapter'; readonly reason: string };
export interface TimingProvenance {
  readonly kind: 'container-exact' | 'reconstructed' | 'api-seconds';
  /** Preserve the admitted API observation when exact container ticks are unavailable. */
  readonly originalPtsSeconds: number | null;
  readonly transformDescription: string | null;
}
export interface EncodedPacket {
  readonly id: string;
  readonly stamp: SessionStamp;
  readonly trackId: string;
  readonly codecConfigEpoch: number;
  readonly decodeSequence: number;
  /** Container-known presentation order; null if not available. */
  readonly presentationSequence: number | null;
  readonly timeBase: TimeBase;
  readonly ptsTicks: bigint;
  /** Unknown DTS remains null. Decoding order is never fabricated from PTS. */
  readonly dtsTicks: bigint | null;
  readonly durationTicks: bigint | null;
  readonly timingProvenance: TimingProvenance;
  readonly recovery: 'key' | 'delta' | 'unknown';
  readonly representation: PacketRepresentation;
  /** Original provenance spans; null when the adapter cannot expose them. */
  readonly sourceSpans: readonly SourceSpan[] | null;
  readonly bytes: OwnedLease<Uint8Array>;
}

/** Boundary validation is independent of TypeScript declarations. */
export function validatePacket(packet: EncodedPacket): void {
  const unsigned = (v: number) => Number.isSafeInteger(v) && v >= 0;
  const fail = (message: string): never => { throw new EngineError('INVALID_PACKET', message, 'caller-fix'); };
  if (!packet.id || !packet.trackId) fail('Packet and track identities are required');
  if (!unsigned(packet.codecConfigEpoch) || !unsigned(packet.decodeSequence)) fail('Invalid configuration epoch or decode sequence');
  if (packet.presentationSequence !== null && !unsigned(packet.presentationSequence)) fail('Invalid presentation sequence');
  if (typeof packet.ptsTicks !== 'bigint' || (packet.dtsTicks !== null && typeof packet.dtsTicks !== 'bigint')) fail('Timestamps must be bigint or explicit null DTS');
  if (packet.durationTicks !== null && (typeof packet.durationTicks !== 'bigint' || packet.durationTicks < 0n)) fail('Invalid duration');
  timeBase(packet.timeBase.numerator, packet.timeBase.denominator);
  if (!['key', 'delta', 'unknown'].includes(packet.recovery)) fail('Invalid recovery classification');
  if (!['container-exact', 'reconstructed', 'api-seconds'].includes(packet.timingProvenance.kind)) fail('Invalid timing provenance');
  if (packet.timingProvenance.kind === 'api-seconds' && (packet.timingProvenance.originalPtsSeconds === null || !Number.isFinite(packet.timingProvenance.originalPtsSeconds))) fail('API-seconds timing must retain the finite original PTS observation');
  let spannedBytes = 0n;
  for (const span of packet.sourceSpans ?? []) spannedBytes += BigInt(rangeLength(span.range));
  if (packet.representation.kind === 'source-exact') {
    if (packet.sourceSpans === null || spannedBytes !== BigInt(packet.bytes.borrow().byteLength)) fail('Source-exact spans must describe the encoded payload exactly');
  } else if (packet.representation.kind === 'repacked') {
    if (!packet.representation.transformations.length || packet.representation.transformations.some(t => !t)) fail('Repacked payload requires transformation provenance');
  } else if (packet.representation.kind === 'opaque-adapter') {
    if (!packet.representation.reason) fail('Opaque adapter payload requires its limitation');
  } else fail('Invalid payload representation');
}
