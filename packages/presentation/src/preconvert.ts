import { BudgetLedger, EngineError, OwnedLease, byteLength } from '@ubve/core';
import { validateRawFrame } from './color.js';
import type { RawPlaneFrame, RgbaTransform } from './color.js';
import type { RawRendererOptions } from './raw-renderer.js';

export interface ConvertedFrame extends RgbaTransform { readonly conversionMs: number }

/** One optional conversion slot. Credit covers the copied input and returned
 * raster. The receiver releases the slot after the upload or epoch retirement. */
export class CanvasPreconverter {
  readonly #url: URL;
  readonly #ledger = new BudgetLedger({ bytes: byteLength(64 * 1024 ** 2), items: 1, maxSingleItemBytes: byteLength(64 * 1024 ** 2) });
  #worker: Worker | null = null;
  #stop: ((error: unknown) => void) | null = null;
  #sequence = 0;
  constructor(assetBaseUrl: string) { this.#url = new URL('ubve/rgba-worker.js', new URL(assetBaseUrl, location.href)); }
  get bytes(): number { return this.#ledger.snapshot().bytes; }
  prepare(frame: RawPlaneFrame, options: RawRendererOptions, signal: AbortSignal): Promise<OwnedLease<ConvertedFrame>> {
    signal.throwIfAborted(); validateRawFrame(frame);
    const scale = Math.min(1, (options.maximumHeight ?? frame.visibleRect.height) / frame.visibleRect.height);
    const width = Math.max(1, Math.round(frame.visibleRect.width * scale)), height = Math.max(1, Math.round(frame.visibleRect.height * scale));
    const bytes = width * height * 4;
    const credit = this.#ledger.tryReserve(byteLength(frame.data.byteLength + bytes));
    if (!credit) return Promise.reject(new EngineError('BACKPRESSURE', 'One-frame conversion credit is unavailable'));
    let worker: Worker;
    try { worker = this.#worker ??= new Worker(this.#url, { type: 'module', name: 'ubve-rgba-prefetch' }); }
    catch (error) { credit.release(); return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.#stop = null; worker.onmessage = worker.onerror = worker.onmessageerror = null; };
      const fail = (error: unknown) => {
        clear(); this.#worker = null; worker.terminate(); credit.release(); reject(error);
      };
      const abort = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new EngineError('DEADLINE_EXCEEDED', 'Prefetched conversion did not complete')), 5000);
      this.#stop = fail;
      worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: ConvertedFrame; error?: string }>) => {
        const converted = data.result;
        if (data.id !== id || !converted || converted.width !== width || converted.height !== height ||
          !(converted.data instanceof Uint8ClampedArray) || converted.data.byteLength !== bytes ||
          !['sdr-bt709', 'pq-bt2020-to-sdr'].includes(converted.transform) ||
          !Number.isFinite(converted.conversionMs) || converted.conversionMs < 0) {
          fail(new EngineError('OUTPUT_UNAVAILABLE', data.error ?? 'Invalid prefetched raster')); return;
        }
        try { const lease = OwnedLease.adopt(credit, converted); clear(); resolve(lease); }
        catch (error) { fail(error); }
      };
      worker.onerror = () => fail(new EngineError('OUTPUT_UNAVAILABLE', 'Canvas conversion worker failed'));
      worker.onmessageerror = () => fail(new EngineError('OUTPUT_UNAVAILABLE', 'Canvas conversion worker returned an invalid message'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        const data = frame.data.slice();
        worker.postMessage({ id, frame: { ...frame, data }, options }, [data.buffer]);
      } catch (error) { fail(error); }
    });
  }
  cancel(): void {
    if (this.#stop) this.#stop(new EngineError('CANCELLED', 'Canvas conversion retired'));
    else { this.#worker?.terminate(); this.#worker = null; }
  }
}
