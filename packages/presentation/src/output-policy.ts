export type PresentationMode = 'inline' | 'document-fullscreen' | 'container-fullscreen' | 'video-fullscreen' | 'video-pip' | 'picture-in-picture' | 'document-pip';
export interface OutputEligibility {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly qualification: 'NOT_QUALIFIED' | 'DEFERRED_NOT_QUALIFIED';
}

export function getPresentationEligibility(options: {
  readonly mode: PresentationMode;
  readonly customSubtitles: boolean;
  readonly supported?: boolean;
}): OutputEligibility {
  if (options.supported === false) return { allowed: false, reason: 'This browser does not expose this presentation mode.', qualification: 'NOT_QUALIFIED' };
  if (options.customSubtitles && (options.mode === 'video-fullscreen' || options.mode === 'video-pip' || options.mode === 'picture-in-picture')) {
    return { allowed: false, reason: 'This mode excludes the subtitle overlay. Use player fullscreen to retain the selected subtitles.', qualification: 'NOT_QUALIFIED' };
  }
  return { allowed: true, reason: null, qualification: 'DEFERRED_NOT_QUALIFIED' };
}

export interface HdrOutputAssessment {
  readonly output: 'native-hdr-candidate' | 'webgpu-hdr-candidate' | 'sdr' | 'sdr-tonemapped' | 'refused';
  readonly qualification: 'DEFERRED_NOT_QUALIFIED' | 'NOT_QUALIFIED';
  readonly reason: string;
}

/** Capability probes are deliberately separate from a physical HDR admission. */
export function assessHdrOutput(options: {
  readonly sourceIsHdr: boolean;
  readonly route: 'native' | 'webgpu' | 'canvas2d';
  readonly acceptedExtendedCanvas?: boolean;
  readonly allowSdrToneMap?: boolean;
}): HdrOutputAssessment {
  if (!options.sourceIsHdr) return { output: 'sdr', qualification: 'NOT_QUALIFIED', reason: 'SDR output; no HDR claim applies.' };
  if (options.route === 'native') return { output: 'native-hdr-candidate', qualification: 'DEFERRED_NOT_QUALIFIED', reason: 'Encoded HDR metadata remains with the native media route; physical HDR output has not been measured.' };
  if (options.route === 'webgpu' && options.acceptedExtendedCanvas) return { output: 'webgpu-hdr-candidate', qualification: 'DEFERRED_NOT_QUALIFIED', reason: 'Extended canvas accepted; display luminance, gamut, and metadata interpretation remain unverified.' };
  if (options.allowSdrToneMap) return { output: 'sdr-tonemapped', qualification: 'NOT_QUALIFIED', reason: 'Explicit PQ/BT.2020 to SDR tone mapping reduces HDR range and gamut.' };
  return { output: 'refused', qualification: 'NOT_QUALIFIED', reason: 'Full HDR output is unavailable through this renderer. Select the explicit SDR tone-map transform or an eligible native route.' };
}

/** Finite recovery policy, per open; an underrun never silently resumes an epoch. */
export class RecoveryBudget {
  #all = 0;
  #recent: number[] = [];
  request(nowMs: number): boolean {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('Invalid recovery clock');
    this.#recent = this.#recent.filter(time => nowMs - time < 30_000);
    if (this.#all >= 6 || this.#recent.length >= 2) return false;
    this.#all++; this.#recent.push(nowMs); return true;
  }
  get total(): number { return this.#all; }
}
