import { requireCondition } from './errors.js';

declare const offsetBrand: unique symbol;
declare const lengthBrand: unique symbol;
export type ByteOffset = number & { readonly [offsetBrand]: true };
export type ByteLength = number & { readonly [lengthBrand]: true };

function checkedNonnegativeInteger(value: number | bigint): number {
  if (typeof value === 'bigint') {
    requireCondition(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'Byte value exceeds the admitted exact Number range');
    return Number(value);
  }
  requireCondition(Number.isSafeInteger(value) && value >= 0, 'Byte value must be a nonnegative safe integer');
  return value;
}

export const byteOffset = (value: number | bigint): ByteOffset => checkedNonnegativeInteger(value) as ByteOffset;
export const byteLength = (value: number | bigint): ByteLength => checkedNonnegativeInteger(value) as ByteLength;

export interface ByteRange { readonly start: ByteOffset; readonly end: ByteOffset; }

/** Half-open [start,end). Zero-length reads are valid, including at EOF. */
export function byteRange(start: number | bigint, end: number | bigint): ByteRange {
  const checkedStart = byteOffset(start), checkedEnd = byteOffset(end);
  requireCondition(checkedEnd >= checkedStart, 'Range end precedes start');
  return Object.freeze({ start: checkedStart, end: checkedEnd });
}

export const rangeLength = (range: ByteRange): ByteLength => byteLength(BigInt(range.end) - BigInt(range.start));
export const checkedEnd = (start: ByteOffset, length: ByteLength): ByteOffset => byteOffset(BigInt(start) + BigInt(length));
