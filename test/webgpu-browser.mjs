import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const sdr = { depth: 8, width: 4, height: 4, crop: { x: 1, y: 1, width: 3, height: 2 },
  y: [24, 41, 76, 97, 110, 115, 130, 140, 124, 151, 160, 170, 174, 175, 195, 213],
  u: [115, 140, 125, 156], v: [152, 114, 129, 163], center: true };
const hdr = { depth: 10, width: 5, height: 3, crop: { x: 1, y: 0, width: 4, height: 3 },
  y: [300, 718, 719, 630, 491, 527, 555, 668, 623, 650, 613, 538, 598, 728, 701],
  u: [512, 566, 480, 544, 495, 517], v: [512, 522, 577, 510, 578, 461], center: false };
const cases = [{ id: 'sdr-crop-center', source: sdr, output: 'sdr' }, { id: 'pq-linear-p3', source: hdr, output: 'hdr-candidate' },
  { id: 'pq-sdr-resized', source: hdr, output: 'sdr', cap: 2 }];

// Build RGB conversion independently from the published D65 chromaticities.
// https://www.w3.org/TR/css-color-4/#predefined
const xy = { bt709: [[.640, .330], [.300, .600], [.150, .060]],
  bt2020: [[.708, .292], [.170, .797], [.131, .046]], p3: [[.680, .320], [.265, .690], [.150, .060]] };
const mul = (m, v) => m.map(row => row.reduce((sum, x, i) => sum + x * v[i], 0));
const inverse = values => {
  const m = values.map((row, i) => [...row, ...Array(3).fill(0).map((_, j) => Number(i === j))]);
  for (let i = 0; i < 3; i++) {
    const pivot = m[i][i]; m[i] = m[i].map(x => x / pivot);
    for (let j = 0; j < 3; j++) if (j !== i) { const ratio = m[j][i]; m[j] = m[j].map((x, k) => x - ratio * m[i][k]); }
  }
  return m.map(row => row.slice(3));
};
const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const rgbBasis = name => {
  const primaries = xy[name].map(xyz);
  const m = Array.from({ length: 3 }, (_, i) => primaries.map(p => p[i]));
  const scales = mul(inverse(m), xyz([.3127, .3290]));
  return m.map(row => row.map((x, i) => x * scales[i]));
};
const convert = (from, to, rgb) => mul(inverse(rgbBasis(to)), mul(rgbBasis(from), rgb));
const clamp = (x, hi = 1) => Math.min(hi, Math.max(0, x));
const pq = code => {
  const a = clamp(code) ** (32 / 2523);
  return 10000 / 203 * (Math.max(a - 3424 / 4096, 0) / (2413 / 128 - 2392 / 128 * a)) ** (16384 / 2610);
};
const inv709 = x => x < .081 ? x / 4.5 : ((x + .099) / 1.099) ** (1 / .45);
const toSrgb = x => x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055;
function reference(fixture, width, height) {
  const { source: f, output } = fixture, pqSource = f.depth === 10;
  const cw = Math.ceil(f.width / 2), ch = Math.ceil(f.height / 2), start = f.center ? .5 : 0;
  function sampleChroma(plane, x, y) {
    const col = clamp((x - start) / 2, cw - 1), row = clamp((y - start) / 2, ch - 1);
    const x0 = Math.floor(col), x1 = Math.ceil(col), y0 = Math.floor(row), y1 = Math.ceil(row);
    const top = plane[y0 * cw + x0] * (1 - col + x0) + plane[y0 * cw + x1] * (col - x0);
    const bottom = plane[y1 * cw + x0] * (1 - col + x0) + plane[y1 * cw + x1] * (col - x0);
    return top * (1 - row + y0) + bottom * (row - y0);
  }
  const values = [];
  const scale = 2 ** (f.depth - 8), kr = pqSource ? .2627 : .2126, kb = pqSource ? .0593 : .0722, kg = 1 - kr - kb;
  for (let i = 0; i < width * height; i++) {
    const x = f.crop.x + ((i % width + .5) / width) * f.crop.width - .5;
    const y = f.crop.y + ((Math.floor(i / width) + .5) / height) * f.crop.height - .5;
    const yv = (f.y[Math.round(y) * f.width + Math.round(x)] / scale - 16) / 219;
    const u = (sampleChroma(f.u, x, y) / scale - 128) / 224, v = (sampleChroma(f.v, x, y) / scale - 128) / 224;
    const code = [yv + 2 * (1 - kr) * v, yv - (2 * kb * (1 - kb) / kg) * u - (2 * kr * (1 - kr) / kg) * v, yv + 2 * (1 - kb) * u];
    let result = code.map(pqSource ? pq : inv709);
    if (output === 'hdr-candidate') result = convert('bt2020', 'p3', result);
    else {
      if (pqSource) {
        result = convert('bt2020', 'bt709', result);
        const luma = Math.max(0, .2126 * result[0] + .7152 * result[1] + .0722 * result[2]);
        result = result.map(x => x / (1 + luma));
      }
      result = result.map(x => clamp(toSrgb(x)));
    }
    values.push(...result, 1);
  }
  return values;
}

const { outputFiles: [module] } = await build({ entryPoints: ['packages/presentation/src/webgpu-renderer.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023' });
const server = createServer((request, response) => {
  if (request.url === '/renderer.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(module.contents); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>UBVE WebGPU pixel readback</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const report = { schema: 'ubve-webgpu-pixel-readback-v1', qualification: 'NOT_QUALIFIED', cases: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.UBVE_CHROMIUM || undefined, headless: true });
  report.browser = browser.version();
  const page = await browser.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const adapter = await page.evaluate(async () => {
    const gpu = await navigator.gpu?.requestAdapter();
    return gpu ? { vendor: gpu.info.vendor, architecture: gpu.info.architecture, isFallbackAdapter: gpu.info.isFallbackAdapter } : null;
  });
  report.adapter = adapter;
  if (!adapter && process.env.UBVE_WEBGPU_OPTIONAL === '1') {
    report.status = 'NOT_RUN_NO_ADAPTER';
    console.log('WebGPU pixel readback not run: browser supplied no adapter');
  } else {
    assert.ok(adapter, 'A real WebGPU adapter is required for pixel readback');
    for (const fixture of cases) {
      const actual = await page.evaluate(async ({ source: f, output, cap }) => {
        const { WebGpuRawRenderer } = await import('/renderer.js');
        const canvas = document.createElement('canvas'), hdr = f.depth === 10, bytes = hdr ? 2 : 1;
        document.body.append(canvas);
        const data = new Uint8Array(160), view = new DataView(data.buffer);
        const planes = [{ offsetBytes: 2, strideBytes: 16, rows: f.height }, { offsetBytes: 72, strideBytes: 8, rows: Math.ceil(f.height / 2) },
          { offsetBytes: 104, strideBytes: 8, rows: Math.ceil(f.height / 2) }];
        for (const [i, values] of [f.y, f.u, f.v].entries()) {
          const w = i ? Math.ceil(f.width / 2) : f.width, p = planes[i];
          values.forEach((value, j) => {
            const at = p.offsetBytes + Math.floor(j / w) * p.strideBytes + (j % w) * bytes;
            if (hdr) view.setUint16(at, value, true); else view.setUint8(at, value);
          });
        }
        const frame = { data, planes, format: hdr ? 'I420P10' : 'I420P8', codedWidth: f.width, codedHeight: f.height, visibleRect: f.crop,
          color: { range: 'limited', transfer: hdr ? 'smpte2084' : 'bt709', matrix: hdr ? 'bt2020-ncl' : 'bt709', primaries: hdr ? 'bt2020' : 'bt709' } };
        const renderer = await WebGpuRawRenderer.create(canvas, { output, allowSdrToneMap: output === 'sdr', referenceWhiteNits: 203,
          maximumHeight: cap, chromaLocation: f.center ? 'center' : 'topleft', allowReadback: true });
        let readback;
        try {
          const { device, context } = renderer;
          device.pushErrorScope('validation');
          renderer.present(frame);
          const { width, height } = canvas, config = context.getConfiguration(), fp16 = config.format === 'rgba16float';
          readback = device.createBuffer({ size: 256 * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const copy = device.createCommandEncoder();
          copy.copyTextureToBuffer({ texture: context.getCurrentTexture() }, { buffer: readback, bytesPerRow: 256 }, [width, height]);
          device.queue.submit([copy.finish()]);
          const validation = await device.popErrorScope();
          if (validation) throw Error(validation.message);
          await readback.mapAsync(GPUMapMode.READ);
          const mapped = new DataView(readback.getMappedRange()), rgba = [];
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const at = y * 256 + x * (fp16 ? 8 : 4);
            if (fp16) for (let c = 0; c < 4; c++) rgba.push(mapped.getFloat16(at + c * 2, true));
            else for (const c of config.format.startsWith('bgra') ? [2, 1, 0, 3] : [0, 1, 2, 3]) rgba.push(mapped.getUint8(at + c) / 255);
          }
          return { width, height, rgba, format: config.format, colorSpace: config.colorSpace, toneMapping: config.toneMapping.mode };
        } finally { readback?.destroy(); await renderer.dispose(); canvas.remove(); }
      }, fixture);
      const scale = Math.min(1, (fixture.cap ?? fixture.source.crop.height) / fixture.source.crop.height);
      assert.equal(actual.width, Math.round(fixture.source.crop.width * scale));
      assert.equal(actual.height, Math.round(fixture.source.crop.height * scale));
      if (fixture.output === 'hdr-candidate') {
        assert.deepEqual([actual.format, actual.colorSpace, actual.toneMapping], ['rgba16float', 'display-p3-linear', 'extended']);
        assert.ok(Math.max(...actual.rgba) > 1.5, 'HDR channels must retain extended headroom');
      }
      const expected = reference(fixture, actual.width, actual.height), tolerance = fixture.output === 'hdr-candidate' ? .007 : 2 / 255;
      const maximumError = Math.max(...actual.rgba.map((value, i) => Math.abs(value - expected[i])));
      assert.ok(maximumError < tolerance, `${fixture.id}: maximum channel error ${maximumError} exceeds ${tolerance}`);
      report.cases.push({ id: fixture.id, ...actual, expected, maximumError });
      console.log(`${fixture.id} ${actual.width}×${actual.height} ${actual.format}, maximum channel error ${maximumError.toFixed(6)}`);
    }
    assert.deepEqual(pageErrors, []);
    report.status = 'PASSED';
  }
} catch (error) {
  report.status = 'FAILED';
  report.error = String(error);
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await mkdir('.local/webgpu-browser', { recursive: true });
  await writeFile(`.local/webgpu-browser/run-${Date.now()}-${process.pid}.json`, JSON.stringify(report, null, 2) + '\n');
}
