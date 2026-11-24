export const SUBTITLE_LIMITS = Object.freeze({ textBytes: 8 * 1024 * 1024, events: 50_000, fonts: 32,
  fontBytes: 4 * 1024 * 1024, allFontBytes: 32 * 1024 * 1024, pgsBytes: 32 * 1024 * 1024, decodedPgsBytes: 64 * 1024 * 1024 });

export interface SubtitleFont { readonly name: string; readonly data: Uint8Array; readonly sha256?: string; }
export function validateSubtitleFonts(fonts: readonly SubtitleFont[]): void {
  if (fonts.length > SUBTITLE_LIMITS.fonts) throw new Error('Subtitle attachment count exceeds 32 fonts');
  let total = 0;
  for (const font of fonts) {
    if (!font.name.trim() || font.name.length > 256 || font.data.byteLength === 0 || font.data.byteLength > SUBTITLE_LIMITS.fontBytes) throw new Error('Invalid or oversized subtitle font attachment');
    total += font.data.byteLength;
    if (total > SUBTITLE_LIMITS.allFontBytes) throw new Error('Subtitle font attachments exceed the 32 MiB budget');
  }
}

export function decodeSubtitleText(data: string | Uint8Array): string {
  if (typeof data === 'string') {
    if (data.length > SUBTITLE_LIMITS.textBytes || new TextEncoder().encode(data).byteLength > SUBTITLE_LIMITS.textBytes) throw new Error('Subtitle text exceeds the 8 MiB budget');
    return data.replace(/^\uFEFF/, '');
  }
  if (data.byteLength > SUBTITLE_LIMITS.textBytes) throw new Error('Subtitle text exceeds the 8 MiB budget');
  let encoding = 'utf-8', bytes = data;
  if (data[0] === 0xff && data[1] === 0xfe) { encoding = 'utf-16le'; bytes = data.subarray(2); }
  else if (data[0] === 0xfe && data[1] === 0xff) { encoding = 'utf-16be'; bytes = data.subarray(2); }
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error('Subtitle text needs valid UTF-8 or BOM-marked UTF-16; legacy encoding must be converted explicitly'); }
}

export function srtToWebVtt(source: string): string {
  const text = decodeSubtitleText(source).replace(/\r\n?/g, '\n').trim();
  const chunks = text ? text.split(/\n[ \t]*\n/) : [];
  if (chunks.length > SUBTITLE_LIMITS.events) throw new Error('Subtitle cue count exceeds 50,000');
  const converted: string[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() ?? '')) lines.shift();
    const timing = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s*$/.exec(lines.shift() ?? '');
    if (!timing) throw new Error('SRT cue has unsupported timing or position syntax');
    const start = Number(timing[1]) * 3600 + Number(timing[2]) * 60 + Number(timing[3]) + Number(timing[4]) / 1000;
    const end = Number(timing[5]) * 3600 + Number(timing[6]) * 60 + Number(timing[7]) + Number(timing[8]) / 1000;
    if (Number(timing[2]) >= 60 || Number(timing[3]) >= 60 || Number(timing[6]) >= 60 || Number(timing[7]) >= 60 || end <= start) throw new Error('Invalid SRT cue interval');
    const body = lines.join('\n');
    if (/\{\\|<(?!(?:\/?(?:b|i|u)>))[^>]*>/i.test(body)) throw new Error('SRT styling cannot be mapped to native WebVTT without losing semantics');
    const time = (h: string, m: string, s: string, ms: string): string => `${h.padStart(2, '0')}:${m}:${s}.${ms}`;
    converted.push(`${time(timing[1]!, timing[2]!, timing[3]!, timing[4]!)} --> ${time(timing[5]!, timing[6]!, timing[7]!, timing[8]!)}\n${body}`);
  }
  return `WEBVTT\n\n${converted.join('\n\n')}\n`;
}

export function validateAss(source: string): { readonly events: number; readonly requestedFonts: readonly string[] } {
  const text = decodeSubtitleText(source);
  if (!/^\s*\[Script Info\]/im.test(text) || !/^\s*\[V4\+? Styles\]/im.test(text)) throw new Error('ASS/SSA script needs Script Info and a style section');
  let events = 0; const fonts = new Set<string>(); let styleFields: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (/^\[(?:Fonts|Graphics)\][ \t]*$/i.test(line)) throw new Error('Inline ASS fonts/graphics are outside the bounded attachment profile');
    if (/^Dialogue\s*:/i.test(line) && ++events > SUBTITLE_LIMITS.events) throw new Error('ASS event count exceeds 50,000');
    if (/^Format:/i.test(line) && /Fontname/i.test(line)) styleFields = line.slice(line.indexOf(':') + 1).split(',').map(value => value.trim().toLowerCase());
    if (/^Style:/i.test(line)) {
      const fields = line.slice(line.indexOf(':') + 1).split(','); const index = styleFields.indexOf('fontname');
      if (index >= 0 && fields[index]?.trim()) fonts.add(fields[index]!.trim());
    }
  }
  return { events, requestedFonts: [...fonts] };
}

/** Names from the OpenType name table, bounded before every read. WOFF/WOFF2
 * remain loadable by libass, but family introspection stays explicitly unknown. */
export function readFontFamilyNames(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength < 12) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = view.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f && signature !== 0x74727565) return [];
  const count = view.getUint16(4); if (count > 256 || 12 + count * 16 > bytes.length) return [];
  let offset = 0, length = 0;
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (view.getUint32(at) === 0x6e616d65) { offset = view.getUint32(at + 8); length = view.getUint32(at + 12); break; }
  }
  if (!offset || length < 6 || offset + length > bytes.length) return [];
  const records = view.getUint16(offset + 2), storage = offset + view.getUint16(offset + 4);
  if (records > 4096 || 6 + records * 12 > length || storage > offset + length) return [];
  const result = new Set<string>();
  for (let i = 0; i < records; i++) {
    const at = offset + 6 + i * 12, platform = view.getUint16(at), nameId = view.getUint16(at + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const size = view.getUint16(at + 8), start = storage + view.getUint16(at + 10);
    if (size > 512 || start + size > offset + length) continue;
    if (platform !== 0 && platform !== 3 && platform !== 1) continue;
    try {
      const name = new TextDecoder(platform === 1 ? 'macintosh' : 'utf-16be', { fatal: true }).decode(bytes.subarray(start, start + size)).trim();
      if (name && !/[\u0000-\u001f]/.test(name)) result.add(name);
    } catch { /* Unsupported name encoding is an unknown family, not guessed. */ }
  }
  return [...result];
}

export interface SubtitlePacket { readonly kind: 'ass' | 'ssa' | 'pgs'; readonly data: Uint8Array;
  readonly ptsSeconds: number; readonly durationSeconds: number | null; readonly epoch?: number; }

export function validateAssPacket(packet: SubtitlePacket): { readonly content: string; readonly timeMs: number; readonly durationMs: number } {
  if (!Number.isFinite(packet.ptsSeconds) || packet.ptsSeconds < 0 || packet.durationSeconds === null || !Number.isFinite(packet.durationSeconds)
    || packet.durationSeconds <= 0 || packet.durationSeconds > 86400) throw new Error('ASS packets require a known positive source duration and finite presentation time');
  const content = decodeSubtitleText(packet.data);
  if (content.length > 256 * 1024 || !/^\d+,/.test(content) || content.split(',').length < 9) throw new Error('Invalid Matroska ASS event packet');
  const timeMs = Math.round(packet.ptsSeconds * 1000), durationMs = Math.round(packet.durationSeconds * 1000);
  const isExactMs = (seconds: number, ms: number): boolean => Math.abs(seconds * 1000 - ms) <= Number.EPSILON * Math.max(ms, 1);
  if (!Number.isSafeInteger(timeMs + durationMs) || durationMs < 1 || !isExactMs(packet.ptsSeconds, timeMs)
    || !isExactMs(packet.durationSeconds, durationMs)) throw new Error('ASS time cannot be represented by the selected millisecond API');
  return { content, timeMs, durationMs };
}

export interface PlainTextCue {
  readonly start: number; readonly end: number; readonly text: string;
  readonly align: 'start' | 'center' | 'end';
}

/** Explicit managed text profile: timing, line breaks, b/i/u and alignment.
 * Unsupported regions, CSS, ruby, voice/class styling and positioning fail
 * before playback instead of being flattened to plain text. */
export function parseManagedWebVtt(source: string): readonly PlainTextCue[] {
  const text = decodeSubtitleText(source).replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t].*)?\n/.test(text)) throw new Error('Invalid WebVTT header');
  const blocks = text.slice(text.indexOf('\n') + 1).trim().split(/\n[ \t]*\n/).filter(Boolean);
  const result: PlainTextCue[] = [];
  const timestamp = (value: string): number => {
    const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
    if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) throw new Error('Invalid WebVTT timestamp');
    const ms = Number(match[1] ?? 0) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]);
    if (!Number.isSafeInteger(ms)) throw new Error('WebVTT timestamp exceeds the safe millisecond range');
    return ms / 1000;
  };
  for (const block of blocks) {
    if (/^NOTE(?:[ \t\n]|$)/.test(block)) continue;
    if (/^(?:STYLE|REGION)(?:[ \t\n]|$)/.test(block)) throw new Error('Managed WebVTT CSS/regions are outside the admitted basic-text profile');
    const lines = block.split('\n'); if (!lines[0]?.includes('-->')) lines.shift();
    const match = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines.shift() ?? '');
    if (!match) throw new Error('Malformed managed WebVTT cue');
    const start = timestamp(match[1]!), end = timestamp(match[2]!); if (end <= start) throw new Error('Invalid WebVTT interval');
    const settings = match[3]!.trim(); let align: PlainTextCue['align'] = 'center';
    if (settings) {
      const setting = /^align:(start|center|end)$/.exec(settings);
      if (!setting) throw new Error('Managed WebVTT positioning/vertical/region settings require another admitted renderer');
      align = setting[1] as PlainTextCue['align'];
    }
    const body = lines.join('\n'); const stack: string[] = [];
    for (const tag of body.match(/<[^>]*>/g) ?? []) {
      const name = /^<(\/?)(b|i|u)>$/.exec(tag);
      if (!name) throw new Error('Managed WebVTT supports only the declared b/i/u markup profile');
      if (name[1]) { if (stack.pop() !== name[2]) throw new Error('Unbalanced text cue markup'); }
      else stack.push(name[2]!);
    }
    if (stack.length) throw new Error('Unbalanced text cue markup');
    result.push({ start, end, text: body, align });
    if (result.length > SUBTITLE_LIMITS.events) throw new Error('Managed text cue budget exceeded');
  }
  return result.sort((a, b) => a.start - b.start);
}
