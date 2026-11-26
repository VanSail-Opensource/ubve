export type PortableKind = 'video' | 'audio';
export const CODEC_AGAIN = 0, CODEC_OK = 1, CODEC_EOF = 2;
export const NO_TIMESTAMP = -(2n ** 63n);
export interface PortableOpen {
  readonly kind: PortableKind;
  readonly decoder: string;
  readonly description: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly tb: readonly [number, number];
}
export interface PortablePacket {
  readonly data: Uint8Array;
  readonly token: number;
  readonly pts: bigint;
  readonly dts: bigint;
  readonly duration: bigint;
  readonly key: boolean;
}
export interface PortableHeader {
  readonly bytes: number;
  readonly shape: readonly number[];
  readonly pts: bigint;
  readonly duration: bigint;
}
export interface PortableStep {
  readonly accepted: boolean;
  readonly eof: boolean;
  readonly output: PortableHeader | null;
}
export interface PortableTaken {
  readonly data: ArrayBuffer;
  readonly output: PortableHeader | null;
  readonly eof: boolean;
}
