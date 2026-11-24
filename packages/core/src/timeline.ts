import { requireCondition } from './errors.js';

export interface TimeBase { readonly numerator: bigint; readonly denominator: bigint; }
export interface MediaTime { readonly ticks: bigint; readonly timeBase: TimeBase; }
export type Rounding = 'floor' | 'ceil' | 'toward-zero';

export function timeBase(numerator: bigint, denominator: bigint): TimeBase {
  requireCondition(numerator > 0n && denominator > 0n, 'Time-base terms must be positive');
  let a = numerator, b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return Object.freeze({ numerator: numerator / a, denominator: denominator / a });
}

/** Signed timestamps are preserved; negative priming is not clamped. */
export const mediaTime = (ticks: bigint, base: TimeBase): MediaTime => Object.freeze({ ticks, timeBase: timeBase(base.numerator, base.denominator) });

export function compareTime(a: MediaTime, b: MediaTime): -1 | 0 | 1 {
  const left = a.ticks * a.timeBase.numerator * b.timeBase.denominator;
  const right = b.ticks * b.timeBase.numerator * a.timeBase.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A rounding policy is mandatory whenever a boundary loses precision. */
export function rescale(time: MediaTime, target: TimeBase, rounding: Rounding): MediaTime {
  const base = timeBase(target.numerator, target.denominator);
  const numerator = time.ticks * time.timeBase.numerator * base.denominator;
  const denominator = time.timeBase.denominator * base.numerator;
  let ticks = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n && rounding === 'floor' && numerator < 0n) ticks--;
  if (remainder !== 0n && rounding === 'ceil' && numerator > 0n) ticks++;
  return mediaTime(ticks, base);
}
