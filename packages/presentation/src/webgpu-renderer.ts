import { validateRawFrame } from './color.js';
import type { RawPlaneFrame } from './color.js';
import { finite } from './pcm-output.js';

export interface WebGpuRendererOptions {
  readonly output: 'sdr' | 'hdr-candidate';
  readonly referenceWhiteNits: number;
  readonly allowSdrToneMap: boolean;
  readonly maximumHeight?: number;
  readonly chromaLocation: 'center' | 'left' | 'topleft';
}

/** Raw integer YUV textures, range/chroma reconstruction, PQ EOTF and one
 * source-to-output color operation. No bitstream decoding occurs in WebGPU.
 * This source candidate is deliberately never marked physically qualified. */
export const RAW_YUV_SHADER = /* wgsl */ `
struct Params { raster: vec4f, crop: vec4f, chroma: vec4f, color: vec4f, output: vec4f };
@group(0) @binding(0) var yPlane: texture_2d<u32>;
@group(0) @binding(1) var uPlane: texture_2d<u32>;
@group(0) @binding(2) var vPlane: texture_2d<u32>;
@group(0) @binding(3) var<uniform> p: Params;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return Vertex(vec4f(uv * 2.0 - 1.0, 0.0, 1.0), vec2f(uv.x, 1.0 - uv.y));
}
fn chromaValue(plane: texture_2d<u32>, xy: vec2f) -> f32 {
  let base = vec2i(floor(xy)); let w = fract(xy);
  let limit = vec2i(textureDimensions(plane)) - vec2i(1);
  let a = f32(textureLoad(plane, clamp(base, vec2i(0), limit), 0).r);
  let b = f32(textureLoad(plane, clamp(base + vec2i(1, 0), vec2i(0), limit), 0).r);
  let c = f32(textureLoad(plane, clamp(base + vec2i(0, 1), vec2i(0), limit), 0).r);
  let d = f32(textureLoad(plane, clamp(base + vec2i(1, 1), vec2i(0), limit), 0).r);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
fn pq(v: vec3f) -> vec3f {
  let power = pow(clamp(v, vec3f(0), vec3f(1)), vec3f(32.0 / 2523.0));
  return 10000.0 * pow(max(power - vec3f(3424.0 / 4096.0), vec3f(0)) /
    max(vec3f(2413.0 / 128.0) - vec3f(2392.0 / 128.0) * power, vec3f(1e-10)), vec3f(16384.0 / 2610.0));
}
fn decode709(v: vec3f) -> vec3f {
  return select(pow(max((v + 0.099) / 1.099, vec3f(0)), vec3f(1.0 / 0.45)), v / 4.5, v < vec3f(0.081));
}
fn srgb(v: vec3f) -> vec3f {
  let rgb = max(v, vec3f(0));
  return select(1.055 * pow(rgb, vec3f(1.0 / 2.4)) - 0.055, 12.92 * rgb, rgb <= vec3f(0.0031308));
}
fn to709(v: vec3f) -> vec3f {
  return vec3f(dot(vec3f(1.660491, -0.587641, -0.072850), v),
    dot(vec3f(-0.124550, 1.132900, -0.008349), v), dot(vec3f(-0.018151, -0.100579, 1.118730), v));
}
fn from709ToP3(v: vec3f) -> vec3f {
  return vec3f(dot(vec3f(0.8225929, 0.1775340, 0.0), v),
    dot(vec3f(0.0331995, 0.9667835, 0.0), v), dot(vec3f(0.0170854, 0.0723957, 0.9103015), v));
}
@fragment fn fragment(in: Vertex) -> @location(0) vec4f {
  let position = p.raster.zw + clamp(in.uv, vec2f(0), vec2f(0.999999)) * p.crop.xy - 0.5;
  let lumaPos = clamp(vec2i(floor(position + 0.5)), vec2i(0), vec2i(p.raster.xy) - vec2i(1));
  let chromaPos = (position - p.chroma.zw) / p.chroma.xy;
  let factor = exp2(p.crop.z - 8.0); let maximum = exp2(p.crop.z) - 1.0;
  let yRaw = f32(textureLoad(yPlane, lumaPos, 0).r);
  let y = select(yRaw / maximum, (yRaw - 16.0 * factor) / (219.0 * factor), p.crop.w > 0.5);
  let cdiv = select(maximum, 224.0 * factor, p.crop.w > 0.5);
  let cb = (chromaValue(uPlane, chromaPos) - 128.0 * factor) / cdiv;
  let cr = (chromaValue(vPlane, chromaPos) - 128.0 * factor) / cdiv;
  let r = y + 2.0 * (1.0 - p.color.x) * cr;
  let b = y + 2.0 * (1.0 - p.color.y) * cb;
  let g = (y - p.color.x * r - p.color.y * b) / (1.0 - p.color.x - p.color.y);
  var linear = decode709(vec3f(r, g, b));
  if (p.color.z > 0.5) { linear = pq(vec3f(r, g, b)) / p.output.x; }
  if (p.output.y > 0.5) { linear = to709(linear); }
  if (p.color.w > 0.5) { return vec4f(from709ToP3(linear), 1.0); }
  if (p.color.z > 0.5) {
    let luminance = max(dot(linear, vec3f(0.2126, 0.7152, 0.0722)), 0.0);
    linear = linear / (1.0 + luminance);
  }
  return vec4f(clamp(srgb(linear), vec3f(0), vec3f(1)), 1.0);
}
`;

export class WebGpuRawRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly device: GPUDevice;
  readonly options: WebGpuRendererOptions;
  readonly qualification = 'DEFERRED_NOT_QUALIFIED' as const;
  #pipeline: GPURenderPipeline;
  #uniform: GPUBuffer;
  #uniformData = new Float32Array(20);
  #textures: GPUTexture[] = [];
  #bind: GPUBindGroup | null = null;
  #shape = '';
  #disposed = false;
  #lost: string | null = null;

  private constructor(canvas: HTMLCanvasElement, context: GPUCanvasContext, device: GPUDevice,
    pipeline: GPURenderPipeline, options: WebGpuRendererOptions) {
    this.canvas = canvas; this.context = context; this.device = device; this.#pipeline = pipeline; this.options = options;
    this.#uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    void device.lost.then(info => { this.#lost = info.message || 'WebGPU device lost'; });
    device.addEventListener('uncapturederror', event => { this.#lost ??= event.error.message || 'WebGPU operation failed'; });
  }

  static async create(canvas: HTMLCanvasElement, options: WebGpuRendererOptions): Promise<WebGpuRawRenderer> {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable');
    if (!Number.isFinite(options.referenceWhiteNits) || options.referenceWhiteNits < 80 || options.referenceWhiteNits > 500) throw new Error('HDR reference white must be explicitly declared within 80–500 nits');
    if (options.maximumHeight !== undefined && (!Number.isSafeInteger(options.maximumHeight) || options.maximumHeight < 1)) throw new Error('Invalid GPU output raster cap');
    const adapter = await finite(navigator.gpu.requestAdapter(), 5_000, 'WebGPU adapter');
    if (!adapter) throw new Error('No WebGPU adapter');
    const pendingDevice = adapter.requestDevice();
    let device: GPUDevice;
    try { device = await finite(pendingDevice, 5_000, 'WebGPU device'); }
    catch (error) { void pendingDevice.then(late => late.destroy(), () => undefined); throw error; }
    let context: GPUCanvasContext | null = null;
    try {
      context = canvas.getContext('webgpu');
      if (!context) throw new Error('Canvas WebGPU context unavailable');
      const hdr = options.output === 'hdr-candidate';
      const format: GPUTextureFormat = hdr ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
      // The linear space is deliberately requested by its exact new API spelling.
      // Older/clamping implementations are rejected after getConfiguration().
      const colorSpace = hdr ? 'display-p3-linear' : 'srgb';
      context.configure({ device, format, alphaMode: 'opaque', colorSpace: colorSpace as PredefinedColorSpace,
        toneMapping: { mode: hdr ? 'extended' : 'standard' } });
      const accepted = context.getConfiguration();
      if (!accepted || accepted.format !== format || String(accepted.colorSpace) !== colorSpace
        || (hdr && accepted.toneMapping?.mode !== 'extended')) throw new Error('Requested high-precision linear HDR canvas configuration was not retained');
      const shader = device.createShaderModule({ code: RAW_YUV_SHADER, label: 'UBVE raw YUV color candidate' });
      const info = await finite(shader.getCompilationInfo(), 5_000, 'WebGPU shader compile');
      if (info.messages.some(message => message.type === 'error')) throw new Error(info.messages.filter(message => message.type === 'error').map(message => message.message).join('; '));
      const pipeline = await finite(device.createRenderPipelineAsync({ layout: 'auto',
        vertex: { module: shader, entryPoint: 'vertex' }, fragment: { module: shader, entryPoint: 'fragment', targets: [{ format }] },
        primitive: { topology: 'triangle-list' } }), 5_000, 'WebGPU render pipeline');
      return new WebGpuRawRenderer(canvas, context, device, pipeline, options);
    } catch (error) { context?.unconfigure(); device.destroy(); throw error; }
  }

  present(frame: RawPlaneFrame): { readonly output: 'sdr' | 'hdr-candidate'; readonly qualification: 'DEFERRED_NOT_QUALIFIED' } {
    if (this.#disposed || this.#lost) throw new Error(this.#lost ?? 'WebGPU renderer disposed');
    validateRawFrame(frame);
    if (!(frame.data.buffer instanceof ArrayBuffer)) throw new Error('Shared WASM planes require an owned stable handoff before GPU upload');
    if (frame.format === 'RGBA8') throw new Error('This renderer requires original planar YUV samples');
    const hdr = frame.color.transfer === 'pq' || frame.color.transfer === 'smpte2084';
    if (hdr && this.options.output === 'sdr' && !this.options.allowSdrToneMap) throw new Error('Explicit SDR tone-map consent is required');
    if (!['bt709', 'bt2020'].includes(frame.color.primaries ?? '') || !['bt709', 'bt2020-ncl'].includes(frame.color.matrix ?? '')
      || (!hdr && frame.color.transfer !== 'bt709') || frame.color.range === null) throw new Error('Unknown or unsupported raw color interpretation');
    if (hdr && (frame.color.primaries !== 'bt2020' || frame.color.matrix !== 'bt2020-ncl')) throw new Error('The HDR candidate requires PQ/BT.2020 NCL');
    const cap = this.options.maximumHeight ?? frame.visibleRect.height;
    const scale = Math.min(1, cap / frame.visibleRect.height);
    const width = Math.max(1, Math.round(frame.visibleRect.width * scale)), height = Math.max(1, Math.round(frame.visibleRect.height * scale));
    const limit = this.device.limits.maxTextureDimension2D;
    if (Math.max(width, height, frame.codedWidth, frame.codedHeight) > limit) throw new Error('Video planes or output exceed WebGPU raster limits');
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const depth = frame.format === 'I420P8' ? 8 : frame.format === 'I444P16' ? 16 : 10;
    const sx = frame.format === 'I444P16' ? 1 : 2, sy = frame.format === 'I420P8' || frame.format === 'I420P10' ? 2 : 1;
    const shape = `${frame.format}/${frame.codedWidth}/${frame.codedHeight}`;
    if (this.#shape !== shape) {
      const textures: GPUTexture[] = [];
      try {
        for (let i = 0; i < 3; i++) textures.push(this.device.createTexture({
          size: [i === 0 ? frame.codedWidth : Math.ceil(frame.codedWidth / sx), i === 0 ? frame.codedHeight : Math.ceil(frame.codedHeight / sy)],
          format: depth === 8 ? 'r8uint' : 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }));
        const bind = this.device.createBindGroup({ layout: this.#pipeline.getBindGroupLayout(0), entries: [
          ...textures.map((texture, binding) => ({ binding, resource: texture.createView() })),
          { binding: 3, resource: { buffer: this.#uniform } },
        ] });
        for (const texture of this.#textures) texture.destroy();
        this.#textures = textures; this.#bind = bind; this.#shape = shape;
      } catch (error) { for (const texture of textures) texture.destroy(); throw error; }
    }
    for (let i = 0; i < 3; i++) {
      const plane = frame.planes[i]!;
      if (depth > 8 && (plane.offsetBytes % 2 || plane.strideBytes % 2)) throw new Error('16-bit GPU plane layout requires aligned offsets and strides');
      this.device.queue.writeTexture({ texture: this.#textures[i]! }, frame.data as Uint8Array<ArrayBuffer>,
        { offset: plane.offsetBytes, bytesPerRow: plane.strideBytes, rowsPerImage: plane.rows },
        { width: i === 0 ? frame.codedWidth : Math.ceil(frame.codedWidth / sx), height: i === 0 ? frame.codedHeight : Math.ceil(frame.codedHeight / sy) });
    }
    const is2020 = frame.color.primaries === 'bt2020';
    this.#uniformData.set([frame.codedWidth, frame.codedHeight, frame.visibleRect.x, frame.visibleRect.y,
      frame.visibleRect.width, frame.visibleRect.height, depth, frame.color.range === 'limited' ? 1 : 0,
      sx, sy, this.options.chromaLocation === 'center' ? (sx - 1) / 2 : 0, this.options.chromaLocation === 'topleft' ? 0 : (sy - 1) / 2,
      frame.color.matrix === 'bt2020-ncl' ? 0.2627 : 0.2126, frame.color.matrix === 'bt2020-ncl' ? 0.0593 : 0.0722,
      hdr ? 1 : 0, this.options.output === 'hdr-candidate' ? 1 : 0, this.options.referenceWhiteNits, is2020 ? 1 : 0, 0, 0]);
    this.device.queue.writeBuffer(this.#uniform, 0, this.#uniformData);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.#pipeline); pass.setBindGroup(0, this.#bind); pass.draw(3); pass.end();
    this.device.queue.submit([encoder.finish()]);
    return { output: this.options.output, qualification: this.qualification };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return; this.#disposed = true;
    try { await finite(this.device.queue.onSubmittedWorkDone(), 1_000, 'WebGPU disposal'); }
    finally { for (const texture of this.#textures) texture.destroy(); this.#textures = []; this.#bind = null;
      this.#uniform.destroy(); this.context.unconfigure(); this.device.destroy(); }
  }
}
