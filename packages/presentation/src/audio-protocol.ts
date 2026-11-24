/** Sample positions are exact safe integers at this boundary. Conversion from
 * bigint is checked by PcmOutput; graph frames never stand in for media progress. */
export interface PcmConfiguration {
  readonly sampleRate: number;
  readonly channels: number;
  readonly channelLabels: readonly string[];
  readonly blockFrames: number;
  readonly poolBlocks: number;
  readonly primeFrames: number;
  readonly epoch: number;
  readonly firstMediaSample: number;
}

export interface PcmBlock {
  readonly type: 'block';
  readonly id: number;
  readonly epoch: number;
  readonly startMediaSample: number;
  readonly frames: number;
  readonly channels: number;
  readonly buffer: ArrayBuffer;
}

export type PcmState = 'ready' | 'scheduled' | 'playing' | 'paused' | 'starved' | 'ended' | 'failed' | 'disposed';
export interface PcmSnapshot {
  readonly state: PcmState;
  readonly epoch: number;
  readonly graphFrame: number;
  readonly nextMediaSample: number;
  readonly finalMediaSample: number | null;
  readonly queuedFrames: number;
  readonly acceptedBlocks: number;
  readonly returnedBlocks: number;
  readonly consumedFrames: number;
  readonly underruns: number;
  readonly rejectedBlocks: number;
  readonly capacityFrames: number;
  readonly transportBytes: number;
}

export interface PcmEvent {
  readonly type: string;
  readonly requestId?: number;
  readonly epoch: number;
  readonly graphFrame: number;
  readonly nextMediaSample: number;
  readonly snapshot: PcmSnapshot;
  readonly reason?: string;
}

export const DEFAULT_PCM_BLOCK_FRAMES = 960;
export const DEFAULT_PCM_POOL_BLOCKS = 12;

export function validatePcmConfiguration(config: PcmConfiguration): void {
  const integer = (n: number, min: number, max: number): boolean => Number.isSafeInteger(n) && n >= min && n <= max;
  if (!integer(config.sampleRate, 8_000, 384_000) || !integer(config.channels, 1, 8)
    || config.channelLabels.length !== config.channels || new Set(config.channelLabels).size !== config.channels
    || config.channelLabels.some(label => !label.trim())
    || !integer(config.blockFrames, 128, 8192) || !integer(config.poolBlocks, 2, 64)
    || !integer(config.primeFrames, 1, config.blockFrames * config.poolBlocks)
    || !integer(config.epoch, 0, Number.MAX_SAFE_INTEGER)
    || !integer(config.firstMediaSample, 0, Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid PCM rate, explicit channel layout, pool, epoch, or sample position');
  }
}

/** These PCM transforms are explicit, deterministic pre-DSP operations. */
export function signed24In32ToFloat(source: Int32Array, destination: Float32Array): void {
  if (source.length !== destination.length) throw new Error('PCM destination size mismatch');
  for (let i = 0; i < source.length; i++) {
    const sample = source[i]!;
    if ((sample & 255) !== 0) throw new Error('Expected left-aligned signed 24-bit PCM; 32-bit reduction is not admitted');
    destination[i] = sample / 2_147_483_648;
  }
}
