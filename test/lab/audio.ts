import { finite } from '@ubve/presentation';

interface Entry { readonly context: AudioContext; admitted: boolean; attempt: number; }

/** Document lifetime. Enrollment activates exact-rate contexts, not any media. */
export class LabAudio {
  readonly #entries = new Map<number, Entry>();
  readonly #rates: readonly number[];

  constructor(rates: readonly number[]) { this.#rates = rates; }

  get admitted(): number[] {
    return this.#rates.filter(rate => {
      const entry = this.#entries.get(rate);
      return entry?.admitted && entry.context.state !== 'closed';
    });
  }

  get missing(): boolean { return this.admitted.length !== this.#rates.length; }

  context = (rate: number): AudioContext => {
    const entry = this.#entries.get(rate);
    if (!entry?.admitted || entry.context.state === 'closed') {
      throw new DOMException(`Browser audio has not been admitted at ${rate} Hz for this tab`, 'NotAllowedError');
    }
    return entry.context;
  };

  prepare(): Promise<void> {
    // No await before construction or resume. A pairing click is the only
    // activation restrictive browsers need for the lifetime of this page.
    if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') return Promise.resolve();
    return Promise.all(this.#rates.map(async rate => {
      let entry = this.#entries.get(rate);
      if (entry?.admitted && entry.context.state !== 'closed') return;
      try {
        if (!entry || entry.context.state === 'closed') {
          const context = new AudioContext({ sampleRate: rate, latencyHint: 'playback' });
          entry = { context, admitted: false, attempt: 0 };
          this.#entries.set(rate, entry);
          if (context.sampleRate !== rate) {
            await finite(context.close(), 1000, 'Lab audio close');
            return;
          }
        }
        const attempt = ++entry.attempt;
        if (entry.context.state !== 'running') await finite(entry.context.resume(), 4000, 'Lab audio admission');
        if (this.#entries.get(rate) === entry && entry.attempt === attempt) entry.admitted = entry.context.state === 'running';
      } catch { /* Not allowed or unsupported. Never fabricate an admitted graph. */ }
    })).then(() => undefined);
  }

  close(): void {
    for (const { context } of this.#entries.values()) {
      if (context.state !== 'closed') void finite(context.close(), 1000, 'Lab audio close').catch(() => undefined);
    }
    this.#entries.clear();
  }
}
