export interface RawPlaneFrame {
  readonly format: 'I420P8' | 'I420P10' | 'I422P10' | 'I444P16' | 'RGBA8';
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly planes: readonly Readonly<{ offsetBytes: number; strideBytes: number; rows: number }>[];
  readonly data: Uint8Array;
  readonly color: Readonly<{ primaries: string | null; transfer: string | null; matrix: string | null; range: 'limited' | 'full' | null }>;
}

export function pqToNits(value: number): number {
  const m1 = 2610 / 16384, m2 = 2523 / 32, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128;
  const p = Math.pow(Math.max(0, Math.min(1, value)), 1 / m2);
  return 10000 * Math.pow(Math.max(p - c1, 0) / Math.max(c2 - c3 * p, Number.EPSILON), 1 / m1);
}

export function nitsToPq(nits: number): number {
  const m1 = 2610 / 16384, m2 = 2523 / 32, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128;
  const p = Math.pow(Math.max(0, Math.min(10000, nits)) / 10000, m1);
  return Math.pow((c1 + c2 * p) / (1 + c3 * p), m2);
}

export function linearToSrgb(value: number): number {
  const v = Math.max(0, value);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function validateRawFrame(frame: RawPlaneFrame): void {
  const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
  if (!integer(frame.codedWidth) || !integer(frame.codedHeight) || frame.codedWidth < 1 || frame.codedHeight < 1
    || frame.codedWidth > 8192 || frame.codedHeight > 8192) throw new Error('Raw raster is outside the 8192-pixel renderer envelope');
  const r = frame.visibleRect;
  if (![r.x, r.y, r.width, r.height].every(integer) || r.width < 1 || r.height < 1
    || r.x + r.width > frame.codedWidth || r.y + r.height > frame.codedHeight) throw new Error('Invalid visible rectangle');
  const count = frame.format === 'RGBA8' ? 1 : 3;
  if (frame.planes.length !== count) throw new Error('Unexpected raw plane count');
  const bytes = frame.format === 'I420P8' ? 1 : frame.format === 'RGBA8' ? 4 : 2;
  for (let i = 0; i < count; i++) {
    const plane = frame.planes[i]!;
    const width = i === 0 || frame.format === 'I444P16' ? frame.codedWidth : Math.ceil(frame.codedWidth / 2);
    const height = i === 0 || frame.format === 'I422P10' || frame.format === 'I444P16' ? frame.codedHeight : Math.ceil(frame.codedHeight / 2);
    if (![plane.offsetBytes, plane.strideBytes, plane.rows].every(integer) || plane.strideBytes < width * bytes || plane.rows < height) throw new Error('Invalid raw plane stride/rows');
    const end = plane.offsetBytes + (height - 1) * plane.strideBytes + width * bytes;
    if (!Number.isSafeInteger(end) || end > frame.data.byteLength) throw new Error('Raw plane exceeds its owned buffer');
  }
}

export interface RgbaTransform {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly transform: 'sdr-bt709' | 'pq-bt2020-to-sdr';
}

// Uniform Float64 transfer tables replace the nonlinear per-pixel power calls.
// The scalar ST2084/sRGB functions above remain the reference. Interpolation
// affects only explicitly reduced RGB8 output, not source planes or HDR routes.
const TRANSFER_STEPS = 8192;
let pqTable: Float64Array | undefined;
let srgb8Table: Float64Array | undefined;
function transferTable(transform: (value: number) => number): Float64Array {
  return Float64Array.from({ length: TRANSFER_STEPS + 1 }, (_, i) => transform(i / TRANSFER_STEPS));
}
function sampleTransfer(table: Float64Array, value: number): number {
  if (value <= 0) return table[0]!;
  if (value >= 1) return table[TRANSFER_STEPS]!;
  const position = value * TRANSFER_STEPS;
  const index = Math.floor(position), low = table[index]!;
  return low + (table[index + 1]! - low) * (position - index);
}

const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
const tenBitValues = 1024;
interface Sdr10Tables {
  readonly y: Float64Array;
  readonly b: Float64Array;
  readonly r: Float64Array;
  readonly yOffset: number;
  readonly yDiv: number;
  readonly cDiv: number;
  readonly kr: number;
  readonly kb: number;
  readonly kbInv: number;
  readonly krInv: number;
  readonly kg: number;
}
// Two admitted coefficient sets and two sample ranges, bounded for process
// lifetime. Preserve the legacy Float64 operation order at each sample value.
const sdr10Tables = new Map<number, Sdr10Tables>();
function sdr10Lookup(bt709: boolean, limited: boolean): Sdr10Tables {
  const key = (bt709 ? 2 : 0) + (limited ? 1 : 0);
  const found = sdr10Tables.get(key);
  if (found) return found;
  const kr = bt709 ? 0.2126 : 0.299, kb = bt709 ? 0.0722 : 0.114;
  const kg = 1 - kr - kb, krInv = 2 * (1 - kr), kbInv = 2 * (1 - kb);
  const yOffset = limited ? 64 : 0, yDiv = limited ? 876 : 1023, cDiv = limited ? 896 : 1023;
  const y = Float64Array.from({ length: tenBitValues }, (_, value) => (value - yOffset) / yDiv);
  const b = Float64Array.from({ length: tenBitValues }, (_, value) => kbInv * ((value - 512) / cDiv));
  const r = Float64Array.from({ length: tenBitValues }, (_, value) => krInv * ((value - 512) / cDiv));
  const tables = { y, b, r, yOffset, yDiv, cDiv, kr, kb, kbInv, krInv, kg };
  sdr10Tables.set(key, tables);
  return tables;
}

function quantizeRgb8(value: number): number {
  const rounded = Math.round(value * 255);
  return rounded <= 0 ? 0 : rounded >= 255 ? 255 : rounded;
}

function convertSdrI420P10(frame: RawPlaneFrame, width: number, height: number, scale: number,
  sourceX: Uint16Array | null, data: Uint8ClampedArray<ArrayBuffer>): boolean {
  if (!littleEndian || frame.data.byteOffset % 2 || data.byteOffset % 4
    || frame.planes.some(plane => plane.offsetBytes % 2 || plane.strideBytes % 2)) return false;
  const source = new Uint16Array(frame.data.buffer, frame.data.byteOffset, Math.floor(frame.data.byteLength / 2));
  const output = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  const rect = frame.visibleRect, yPlane = frame.planes[0]!, uPlane = frame.planes[1]!, vPlane = frame.planes[2]!;
  const { y: luma, b: cb, r: cr, yOffset, yDiv, cDiv, kr, kb, kbInv, krInv, kg } = sdr10Lookup(frame.color.matrix === 'bt709', frame.color.range === 'limited');
  const yStride = yPlane.strideBytes / 2, uStride = uPlane.strideBytes / 2, vStride = vPlane.strideBytes / 2;
  const yStart = yPlane.offsetBytes / 2, uStart = uPlane.offsetBytes / 2, vStart = vPlane.offsetBytes / 2;
  for (let y = 0; y < height; y++) {
    const sy = rect.y + Math.min(rect.height - 1, Math.floor((y + 0.5) / scale)), cy = Math.floor(sy / 2);
    const yRow = yStart + yStride * sy, uRow = uStart + uStride * cy, vRow = vStart + vStride * cy;
    let out = y * width, lastCx = -1, bOffset = 0, rOffset = 0;
    for (let x = 0; x < width; x++) {
      const sx = sourceX === null ? rect.x + x : sourceX[x]!, cx = Math.floor(sx / 2);
      if (cx !== lastCx) {
        const u = source[uRow + cx]!, v = source[vRow + cx]!;
        // Unexpected upper bits retain the generic renderer's behavior. They
        // are not truncated or indexed out of range by the lookup tables.
        bOffset = u < tenBitValues ? cb[u]! : kbInv * ((u - 512) / cDiv);
        rOffset = v < tenBitValues ? cr[v]! : krInv * ((v - 512) / cDiv);
        lastCx = cx;
      }
      const sample = source[yRow + sx]!;
      const yy = sample < tenBitValues ? luma[sample]! : (sample - yOffset) / yDiv;
      const r = yy + rOffset, b = yy + bOffset, g = (yy - kr * r - kb * b) / kg;
      // Bitwise operations apply only to packed color bytes, not offsets.
      output[out++] = 0xff000000 | (quantizeRgb8(b) << 16) | (quantizeRgb8(g) << 8) | quantizeRgb8(r);
    }
  }
  return true;
}

/** Bounded CPU fallback. PQ output uses a declared luminance-preserving
 * Reinhard operator followed by clipping/quantization to sRGB. Transfer table
 * interpolation is an RGB8 approximation and is never used for full HDR. The
 * optional reuse buffer is caller-owned and overwritten only if it fits. */
export function rawToRgba(frame: RawPlaneFrame, options: { readonly allowSdrToneMap?: boolean; readonly maximumHeight?: number; readonly targetWhiteNits?: number } = {},
  reuse?: Uint8ClampedArray<ArrayBuffer>): RgbaTransform {
  validateRawFrame(frame);
  const rect = frame.visibleRect, format = frame.format;
  const hdr = frame.color.transfer === 'pq' || frame.color.transfer === 'smpte2084';
  if (hdr && !options.allowSdrToneMap) throw new Error('Full HDR cannot be preserved by the SDR fallback renderer');
  if (hdr && (format === 'RGBA8' || frame.color.primaries !== 'bt2020' || frame.color.matrix !== 'bt2020-ncl')) throw new Error('PQ fallback requires planar samples with explicitly declared BT.2020 nonconstant-luminance metadata');
  if (!hdr && format !== 'RGBA8' && (!['bt709', 'smpte170m', 'bt470bg'].includes(frame.color.matrix ?? '')
    || !['bt709', 'smpte170m', 'iec61966-2-1', 'srgb'].includes(frame.color.transfer ?? ''))) throw new Error('Unknown SDR matrix/transfer needs an explicit interpretation');
  if (format !== 'RGBA8' && frame.color.range === null) throw new Error('Raw sample range is unknown');
  const targetWhite = options.targetWhiteNits ?? 203;
  if (!Number.isFinite(targetWhite) || targetWhite < 80 || targetWhite > 500) throw new Error('Invalid SDR reference white');
  const maximumHeight = options.maximumHeight ?? rect.height;
  if (!Number.isSafeInteger(maximumHeight) || maximumHeight < 1) throw new Error('Invalid output raster cap');
  const scale = Math.min(1, maximumHeight / rect.height);
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const size = width * height * 4;
  const data = reuse?.byteLength === size && reuse.buffer !== frame.data.buffer ? reuse : new Uint8ClampedArray(size);
  const src = frame.data, yPlane = frame.planes[0]!;
  const sourceX = scale === 1 ? null : Uint16Array.from({ length: width }, (_, x) => rect.x + Math.min(rect.width - 1, Math.floor((x + 0.5) / scale)));

  if (format === 'RGBA8') {
    for (let y = 0; y < height; y++) {
      const sy = rect.y + Math.min(rect.height - 1, Math.floor((y + 0.5) / scale));
      const row = yPlane.offsetBytes + yPlane.strideBytes * sy;
      let out = y * width * 4;
      if (sourceX === null) data.set(src.subarray(row + rect.x * 4, row + (rect.x + width) * 4), out);
      else for (let x = 0; x < width; x++) {
        const at = row + sourceX[x]! * 4;
        data[out++] = src[at]!; data[out++] = src[at + 1]!; data[out++] = src[at + 2]!; data[out++] = src[at + 3]!;
      }
    }
    return { width, height, data, transform: 'sdr-bt709' };
  }

  if (!hdr && format === 'I420P10' && convertSdrI420P10(frame, width, height, scale, sourceX, data)) {
    return { width, height, data, transform: 'sdr-bt709' };
  }

  const high = format !== 'I420P8', fullChromaWidth = format === 'I444P16';
  const halfChromaHeight = format === 'I420P8' || format === 'I420P10';
  const depth = fullChromaWidth ? 16 : high ? 10 : 8;
  const mul = 2 ** (depth - 8), max = 2 ** depth - 1, limited = frame.color.range === 'limited';
  const sampleBytes = high ? 2 : 1;
  const yOffset = limited ? 16 * mul : 0, chromaOffset = 128 * mul;
  const yDiv = limited ? 219 * mul : max, cDiv = limited ? 224 * mul : max;
  const kr = hdr ? 0.2627 : frame.color.matrix === 'bt709' ? 0.2126 : 0.299;
  const kb = hdr ? 0.0593 : frame.color.matrix === 'bt709' ? 0.0722 : 0.114;
  const kg = 1 - kr - kb, crGain = 2 * (1 - kr), cbGain = 2 * (1 - kb);
  const uPlane = frame.planes[1]!, vPlane = frame.planes[2]!;
  const toNits = hdr ? (pqTable ??= transferTable(pqToNits)) : null;
  const toSrgb8 = hdr ? (srgb8Table ??= transferTable(value => linearToSrgb(value) * 255)) : null;
  for (let y = 0; y < height; y++) {
    const sy = rect.y + Math.min(rect.height - 1, Math.floor((y + 0.5) / scale));
    const cy = halfChromaHeight ? Math.floor(sy / 2) : sy;
    const yRow = yPlane.offsetBytes + yPlane.strideBytes * sy;
    const uRow = uPlane.offsetBytes + uPlane.strideBytes * cy;
    const vRow = vPlane.offsetBytes + vPlane.strideBytes * cy;
    let out = y * width * 4;
    for (let x = 0; x < width; x++) {
      const sx = sourceX === null ? rect.x + x : sourceX[x]!;
      const cxBytes = (fullChromaWidth ? sx : Math.floor(sx / 2)) * sampleBytes;
      const ya = yRow + sx * sampleBytes, ua = uRow + cxBytes, va = vRow + cxBytes;
      // Both sample bytes are significant. Offsets remain checked Number
      // arithmetic; only individual 16-bit little-endian samples use shifts.
      const ySample = high ? src[ya]! | (src[ya + 1]! << 8) : src[ya]!;
      const uSample = high ? src[ua]! | (src[ua + 1]! << 8) : src[ua]!;
      const vSample = high ? src[va]! | (src[va + 1]! << 8) : src[va]!;
      const yy = (ySample - yOffset) / yDiv, cb = (uSample - chromaOffset) / cDiv, cr = (vSample - chromaOffset) / cDiv;
      let r = yy + crGain * cr, b = yy + cbGain * cb;
      let g = (yy - kr * r - kb * b) / kg;
      if (toNits && toSrgb8) {
        r = sampleTransfer(toNits, r) / targetWhite;
        g = sampleTransfer(toNits, g) / targetWhite;
        b = sampleTransfer(toNits, b) / targetWhite;
        // ITU BT.2020 RGB -> BT.709 RGB in linear light.
        const rr = 1.660491 * r - 0.587641 * g - 0.07285 * b;
        const gg = -0.12455 * r + 1.1329 * g - 0.008349 * b;
        const bb = -0.018151 * r - 0.100579 * g + 1.11873 * b;
        const luminance = Math.max(0, 0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
        const tone = 1 / (1 + luminance);
        data[out++] = Math.round(sampleTransfer(toSrgb8, rr * tone));
        data[out++] = Math.round(sampleTransfer(toSrgb8, gg * tone));
        data[out++] = Math.round(sampleTransfer(toSrgb8, bb * tone));
      } else {
        data[out++] = Math.round(r * 255); data[out++] = Math.round(g * 255); data[out++] = Math.round(b * 255);
      }
      data[out++] = 255;
    }
  }
  return { width, height, data, transform: hdr ? 'pq-bt2020-to-sdr' : 'sdr-bt709' };
}
