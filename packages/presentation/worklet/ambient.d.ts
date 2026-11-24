interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown, transfer?: ArrayBuffer[]): void;
  start(): void;
  close(): void;
}
declare abstract class AudioWorkletProcessor {
  readonly port: WorkletPort;
  constructor(options?: unknown);
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
