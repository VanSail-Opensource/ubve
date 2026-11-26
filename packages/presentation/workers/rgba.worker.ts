import { rawToRgba } from '../src/color.js';
import type { RawPlaneFrame } from '../src/color.js';

const worker = self as DedicatedWorkerGlobalScope;
worker.onmessage = ({ data }: MessageEvent<{
  id: number; frame: RawPlaneFrame; options: { allowSdrToneMap?: boolean; maximumHeight?: number };
}>) => {
  try {
    if (!Number.isSafeInteger(data.id) || !(data.frame.data instanceof Uint8Array) || data.frame.data.byteLength > 32 * 1024 ** 2) {
      throw new Error('Unadmitted frame for worker conversion');
    }
    const begin = performance.now(), rgb = rawToRgba(data.frame, data.options);
    worker.postMessage({ id: data.id, result: { ...rgb, conversionMs: performance.now() - begin } }, [rgb.data.buffer]);
  } catch (e) { worker.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) }); }
};
