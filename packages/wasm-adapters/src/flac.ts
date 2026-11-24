import { EngineError } from '@ubve/core';
import { CodecWorkerClient } from './worker-client.js';
import type { IntegerPcmBlock } from './truehd.js';

export interface FlacPacket { readonly data: Uint8Array; readonly firstSample: number; readonly frames: number; }
export class FlacPacketEncoder {
  readonly sampleRate: number; readonly channels: number; readonly description: Uint8Array;
  #worker: CodecWorkerClient; #context: number; #nextSample: number | null = null; #inputEnd: number | null = null; #closed = false;
  private constructor(worker: CodecWorkerClient, context: number, description: Uint8Array, sampleRate: number, channels: number) { this.#worker = worker; this.#context = context; this.description = description; this.sampleRate = sampleRate; this.channels = channels; }
  static async create(options: { sampleRate: number; channels: number; assetBaseUrl?: string }): Promise<FlacPacketEncoder> {
    const worker = new CodecWorkerClient(new URL('flac.worker.js', new URL(options.assetBaseUrl ?? '/vendor/', globalThis.location?.href ?? 'http://localhost/')));
    try { const result = await worker.call<{ ctx: number; header: ArrayBuffer }>('init', { numberOfChannels: options.channels, sampleRate: options.sampleRate, bitsPerSample: 24 }, [], 10000); return new FlacPacketEncoder(worker, result.ctx, new Uint8Array(result.header), options.sampleRate, options.channels); }
    catch (error) { worker.terminate(); throw error; }
  }
  async encode(block: IntegerPcmBlock): Promise<FlacPacket[]> {
    if (this.#closed) throw new EngineError('DISPOSED', 'FLAC encoder closed');
    if (block.sampleRate !== this.sampleRate || block.channels !== this.channels || block.frames < 1 || block.frames > 8192 || block.data.length !== block.frames * block.channels) throw new EngineError('INVALID_ARGUMENT', 'Invalid FLAC PCM batch');
    if (this.#inputEnd !== null && this.#inputEnd !== block.firstSample) throw new EngineError('UNSUPPORTED_PROFILE', 'Lossless bridge cannot flatten an audio gap');
    this.#nextSample ??= block.firstSample; this.#inputEnd = block.firstSample + block.frames;
    const audioData = block.data.slice().buffer;
    const result = await this.#worker.call<{ packets: { encodedData: ArrayBuffer; samples: number }[] }>('encode', { ctx: this.#context, audioData, numSamples: block.frames }, [audioData]);
    return this.#packets(result.packets);
  }
  #packets(values: { encodedData: ArrayBuffer; samples: number }[]): FlacPacket[] {
    return values.map(packet => { if (this.#nextSample === null || !Number.isSafeInteger(packet.samples) || packet.samples < 1) throw new EngineError('INVALID_PACKET', 'Invalid FLAC packet timing'); const firstSample = this.#nextSample; this.#nextSample += packet.samples; return { data: new Uint8Array(packet.encodedData), firstSample, frames: packet.samples }; });
  }
  async flush(): Promise<FlacPacket[]> { if (this.#closed) return []; const result = await this.#worker.call<{ packets: { encodedData: ArrayBuffer; samples: number }[] }>('flush', { ctx: this.#context }); const packets = this.#packets(result.packets); if (this.#inputEnd !== this.#nextSample) throw new EngineError('INVALID_PACKET', 'FLAC encoded sample total differs from decoded PCM'); return packets; }
  dispose(): void { if (this.#closed) return; this.#closed = true; this.#worker.terminate(); }
}
