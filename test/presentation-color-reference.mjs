/** Scalar output reference. Keeps the pre-optimization calculation order and
 * explicit pow calls, independent of the production transfer tables. */
export function scalarToneMap(frame, { maximumHeight = frame.visibleRect.height, targetWhiteNits = 203 } = {}) {
  const { visibleRect: rect, planes, format, data: source } = frame;
  const scale = Math.min(1, maximumHeight / rect.height);
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const high = format !== 'I420P8';
  const depth = format === 'I444P16' ? 16 : high ? 10 : 8;
  const mul = 2 ** (depth - 8), max = 2 ** depth - 1;
  const limited = frame.color.range === 'limited';
  const sample = (plane, x, y) => {
    const layout = planes[plane];
    const at = layout.offsetBytes + layout.strideBytes * y + x * (high ? 2 : 1);
    return high ? source[at] + 256 * source[at + 1] : source[at];
  };
  const pq = value => {
    const power = Math.pow(Math.max(0, Math.min(1, value)), 32 / 2523);
    return 10000 * Math.pow(Math.max(power - 3424 / 4096, 0) / Math.max(2413 / 128 - (2392 / 128) * power, Number.EPSILON), 16384 / 2610);
  };
  const srgb = value => {
    const linear = Math.max(value, 0);
    return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  };
  for (let y = 0; y < height; y++) {
    const sy = rect.y + Math.min(rect.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x++) {
      const sx = rect.x + Math.min(rect.width - 1, Math.floor((x + 0.5) / scale));
      const cx = format === 'I444P16' ? sx : Math.floor(sx / 2);
      const cy = format === 'I422P10' || format === 'I444P16' ? sy : Math.floor(sy / 2);
      const yy = limited ? (sample(0, sx, sy) - 16 * mul) / (219 * mul) : sample(0, sx, sy) / max;
      const cb = (sample(1, cx, cy) - 128 * mul) / (limited ? 224 * mul : max);
      const cr = (sample(2, cx, cy) - 128 * mul) / (limited ? 224 * mul : max);
      const kr = 0.2627, kb = 0.0593;
      const r = yy + 2 * (1 - kr) * cr, b = yy + 2 * (1 - kb) * cb;
      const g = (yy - kr * r - kb * b) / (1 - kr - kb);
      const lr = pq(r) / targetWhiteNits, lg = pq(g) / targetWhiteNits, lb = pq(b) / targetWhiteNits;
      const rr = 1.660491 * lr - 0.587641 * lg - 0.07285 * lb;
      const gg = -0.12455 * lr + 1.1329 * lg - 0.008349 * lb;
      const bb = -0.018151 * lr - 0.100579 * lg + 1.11873 * lb;
      const luminance = Math.max(0, 0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
      const tone = 1 / (1 + luminance);
      const out = (y * width + x) * 4;
      data[out] = Math.round(srgb(rr * tone) * 255);
      data[out + 1] = Math.round(srgb(gg * tone) * 255);
      data[out + 2] = Math.round(srgb(bb * tone) * 255);
      data[out + 3] = 255;
    }
  }
  return { width, height, data };
}

export function compareRgba(expected, actual) {
  if (expected.length !== actual.length) throw new Error('Reference raster differs in size');
  let changed = 0, maxAbsoluteDelta = 0;
  for (let i = 0; i < expected.length; i++) {
    const delta = Math.abs(expected[i] - actual[i]);
    if (delta > 0) { changed++; maxAbsoluteDelta = Math.max(maxAbsoluteDelta, delta); }
  }
  return { scalars: expected.length, changed, maxAbsoluteDelta };
}
