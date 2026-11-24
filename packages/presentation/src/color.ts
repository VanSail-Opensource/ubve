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

/** Reference/fallback renderer, deliberately not advertised as 4K60. PQ output
 * uses one declared luminance-preserving Reinhard operator followed by gamut
 * clipping to sRGB. It is an explicit reduced-output transform, never full HDR. */
export function rawToRgba(frame: RawPlaneFrame, options: { readonly allowSdrToneMap?: boolean; readonly maximumHeight?: number; readonly targetWhiteNits?: number } = {}): RgbaTransform {
  validateRawFrame(frame);
  const hdr = frame.color.transfer === 'pq' || frame.color.transfer === 'smpte2084';
  if (hdr && !options.allowSdrToneMap) throw new Error('Full HDR cannot be preserved by the SDR fallback renderer');
  if (hdr && (frame.color.primaries !== 'bt2020' || frame.color.matrix !== 'bt2020-ncl')) throw new Error('PQ fallback requires explicitly declared BT.2020 nonconstant-luminance metadata');
  if (!hdr && frame.format !== 'RGBA8' && (!['bt709', 'smpte170m', 'bt470bg'].includes(frame.color.matrix ?? '')
    || !['bt709', 'smpte170m', 'iec61966-2-1', 'srgb'].includes(frame.color.transfer ?? ''))) throw new Error('Unknown SDR matrix/transfer needs an explicit interpretation');
  if (frame.format !== 'RGBA8' && frame.color.range === null) throw new Error('Raw sample range is unknown');
  const targetWhite = options.targetWhiteNits ?? 203;
  if (!Number.isFinite(targetWhite) || targetWhite < 80 || targetWhite > 500) throw new Error('Invalid SDR reference white');
  const maximumHeight = options.maximumHeight ?? frame.visibleRect.height;
  if (!Number.isSafeInteger(maximumHeight) || maximumHeight < 1) throw new Error('Invalid output raster cap');
  const scale = Math.min(1, maximumHeight / frame.visibleRect.height);
  const width = Math.max(1, Math.round(frame.visibleRect.width * scale));
  const height = Math.max(1, Math.round(frame.visibleRect.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const high = frame.format !== 'I420P8' && frame.format !== 'RGBA8';
  const depth = frame.format === 'I444P16' ? 16 : high ? 10 : 8;
  const mul = 2 ** (depth - 8);
  const max = 2 ** depth - 1;
  const sample = (plane: number, x: number, y: number): number => {
    const layout = frame.planes[plane]!;
    const at = layout.offsetBytes + layout.strideBytes * y + x * (high ? 2 : 1);
    return high ? frame.data[at]! | (frame.data[at + 1]! << 8) : frame.data[at]!;
  };
  for (let y = 0; y < height; y++) {
    const sy = frame.visibleRect.y + Math.min(frame.visibleRect.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x++) {
      const sx = frame.visibleRect.x + Math.min(frame.visibleRect.width - 1, Math.floor((x + 0.5) / scale));
      const out = (y * width + x) * 4;
      if (frame.format === 'RGBA8') {
        const start = frame.planes[0]!.offsetBytes + sy * frame.planes[0]!.strideBytes + sx * 4;
        for (let c = 0; c < 4; c++) data[out + c] = frame.data[start + c]!;
        continue;
      }
      const cx = frame.format === 'I444P16' ? sx : Math.floor(sx / 2);
      const cy = frame.format === 'I422P10' || frame.format === 'I444P16' ? sy : Math.floor(sy / 2);
      const limited = frame.color.range === 'limited';
      const yy = limited ? (sample(0, sx, sy) - 16 * mul) / (219 * mul) : sample(0, sx, sy) / max;
      const cb = (sample(1, cx, cy) - 128 * mul) / (limited ? 224 * mul : max);
      const cr = (sample(2, cx, cy) - 128 * mul) / (limited ? 224 * mul : max);
      const kr = hdr ? 0.2627 : frame.color.matrix === 'bt709' ? 0.2126 : 0.299;
      const kb = hdr ? 0.0593 : frame.color.matrix === 'bt709' ? 0.0722 : 0.114;
      let r = yy + 2 * (1 - kr) * cr;
      let b = yy + 2 * (1 - kb) * cb;
      let g = (yy - kr * r - kb * b) / (1 - kr - kb);
      if (hdr) {
        r = pqToNits(r) / targetWhite; g = pqToNits(g) / targetWhite; b = pqToNits(b) / targetWhite;
        // ITU BT.2020 RGB -> BT.709 RGB in linear light.
        const rr = 1.660491 * r - 0.587641 * g - 0.07285 * b;
        const gg = -0.12455 * r + 1.1329 * g - 0.008349 * b;
        const bb = -0.018151 * r - 0.100579 * g + 1.11873 * b;
        const luminance = Math.max(0, 0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
        const tone = 1 / (1 + luminance);
        r = linearToSrgb(rr * tone); g = linearToSrgb(gg * tone); b = linearToSrgb(bb * tone);
      }
      data[out] = Math.round(r * 255); data[out + 1] = Math.round(g * 255); data[out + 2] = Math.round(b * 255); data[out + 3] = 255;
    }
  }
  return { width, height, data, transform: hdr ? 'pq-bt2020-to-sdr' : 'sdr-bt709' };
}
