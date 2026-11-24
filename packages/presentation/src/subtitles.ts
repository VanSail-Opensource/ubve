import type JASSUB from 'jassub';
import type * as Imsc from 'imsc';
import { finite } from './pcm-output.js';
import { decodeSubtitleText, readFontFamilyNames, srtToWebVtt, SUBTITLE_LIMITS, validateAss, validateAssPacket, validateSubtitleFonts, parseManagedWebVtt } from './subtitle-input.js';
import type { SubtitleFont, SubtitlePacket, PlainTextCue } from './subtitle-input.js';
import { parsePgsSup, PgsDecoder } from './pgs.js';
import type { PgsDisplaySet } from './pgs.js';

export type SubtitleKind = 'ass' | 'ssa' | 'vtt' | 'srt' | 'ttml' | 'imsc' | 'pgs';
export interface SubtitleLoad {
  readonly kind: SubtitleKind;
  readonly data: string | Uint8Array;
  readonly fonts?: readonly SubtitleFont[];
  readonly language?: string;
  readonly label?: string;
  readonly streaming?: boolean;
  readonly epoch?: number;
  readonly pgsPalette?: PgsDisplaySet['paletteInterpretation'];
}
export interface SubtitleStatus {
  readonly state: 'off' | 'loading' | 'ready' | 'failed' | 'disposed';
  readonly renderer: 'none' | 'native-webvtt' | 'managed-basic-text' | 'jassub-2.5.38' | 'imsc-2.0.0' | 'pgs-typescript-v1';
  readonly requiresOverlay: boolean;
  readonly rasterCap: number | null;
  readonly eventCount: number;
  readonly fontCount: number;
  readonly fallbackFonts: readonly string[];
  readonly diagnostics: readonly string[];
  readonly qualification: 'NOT_QUALIFIED';
}
export interface SubtitleControllerOptions {
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLElement;
  readonly quality?: 'full' | 'performance';
  readonly assetBaseUrl?: string;
  readonly onStatus?: (status: SubtitleStatus) => void;
}

/** One selected subtitle renderer. Renderer initialization, cue admission and
 * replacement serialize, while video callbacks never enqueue an unbounded set
 * of draws. An error is surfaced; required-subtitle policy belongs to Session. */
export class SubtitleController {
  readonly video: HTMLVideoElement;
  readonly overlay: HTMLElement;
  #options: SubtitleControllerOptions;
  #quality: 'full' | 'performance';
  #status: SubtitleStatus = { state: 'off', renderer: 'none', requiresOverlay: false, rasterCap: null, eventCount: 0,
    fontCount: 0, fallbackFonts: [], diagnostics: [], qualification: 'NOT_QUALIFIED' };
  #ass: JASSUB | null = null;
  #assHeader = '';
  #imsc: typeof Imsc | null = null;
  #tt: Imsc.TTElement | null = null;
  #ttState: ReturnType<typeof Imsc.generateISD> | null = null;
  #ttTimes: readonly number[] = [];
  #ttIndex = -2;
  #pgs: readonly PgsDisplaySet[] = [];
  #pgsDecoder: PgsDecoder | null = null;
  #pgsIndex = -2;
  #track: HTMLTrackElement | null = null;
  #nativeOriginalTimes = new Map<TextTrackCue, { start: number; end: number }>();
  #plainCues: readonly PlainTextCue[] = [];
  #plainTimes: readonly number[] = [];
  #plainIndex = -2;
  #urls: string[] = [];
  #fontFaces: FontFace[] = [];
  #canvas: HTMLCanvasElement | null = null;
  #bitmap: HTMLCanvasElement | null = null;
  #content: HTMLDivElement | null = null;
  #observer: ResizeObserver;
  #callback: number | null = null;
  #raf: number | null = null;
  #serial: Promise<void> = Promise.resolve();
  #draw: Promise<void> | null = null;
  #generation = 0;
  #streamEpoch = 0;
  #streamEntries: { end: number; bytes: number }[] = [];
  #streamBytes = 0;
  #headerBytes = 0;
  #baseEvents = 0;
  #lastPrune = -Infinity;
  #offset = 0;
  #externalClock = false;
  #lastTime = 0;
  #lastWidth = 1920;
  #lastHeight = 1080;
  #sizeKey = '';
  #disposed = false;
  #videoEvent: () => void;

  constructor(options: SubtitleControllerOptions) {
    this.#options = options; this.video = options.video; this.overlay = options.overlay; this.#quality = options.quality ?? 'full';
    Object.assign(this.overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    this.#videoEvent = () => { if (!this.#externalClock) this.#requestVideoDraw(true); };
    for (const event of ['loadedmetadata', 'seeked', 'pause', 'ratechange']) this.video.addEventListener(event, this.#videoEvent);
    this.#observer = new ResizeObserver(() => { this.#sizeKey = ''; this.#requestVideoDraw(true); });
    this.#observer.observe(this.overlay);
    this.#scheduleVideo();
  }

  getStatus(): SubtitleStatus { return this.#status; }
  get requiresOverlay(): boolean { return this.#status.requiresOverlay; }

  load(input: SubtitleLoad): Promise<void> {
    const generation = ++this.#generation;
    return this.#enqueue(async () => {
      if (this.#disposed) throw new Error('Subtitle controller disposed');
      await this.#clearOwned();
      if (generation !== this.#generation) return;
      this.#update({ state: 'loading', renderer: 'none', requiresOverlay: false, rasterCap: null, eventCount: 0, fontCount: 0, fallbackFonts: [], diagnostics: [] });
      try {
        const fonts = input.fonts ?? []; validateSubtitleFonts(fonts);
        this.#streamEpoch = input.epoch ?? 0;
        if (!Number.isSafeInteger(this.#streamEpoch) || this.#streamEpoch < 0) throw new Error('Invalid subtitle epoch');
        if (input.kind === 'ass' || input.kind === 'ssa') await this.#loadAss(decodeSubtitleText(input.data), fonts);
        else if (input.kind === 'vtt' || input.kind === 'srt') await this.#loadVtt(input);
        else if (input.kind === 'ttml' || input.kind === 'imsc') await this.#loadTtml(decodeSubtitleText(input.data), fonts);
        else {
          if (!input.pgsPalette) throw new Error('PGS requires an explicit BT.709 or BT.601 limited-range palette interpretation');
          this.#pgsDecoder = new PgsDecoder(input.pgsPalette);
          if (!input.streaming) {
            if (!(input.data instanceof Uint8Array)) throw new Error('PGS subtitles require binary input');
            this.#pgs = parsePgsSup(input.data, input.pgsPalette);
          }
          this.#canvas = document.createElement('canvas'); this.overlay.append(this.#canvas);
          this.#update({ renderer: 'pgs-typescript-v1', requiresOverlay: true, eventCount: this.#pgs.length,
            diagnostics: ['Independent TypeScript PGS candidate; palette interpretation is explicit, and native-reference raster fidelity is not qualified.'] });
        }
        if (generation !== this.#generation) { await this.#clearOwned(); return; }
        this.#update({ state: 'ready', fontCount: fonts.length });
        await this.#render(this.#externalClock ? this.#lastTime : this.video.currentTime, this.video.videoWidth || this.#lastWidth, this.video.videoHeight || this.#lastHeight, true);
      } catch (error) {
        await this.#clearOwned();
        this.#update({ state: 'failed', diagnostics: [message(error)] });
        throw error;
      }
    });
  }

  async #loadAss(source: string, fonts: readonly SubtitleFont[]): Promise<void> {
    const metadata = validateAss(source);
    const { default: Ass } = await import('jassub');
    const base = this.#options.assetBaseUrl ?? '/vendor/jassub/';
    const asset = (name: string): string => new URL(name, new URL(base, document.baseURI)).href;
    const ownedFonts = fonts.map(font => ({ name: font.name, data: font.data.slice() }));
    const availableFonts: Record<string, Uint8Array | string> = { 'liberation sans': asset('default.woff2') };
    for (const font of ownedFonts) for (const family of readFontFamilyNames(font.data)) availableFonts[family.toLowerCase()] = font.data;
    const fallbackFonts = metadata.requestedFonts.filter(name => !availableFonts[name.toLowerCase()]);
    const canvas = document.createElement('canvas'); this.overlay.append(canvas); this.#canvas = canvas;
    const instance = new Ass({ canvas, subContent: source, queryFonts: false, fonts: ownedFonts.map(font => font.data), availableFonts,
      workerUrl: asset('worker.js'), wasmUrl: asset('jassub-worker.wasm'), modernWasmUrl: asset('jassub-worker-modern.wasm'),
      wasmWorkerUrl: asset('jassub-worker.js'), modernWasmWorkerUrl: asset('jassub-worker-modern.js'),
      libassMemoryLimit: 32, libassGlyphLimit: 10000, maxRenderHeight: this.#quality === 'performance' ? 1080 : 0 });
    this.#ass = instance; this.#assHeader = source; this.#headerBytes = new TextEncoder().encode(source).byteLength; this.#baseEvents = metadata.events;
    await finite(instance.ready, 10_000, 'ASS worker initialization');
    // This pinned adapter owns the clock, error propagation and logical/raster
    // sizes. The public manualRender method catches worker errors internally.
    instance._ro.disconnect();
    this.#update({ renderer: 'jassub-2.5.38', requiresOverlay: true, eventCount: metadata.events,
      rasterCap: this.#quality === 'performance' ? 1080 : null, fallbackFonts,
      diagnostics: [
        'One subtitle worker, zero pthread children; libass cache limits are soft and do not cap the complete WASM heap.',
        'Attached or bundled fonts only; remote font lookup and local-font permission prompts are disabled.',
        'SDR subtitle-overlay luminance follows the browser compositor; physical HDR subtitle appearance is unverified.',
        ...(fallbackFonts.length ? [`Unmatched font families may use bundled Liberation Sans: ${fallbackFonts.join(', ')}`] : []),
      ] });
  }

  async #loadVtt(input: SubtitleLoad): Promise<void> {
    const text = input.kind === 'srt' ? srtToWebVtt(decodeSubtitleText(input.data)) : decodeSubtitleText(input.data);
    if (!/^WEBVTT(?:[ \t].*)?\r?\n/.test(text)) throw new Error('Invalid WebVTT header');
    const count = (text.match(/-->/g) ?? []).length;
    if (count > SUBTITLE_LIMITS.events) throw new Error('WebVTT cue count exceeds 50,000');
    if (this.#externalClock) {
      this.#plainCues = parseManagedWebVtt(text); this.#plainTimes = [...new Set(this.#plainCues.flatMap(cue => [cue.start, cue.end]))].sort((a, b) => a - b);
      this.#content = document.createElement('div'); this.overlay.append(this.#content);
      this.#update({ renderer: 'managed-basic-text', requiresOverlay: true, eventCount: this.#plainCues.length,
        diagnostics: ['Managed basic text profile: timing, line breaks, b/i/u and alignment. Complex WebVTT layout/style/regions are refused.'] });
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' })); this.#urls.push(url);
    const track = document.createElement('track'); this.#track = track;
    track.kind = 'subtitles'; track.label = input.label ?? 'Subtitles'; track.srclang = input.language ?? 'und'; track.default = true;
    const loaded = new Promise<void>((resolve, reject) => {
      track.addEventListener('load', () => resolve(), { once: true });
      track.addEventListener('error', () => reject(new Error('Browser could not parse this WebVTT track')), { once: true });
    });
    track.src = url; this.video.append(track); track.track.mode = 'showing';
    await finite(loaded, 5_000, 'WebVTT track load');
    const cues = track.track.cues;
    for (let i = 0; cues && i < cues.length; i++) { const cue = cues[i]!; this.#nativeOriginalTimes.set(cue, { start: cue.startTime, end: cue.endTime }); }
    if (count > 0 && !cues?.length) throw new Error('The native WebVTT parser admitted no cues');
    this.#update({ renderer: 'native-webvtt', requiresOverlay: false, eventCount: cues?.length ?? 0,
      diagnostics: ['Native WebVTT rendering; exact browser cue/style/output-mode semantics remain unqualified.'] });
    this.#applyNativeOffset();
  }

  async #loadTtml(source: string, fonts: readonly SubtitleFont[]): Promise<void> {
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) throw new Error('TTML external entities and stylesheet processing are outside the admitted profile');
    const xml = new DOMParser().parseFromString(source, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Malformed TTML XML');
    const elements = xml.getElementsByTagName('*');
    if (elements.length > 50000) throw new Error('TTML element count exceeds 50,000');
    for (const element of elements) {
      let depth = 0; for (let parent: Element | null = element; parent; parent = parent.parentElement) if (++depth > 64) throw new Error('TTML nesting exceeds 64');
      for (const attribute of element.attributes) {
        if (['src', 'href', 'backgroundImage'].includes(attribute.localName) || /url\s*\(/i.test(attribute.value)) throw new Error('TTML image/external resources need an explicitly selected image-profile pack');
      }
    }
    this.#imsc = await import('imsc');
    this.#tt = this.#imsc.fromXML(source, this.#imscErrors(), null);
    if (!this.#tt) throw new Error('IMSC parser rejected TTML');
    this.#ttTimes = this.#tt.getMediaTimeEvents();
    if (this.#ttTimes.length > SUBTITLE_LIMITS.events || this.#ttTimes.some(time => !Number.isFinite(time))) throw new Error('TTML time-event envelope exceeded');
    for (const font of fonts) {
      for (const name of readFontFamilyNames(font.data).slice(0, 1)) {
        const face = new FontFace(name, font.data.slice().buffer);
        await finite(face.load(), 5_000, 'TTML attached font'); document.fonts.add(face); this.#fontFaces.push(face);
      }
    }
    this.#content = document.createElement('div'); this.overlay.append(this.#content);
    this.#update({ renderer: 'imsc-2.0.0', requiresOverlay: true, eventCount: this.#ttTimes.length,
      diagnostics: ['IMSC text profile through imscJS 2.0.0. Image resources are refused; unsupported profile features report parser warnings or errors.'] });
  }

  addPacket(packet: SubtitlePacket): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#disposed || this.#status.state !== 'ready') throw new Error('Subtitle renderer is not ready');
      if (packet.epoch !== undefined && packet.epoch !== this.#streamEpoch) throw new Error('Stale subtitle epoch');
      if (packet.kind === 'pgs') {
        if (!this.#pgsDecoder) throw new Error('PGS stream is not initialized');
        const sets = this.#pgsDecoder.pushPacket(packet.data, packet.ptsSeconds);
        const cutoffIndex = Math.max(0, eventIndex(this.#pgs.map(set => set.ptsSeconds), this.#lastTime - 30));
        const retained = this.#pgs.slice(cutoffIndex);
        for (const set of this.#pgs) if (!retained.includes(set)) this.#pgsDecoder.releaseDisplaySet(set);
        this.#pgs = [...retained, ...sets];
        this.#update({ eventCount: this.#pgs.length }); return;
      }
      if (!this.#ass) throw new Error('ASS stream is not initialized');
      const event = validateAssPacket(packet);
      await this.#prune(this.#externalClock ? this.#lastTime : this.video.currentTime);
      if (this.#streamEntries.length + this.#baseEvents >= SUBTITLE_LIMITS.events || this.#headerBytes + this.#streamBytes + packet.data.byteLength > SUBTITLE_LIMITS.textBytes) throw new Error('Streaming ASS cue budget exceeded; demux must honor backpressure');
      await finite(this.#ass.renderer.processChunk(event.content, event.timeMs, event.durationMs), 2_000, 'ASS packet ingestion');
      this.#streamEntries.push({ end: packet.ptsSeconds + packet.durationSeconds!, bytes: packet.data.byteLength });
      this.#streamBytes += packet.data.byteLength;
      this.#update({ eventCount: this.#streamEntries.length });
    });
  }

  resetStream(epoch: number): Promise<void> {
    return this.#enqueue(async () => {
      if (!Number.isSafeInteger(epoch) || epoch <= this.#streamEpoch) throw new Error('Subtitle stream reset requires a newer epoch');
      this.#streamEpoch = epoch; this.#streamEntries = []; this.#streamBytes = 0; this.#lastPrune = -Infinity;
      if (this.#ass) await finite(this.#ass.renderer.setTrack(this.#assHeader), 2_000, 'ASS stream reset');
      this.#pgs = []; this.#pgsDecoder?.reset(); this.#pgsIndex = -2;
      if (this.#canvas && !this.#ass) this.#canvas.getContext('2d')?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      this.#update({ eventCount: 0 });
    });
  }

  async #prune(time: number): Promise<void> {
    if (!this.#ass || time - this.#lastPrune < 5) return;
    const cutoff = time - 30;
    await finite(this.#ass.renderer.pruneEvents(Math.max(0, cutoff * 1000)), 2_000, 'ASS event pruning');
    this.#streamEntries = this.#streamEntries.filter(entry => entry.end >= cutoff);
    this.#streamBytes = this.#streamEntries.reduce((total, entry) => total + entry.bytes, 0); this.#lastPrune = time;
  }

  async setQuality(mode: 'full' | 'performance'): Promise<void> {
    this.#quality = mode; this.#sizeKey = '';
    this.#update({ rasterCap: this.#ass && mode === 'performance' ? 1080 : null });
    await this.#render(this.#lastTime, this.#lastWidth, this.#lastHeight, true);
  }

  setOffset(seconds: number): void {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 3600) throw new Error('Subtitle offset is limited to one hour');
    this.#offset = seconds; this.#ttIndex = this.#pgsIndex = this.#plainIndex = -2;
    this.#applyNativeOffset(); this.#requestVideoDraw(true);
  }

  #applyNativeOffset(): void {
    for (const [cue, original] of this.#nativeOriginalTimes) {
      cue.startTime = Math.max(0, original.start + this.#offset); cue.endTime = Math.max(cue.startTime, original.end + this.#offset);
    }
  }

  async renderAt(seconds: number, width: number, height: number): Promise<void> {
    if (this.#track) throw new Error('Managed playback must select external subtitle clock before loading text tracks');
    this.#externalClock = true;
    await this.#render(seconds, width, height, false);
  }

  followVideo(): void { this.#externalClock = false; this.#requestVideoDraw(true); }
  setExternalClock(enabled = true): void { this.#externalClock = enabled; }

  async #render(seconds: number, width: number, height: number, repaint: boolean): Promise<void> {
    if (this.#disposed || this.#status.state !== 'ready') return;
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return;
    while (this.#draw) await this.#draw;
    this.#lastTime = seconds; this.#lastWidth = width; this.#lastHeight = height;
    this.#draw = this.#renderOwned(seconds - this.#offset, width, height, repaint);
    try { await this.#draw; }
    catch (error) { this.#update({ state: 'failed', diagnostics: [...this.#status.diagnostics, message(error)] }); throw error; }
    finally { this.#draw = null; }
  }

  async #renderOwned(seconds: number, width: number, height: number, repaint: boolean): Promise<void> {
    const hostWidth = this.overlay.clientWidth || width, hostHeight = this.overlay.clientHeight || height;
    const scale = Math.min(hostWidth / width, hostHeight / height);
    const cssWidth = width * scale, cssHeight = height * scale;
    const target = this.#canvas ?? this.#content;
    if (target) Object.assign(target.style, { position: 'absolute', left: `${(hostWidth - cssWidth) / 2}px`, top: `${(hostHeight - cssHeight) / 2}px`, width: `${cssWidth}px`, height: `${cssHeight}px`, visibility: seconds < 0 ? 'hidden' : 'visible' });
    if (seconds < 0) return;
    const key = `${width}/${height}/${hostWidth}/${hostHeight}/${this.#quality}`;
    const resized = this.#sizeKey !== key; this.#sizeKey = key;
    if (this.#ass) {
      if (resized) {
        const rasterScale = this.#quality === 'performance' ? Math.min(1, 1080 / height) : 1;
        await finite(this.#ass.renderer._resizeCanvas(Math.max(1, Math.round(width * rasterScale)), Math.max(1, Math.round(height * rasterScale)), width, height), 2_000, 'ASS raster resize');
      }
      await finite(this.#ass.renderer._draw(Math.max(0, seconds), repaint || resized), 2_000, 'ASS raster draw');
    } else if (this.#status.renderer === 'managed-basic-text' && this.#content) {
      const index = eventIndex(this.#plainTimes, seconds);
      if (index === this.#plainIndex && !resized && !repaint) return; this.#plainIndex = index;
      const active = this.#plainCues.filter(cue => cue.start <= seconds && cue.end > seconds);
      if (active.length > 100) throw new Error('More than 100 simultaneous text cues exceeds the admitted overlay envelope');
      this.#content.replaceChildren();
      Object.assign(this.#content.style, { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', padding: '0 5% 5%', boxSizing: 'border-box' });
      for (const cue of active) {
        const line = document.createElement('div');
        Object.assign(line.style, { whiteSpace: 'pre-line', color: 'white', background: 'rgba(0,0,0,.8)', padding: '.08em .25em', maxWidth: '100%', textAlign: cue.align,
          fontFamily: 'sans-serif', fontSize: `${Math.max(16, cssHeight * 0.055)}px`, lineHeight: '1.25' });
        appendBasicMarkup(line, cue.text); this.#content.append(line);
      }
    } else if (this.#imsc && this.#tt && this.#content) {
      const index = eventIndex(this.#ttTimes, seconds);
      if (index === this.#ttIndex && !resized && !repaint) return;
      if (index < this.#ttIndex) this.#ttState = null;
      this.#ttIndex = index;
      const isd = this.#imsc.generateISD(this.#tt, seconds, this.#imscErrors());
      this.#content.replaceChildren();
      this.#ttState = this.#imsc.renderHTML(isd, this.#content, null, cssHeight, cssWidth, false, this.#imscErrors(), this.#ttState as ReturnType<typeof Imsc.generateISD>, false);
    } else if (this.#canvas && this.#pgs.length) {
      const index = eventIndex(this.#pgs.map(set => set.ptsSeconds), seconds);
      if (index === this.#pgsIndex && !resized && !repaint) return; this.#pgsIndex = index;
      const set = this.#pgs[index]; this.#canvas.width = set?.width ?? width; this.#canvas.height = set?.height ?? height;
      const context = this.#canvas.getContext('2d'); if (!context) throw new Error('PGS Canvas2D unavailable');
      context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      if (set) for (const rectangle of set.rectangles) {
        this.#bitmap ??= document.createElement('canvas'); this.#bitmap.width = rectangle.width; this.#bitmap.height = rectangle.height;
        const bitmapContext = this.#bitmap.getContext('2d'); if (!bitmapContext) throw new Error('PGS bitmap Canvas2D unavailable');
        bitmapContext.putImageData(new ImageData(rectangle.rgba as Uint8ClampedArray<ArrayBuffer>, rectangle.width, rectangle.height), 0, 0);
        context.drawImage(this.#bitmap, rectangle.x, rectangle.y);
      }
    }
  }

  #imscErrors(): Imsc.ErrorHandler {
    return {
      warn: value => { if (!this.#status.diagnostics.includes(value)) this.#update({ diagnostics: [...this.#status.diagnostics.slice(0, 63), value] }); return false; },
      error: value => { throw new Error(`IMSC: ${value}`); }, fatal: value => { throw new Error(`IMSC: ${value}`); },
    };
  }

  #scheduleVideo(): void {
    if (this.#disposed) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.#callback = this.video.requestVideoFrameCallback((_now, data) => {
        this.#callback = null;
        if (!this.#externalClock && !this.#draw) void this.#render(data.mediaTime, data.width, data.height, false).catch(() => undefined);
        this.#scheduleVideo();
      });
    } else {
      this.#raf = requestAnimationFrame(() => { this.#raf = null; this.#requestVideoDraw(false); this.#scheduleVideo(); });
    }
  }

  #requestVideoDraw(repaint: boolean): void {
    if (this.#disposed || this.#draw) return;
    void this.#render(this.#externalClock ? this.#lastTime : this.video.currentTime,
      this.video.videoWidth || this.#lastWidth, this.video.videoHeight || this.#lastHeight, repaint).catch(() => undefined);
  }

  clear(): Promise<void> {
    ++this.#generation;
    return this.#enqueue(async () => { await this.#clearOwned(); this.#update({ state: 'off', renderer: 'none', requiresOverlay: false, rasterCap: null, eventCount: 0, fontCount: 0, fallbackFonts: [], diagnostics: [] }); });
  }

  async #clearOwned(): Promise<void> {
    if (this.#draw) await this.#draw.catch(() => undefined);
    const ass = this.#ass; this.#ass = null;
    if (ass) {
      try { await finite(ass.destroy(), 1_000, 'ASS disposal'); }
      catch (error) { this.#update({ diagnostics: [...this.#status.diagnostics, `${message(error)}; owned worker termination requested.`] }); }
      finally { ass._worker.terminate(); ass._ro.disconnect(); }
    }
    if (this.#track) { this.#track.track.mode = 'disabled'; this.#track.remove(); this.#track = null; }
    this.#nativeOriginalTimes.clear();
    this.#plainCues = []; this.#plainTimes = []; this.#plainIndex = -2;
    for (const url of this.#urls) URL.revokeObjectURL(url); this.#urls = [];
    for (const font of this.#fontFaces) document.fonts.delete(font); this.#fontFaces = [];
    this.overlay.replaceChildren(); this.#canvas = this.#content = null;
    if (this.#bitmap) { this.#bitmap.width = this.#bitmap.height = 0; this.#bitmap = null; }
    this.#tt = null; this.#imsc = null; this.#ttState = null; this.#ttTimes = []; this.#ttIndex = -2;
    this.#pgs = []; this.#pgsDecoder = null; this.#pgsIndex = -2;
    this.#streamEntries = []; this.#streamBytes = this.#headerBytes = this.#baseEvents = 0; this.#assHeader = ''; this.#sizeKey = '';
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return; this.#disposed = true; ++this.#generation;
    if (this.#callback !== null) this.video.cancelVideoFrameCallback(this.#callback);
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#observer.disconnect();
    for (const event of ['loadedmetadata', 'seeked', 'pause', 'ratechange']) this.video.removeEventListener(event, this.#videoEvent);
    await this.#enqueue(() => this.#clearOwned()); this.#update({ state: 'disposed', renderer: 'none', requiresOverlay: false });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#serial.then(operation); this.#serial = next.catch(() => undefined); return next;
  }
  #update(patch: Partial<SubtitleStatus>): void { this.#status = Object.freeze({ ...this.#status, ...patch }); this.#options.onStatus?.(this.#status); }
}

function eventIndex(times: readonly number[], time: number): number {
  let low = 0, high = times.length;
  while (low < high) { const mid = low + Math.floor((high - low) / 2); if (times[mid]! <= time) low = mid + 1; else high = mid; }
  return low - 1;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function appendBasicMarkup(parent: HTMLElement, text: string): void {
  const stack: HTMLElement[] = [parent];
  const entities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };
  for (const token of text.split(/(<\/?(?:b|i|u)>)/)) {
    if (/^<\//.test(token)) { stack.pop(); continue; }
    const tag = /^<(b|i|u)>$/.exec(token);
    if (tag) { const element = document.createElement(tag[1]!); stack.at(-1)!.append(element); stack.push(element); }
    else stack.at(-1)!.append(document.createTextNode(token.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_all, name: string) => entities[name]!)));
  }
}
