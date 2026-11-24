import { rawToRgba } from './color.js';
import type { RawPlaneFrame, RgbaTransform } from './color.js';

export interface RawRendererOptions {
  readonly allowSdrToneMap?: boolean;
  readonly maximumHeight?: number;
}

/** Bounded last-frame CPU fallback. It never relabels RGBA8 as full HDR10. */
export class RawCanvasRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  #options: RawRendererOptions;
  #disposed = false;
  #submitted = 0;
  constructor(canvas: HTMLCanvasElement, options: RawRendererOptions = {}) {
    this.canvas = canvas; this.#options = options;
    const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    if (!context) throw new Error('Canvas2D presentation is unavailable');
    this.context = context;
  }
  present(frame: RawPlaneFrame): { readonly transform: RgbaTransform['transform']; readonly submitted: number; readonly cpuMs: number } {
    if (this.#disposed) throw new Error('Raw renderer is disposed');
    const started = performance.now();
    const rgba = rawToRgba(frame, this.#options);
    if (this.canvas.width !== rgba.width || this.canvas.height !== rgba.height) {
      this.canvas.width = rgba.width; this.canvas.height = rgba.height;
    }
    this.context.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
    return { transform: rgba.transform, submitted: ++this.#submitted, cpuMs: performance.now() - started };
  }
  setOptions(options: RawRendererOptions): void { this.#options = options; }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.canvas.width = this.canvas.height = 0; }
}
