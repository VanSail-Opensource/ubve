import { SUBTITLE_LIMITS } from './subtitle-input.js';

export interface PgsRectangle {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly rgba: Uint8ClampedArray; readonly forced: boolean;
}
export interface PgsDisplaySet {
  readonly ptsSeconds: number; readonly width: number; readonly height: number;
  readonly rectangles: readonly PgsRectangle[]; readonly clear: boolean;
  readonly paletteInterpretation: 'bt709-limited' | 'bt601-limited';
}
interface PgsObject { id: number; version: number; width: number; height: number; expected: number; written: number; bytes: Uint8Array; complete: boolean; }
interface Reference { id: number; window: number; x: number; y: number; forced: boolean; crop: { x: number; y: number; width: number; height: number } | null; }
interface Composition { width: number; height: number; palette: number; pts: number; references: Reference[]; }
interface Window { x: number; y: number; width: number; height: number; }

const u16 = (data: Uint8Array, at: number): number => data[at]! * 256 + data[at + 1]!;
const u24 = (data: Uint8Array, at: number): number => data[at]! * 65536 + data[at + 1]! * 256 + data[at + 2]!;
const u32 = (data: Uint8Array, at: number): number => data[at]! * 16777216 + data[at + 1]! * 65536 + data[at + 2]! * 256 + data[at + 3]!;
const requireBytes = (data: Uint8Array, count: number): void => { if (data.length < count) throw new Error('Truncated PGS segment'); };

/** The PGS run-length decoder writes one bounded object plane. Each scanline has
 * an explicit zero/zero terminator, and runs may never cross the object edge. */
export function decodePgsRle(encoded: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 4320
    || width * height > SUBTITLE_LIMITS.decodedPgsBytes / 4) throw new Error('PGS object exceeds raster budget');
  const pixels = new Uint8Array(width * height);
  let at = 0, x = 0, y = 0;
  while (at < encoded.length) {
    if (y >= height) throw new Error('PGS run data continues after the last scanline');
    const first = encoded[at++]!;
    let color = first, count = 1;
    if (first === 0) {
      if (at >= encoded.length) throw new Error('Truncated PGS RLE control');
      const flag = encoded[at++]!;
      if (flag === 0) { x = 0; y++; continue; }
      count = flag & 0x3f;
      if (flag & 0x40) { if (at >= encoded.length) throw new Error('Truncated PGS long run'); count = count * 256 + encoded[at++]!; }
      color = 0;
      if (flag & 0x80) { if (at >= encoded.length) throw new Error('Truncated PGS run color'); color = encoded[at++]!; }
      if (!count) throw new Error('Empty PGS run');
    }
    if (x + count > width) throw new Error('PGS run crosses the object scanline');
    pixels.fill(color, y * width + x, y * width + x + count); x += count;
  }
  if (y !== height || x !== 0) throw new Error('Incomplete PGS scanline program');
  return pixels;
}

/** Independent bounded TypeScript candidate; not the proposed FFmpeg subtitle
 * shim. Palette interpretation is required explicitly and remains unqualified. */
export class PgsDecoder {
  readonly paletteInterpretation: PgsDisplaySet['paletteInterpretation'];
  #palettes = new Map<number, Uint8ClampedArray>();
  #paletteDefined = new Map<number, Set<number>>();
  #objects = new Map<number, PgsObject>();
  #windows = new Map<number, Window>();
  #composition: Composition | null = null;
  #objectBytes = 0;
  #decodedBytes = 0;
  #events = 0;
  #lastPts: number | null = null;
  #ptsWrap = 0;
  #displayOpen = false;
  #lastDisplayPts = -Infinity;
  #displayAllocations = new WeakMap<PgsDisplaySet, number>();

  constructor(paletteInterpretation: PgsDisplaySet['paletteInterpretation']) { this.paletteInterpretation = paletteInterpretation; }

  reset(): void {
    this.#palettes.clear(); this.#paletteDefined.clear(); this.#objects.clear(); this.#windows.clear(); this.#composition = null;
    this.#objectBytes = this.#decodedBytes = this.#events = this.#ptsWrap = 0; this.#lastPts = null;
    this.#displayOpen = false; this.#lastDisplayPts = -Infinity; this.#displayAllocations = new WeakMap();
  }

  get retainedBitmapBytes(): number { return this.#decodedBytes; }
  get hasOpenDisplaySet(): boolean { return this.#displayOpen; }
  releaseDisplaySet(display: PgsDisplaySet): void {
    const bytes = this.#displayAllocations.get(display);
    if (bytes === undefined) return;
    this.#displayAllocations.delete(display); this.#decodedBytes -= bytes;
  }

  /** SUP files carry 32-bit 90kHz PTS. Matroska packets use the source-provided
   * seconds instead. DTS is retained by the packet provider, not used as PTS. */
  pushPacket(bytes: Uint8Array, ptsSeconds?: number): PgsDisplaySet[] {
    if (bytes.byteLength > SUBTITLE_LIMITS.pgsBytes) throw new Error('PGS packet exceeds the 32 MiB input envelope');
    const result: PgsDisplaySet[] = []; let at = 0;
    try {
      while (at < bytes.length) {
        let pts = ptsSeconds;
        if (bytes[at] === 0x50 && bytes[at + 1] === 0x47) {
          if (at + 13 > bytes.length) throw new Error('Truncated SUP header');
          const raw = u32(bytes, at + 2);
          if (this.#lastPts !== null && raw < this.#lastPts && this.#lastPts - raw > 2 ** 31) this.#ptsWrap += 2 ** 32;
          this.#lastPts = raw; pts = (this.#ptsWrap + raw) / 90000; at += 10;
        }
        if (pts === undefined || !Number.isFinite(pts) || pts < 0) throw new Error('PGS segment needs a valid presentation timestamp');
        if (at + 3 > bytes.length) throw new Error('Truncated PGS segment header');
        const type = bytes[at]!, length = u16(bytes, at + 1); at += 3;
        if (at + length > bytes.length) throw new Error('PGS segment length exceeds its packet');
        const display = this.pushSegment(type, bytes.subarray(at, at + length), pts);
        if (display) result.push(display); at += length;
      }
    } catch (error) {
      for (const display of result) this.releaseDisplaySet(display);
      throw error;
    }
    return result;
  }

  pushSegment(type: number, data: Uint8Array, ptsSeconds: number): PgsDisplaySet | null {
    if (!Number.isFinite(ptsSeconds) || ptsSeconds < 0) throw new Error('Invalid PGS timestamp');
    if (type === 0x16) this.#pcs(data, ptsSeconds);
    else if (type === 0x14) this.#pds(data);
    else if (type === 0x15) this.#ods(data);
    else if (type === 0x17) this.#wds(data);
    else if (type === 0x80) {
      if (data.length !== 0) throw new Error('PGS END has an unexpected body');
      return this.#finish();
    } else throw new Error(`Unsupported PGS segment type 0x${type.toString(16)}`);
    return null;
  }

  #pcs(data: Uint8Array, pts: number): void {
    if (this.#displayOpen) throw new Error('PGS composition began before the previous END');
    requireBytes(data, 11);
    const width = u16(data, 0), height = u16(data, 2), state = data[7]!, count = data[10]!;
    if (width < 1 || height < 1 || width > 8192 || height > 4320 || width * height * 4 > SUBTITLE_LIMITS.decodedPgsBytes
      || count > 64 || ![0, 0x40, 0x80].includes(state)) throw new Error('Invalid PGS composition or raster budget');
    const references: Reference[] = []; let at = 11;
    for (let i = 0; i < count; i++) {
      if (at + 8 > data.length) throw new Error('Truncated PGS composition object');
      const flags = data[at + 3]!;
      const ref: Reference = { id: u16(data, at), window: data[at + 2]!, x: u16(data, at + 4), y: u16(data, at + 6), forced: !!(flags & 0x40), crop: null };
      at += 8;
      if (flags & 0x80) {
        if (at + 8 > data.length) throw new Error('Truncated PGS crop');
        ref.crop = { x: u16(data, at), y: u16(data, at + 2), width: u16(data, at + 4), height: u16(data, at + 6) }; at += 8;
      }
      references.push(ref);
    }
    if (at !== data.length) throw new Error('Unexpected trailing PGS composition bytes');
    if (state === 0x80) { this.#objects.clear(); this.#palettes.clear(); this.#paletteDefined.clear(); this.#windows.clear(); this.#objectBytes = 0; }
    this.#composition = { width, height, pts, palette: data[9]!, references };
    this.#displayOpen = true;
  }

  #pds(data: Uint8Array): void {
    requireBytes(data, 2);
    if ((data.length - 2) % 5 || (data.length - 2) / 5 > 256) throw new Error('Invalid PGS palette entry length');
    const id = data[0]!;
    if (!this.#palettes.has(id) && this.#palettes.size >= 16) throw new Error('PGS palette count exceeds budget');
    const palette = this.#palettes.get(id)?.slice() ?? new Uint8ClampedArray(1024);
    const defined = this.#paletteDefined.get(id) ?? new Set<number>();
    for (let at = 2; at < data.length; at += 5) {
      const index = data[at]! * 4, y = (data[at + 1]! - 16) / 219, cr = (data[at + 2]! - 128) / 224, cb = (data[at + 3]! - 128) / 224;
      const kr = this.paletteInterpretation === 'bt709-limited' ? 0.2126 : 0.299, kb = this.paletteInterpretation === 'bt709-limited' ? 0.0722 : 0.114;
      const r = y + 2 * (1 - kr) * cr, b = y + 2 * (1 - kb) * cb, g = (y - kr * r - kb * b) / (1 - kr - kb);
      palette[index] = Math.round(r * 255); palette[index + 1] = Math.round(g * 255); palette[index + 2] = Math.round(b * 255); palette[index + 3] = data[at + 4]!;
      defined.add(data[at]!);
    }
    this.#palettes.set(id, palette);
    this.#paletteDefined.set(id, defined);
  }

  #ods(data: Uint8Array): void {
    requireBytes(data, 4);
    const id = u16(data, 0), version = data[2]!, flags = data[3]!;
    let object = this.#objects.get(id), at = 4;
    if (flags & 0x80) {
      requireBytes(data, 11); const expected = u24(data, 4) - 4, width = u16(data, 7), height = u16(data, 9);
      if (expected < 0 || expected > SUBTITLE_LIMITS.pgsBytes || width < 1 || width > 8192 || height < 1 || height > 4320
        || width * height * 4 > SUBTITLE_LIMITS.decodedPgsBytes) throw new Error('PGS object exceeds bounds');
      if (!object && this.#objects.size >= 64) throw new Error('PGS object count exceeds budget');
      const otherBytes = this.#objectBytes - (object?.bytes.length ?? 0);
      if (otherBytes + expected > SUBTITLE_LIMITS.pgsBytes) throw new Error('PGS compressed object budget exceeded');
      const chunkBytes = data.length - 11;
      if (chunkBytes > expected || ((flags & 0x40) && chunkBytes !== expected)) throw new Error('PGS first object fragment disagrees with declared size');
      object = { id, version, width, height, expected, written: 0, bytes: new Uint8Array(expected), complete: false };
      this.#objects.set(id, object); this.#objectBytes = otherBytes + expected; at = 11;
    }
    if (!object || object.version !== version || object.complete) throw new Error('PGS object continuation has no matching open object');
    if (object.written + data.length - at > object.expected) throw new Error('PGS object continuation exceeds declared size');
    if ((flags & 0x40) && object.written + data.length - at !== object.expected) throw new Error('PGS final object size mismatch');
    object.bytes.set(data.subarray(at), object.written); object.written += data.length - at;
    if (flags & 0x40) object.complete = true;
  }

  #wds(data: Uint8Array): void {
    requireBytes(data, 1); const count = data[0]!;
    if (count > 16 || data.length !== 1 + count * 9) throw new Error('Invalid PGS window definition');
    const windows = new Map<number, Window>();
    for (let i = 0; i < count; i++) {
      const at = 1 + i * 9; const w = { x: u16(data, at + 1), y: u16(data, at + 3), width: u16(data, at + 5), height: u16(data, at + 7) };
      if (!w.width || !w.height || windows.has(data[at]!)) throw new Error('Empty or duplicate PGS window'); windows.set(data[at]!, w);
    }
    this.#windows = windows;
  }

  #finish(): PgsDisplaySet {
    const composition = this.#composition;
    if (!composition || !this.#displayOpen) throw new Error('PGS END without an open composition display set');
    this.#displayOpen = false;
    if (composition.pts < this.#lastDisplayPts) throw new Error('PGS presentation time moved backward without reset');
    if (this.#events >= SUBTITLE_LIMITS.events) throw new Error('PGS display-set count exceeds budget');
    const palette = this.#palettes.get(composition.palette), defined = this.#paletteDefined.get(composition.palette), rectangles: PgsRectangle[] = [];
    let displayBytes = 0;
    for (const reference of composition.references) {
      const object = this.#objects.get(reference.id);
      if (!object?.complete || !palette) throw new Error('PGS display references missing object or palette acquisition state');
      const crop = reference.crop ?? { x: 0, y: 0, width: object.width, height: object.height };
      if (!crop.width || !crop.height || crop.x + crop.width > object.width || crop.y + crop.height > object.height) throw new Error('PGS crop exceeds object');
      const window = this.#windows.get(reference.window);
      if (!window) throw new Error('PGS display references missing window acquisition state');
      const left = Math.max(reference.x, window.x, 0), top = Math.max(reference.y, window.y, 0);
      const right = Math.min(reference.x + crop.width, window.x + window.width, composition.width);
      const bottom = Math.min(reference.y + crop.height, window.y + window.height, composition.height);
      if (right <= left || bottom <= top) continue;
      const width = right - left, height = bottom - top, bytes = width * height * 4;
      if (this.#decodedBytes + displayBytes + bytes + object.width * object.height > SUBTITLE_LIMITS.decodedPgsBytes) throw new Error('PGS decoded bitmap budget exceeded');
      const indexed = decodePgsRle(object.bytes, object.width, object.height);
      for (const color of indexed) if (!defined?.has(color)) throw new Error('PGS bitmap uses an undefined palette entry');
      const rgba = new Uint8ClampedArray(bytes); displayBytes += bytes;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = indexed[(crop.y + top - reference.y + y) * object.width + crop.x + left - reference.x + x]! * 4;
        const destination = (y * width + x) * 4;
        rgba[destination] = palette[index]!; rgba[destination + 1] = palette[index + 1]!; rgba[destination + 2] = palette[index + 2]!; rgba[destination + 3] = palette[index + 3]!;
      }
      rectangles.push({ x: left, y: top, width, height, rgba, forced: reference.forced });
    }
    const display: PgsDisplaySet = { ptsSeconds: composition.pts, width: composition.width, height: composition.height,
      rectangles, clear: rectangles.length === 0, paletteInterpretation: this.paletteInterpretation };
    this.#lastDisplayPts = composition.pts; this.#events++; this.#decodedBytes += displayBytes;
    this.#displayAllocations.set(display, displayBytes); return display;
  }
}

export function parsePgsSup(data: Uint8Array, paletteInterpretation: PgsDisplaySet['paletteInterpretation']): readonly PgsDisplaySet[] {
  if (data.byteLength > SUBTITLE_LIMITS.pgsBytes) throw new Error('PGS sidecar exceeds the 32 MiB input envelope');
  if (data.length < 13 || data[0] !== 0x50 || data[1] !== 0x47) throw new Error('PGS sidecar requires SUP segment headers');
  const decoder = new PgsDecoder(paletteInterpretation);
  const displays = decoder.pushPacket(data);
  if (!displays.length || decoder.hasOpenDisplaySet) throw new Error('PGS sidecar ends without a complete display-set boundary');
  return displays;
}
