import { EngineError, requireCondition } from '@ubve/core';
export interface LocalDiscFile { readonly path: string; readonly blob: Blob; }
export const UDF_MAX_IMAGE_BYTES = (2n ** 32n - 1n) * 2048n;
export function normalizeDiscPath(value: string): string {
  requireCondition(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'Invalid local disc path');
  const parts = value.replaceAll('\\', '/').replace(/^\/+/, '').split('/');
  requireCondition(parts.every(p => p.length > 0 && p !== '.' && p !== '..' && !p.includes(':')), 'Disc path contains a prohibited component');
  return parts.join('/');
}
/** Lookup keys are folded only after rejecting ambiguous entries. Blob data stays on disk. */
export class DiscFolder {
  readonly files: readonly LocalDiscFile[];
  readonly #lookup = new Map<string, LocalDiscFile>();
  constructor(files: readonly LocalDiscFile[]) {
    requireCondition(files.length > 0 && files.length <= 16384, 'Disc folder requires 1..16384 files');
    const paths = files.map(f => normalizeDiscPath(f.path));
    const roots = new Set(paths.map(p => { const parts = p.split('/'); const at = parts.findIndex(v => v.toUpperCase() === 'BDMV'); return at < 0 ? null : parts.slice(0, at).join('/'); }).filter(p => p !== null));
    requireCondition(roots.size <= 1, 'Multiple disc roots need separate selections');
    const prefix = [...roots][0];
    const normalized: LocalDiscFile[] = [];
    for (let i = 0; i < files.length; i++) {
      let path = paths[i]!;
      if (prefix && path.startsWith(prefix + '/')) path = path.slice(prefix.length + 1);
      const key = path.toUpperCase();
      requireCondition(!this.#lookup.has(key), `Ambiguous case-folded disc path: ${path}`);
      if (/(^|\/)(AACS|BDSVM|BDPLUS)(\/|$)/i.test(path)) throw new EngineError('ENCRYPTED_MEDIA', 'Encrypted/protected discs are outside the read-only profile');
      const blob = files[i]!.blob;
      requireCondition(blob instanceof Blob && Number.isSafeInteger(blob.size) && blob.size >= 0, 'Invalid local Blob or file size');
      const item = { path, blob }; this.#lookup.set(key, item); normalized.push(item);
    }
    for (const file of normalized) {
      const parts = file.path.toUpperCase().split('/');
      for (let at = 1; at < parts.length; at++) requireCondition(!this.#lookup.has(parts.slice(0, at).join('/')), 'Disc path is both a file and a directory');
    }
    this.files = Object.freeze(normalized);
  }
  get(path: string): Blob | null { return this.#lookup.get(normalizeDiscPath(path).toUpperCase())?.blob ?? null; }
  children(path = ''): readonly string[] {
    const prefix = path ? normalizeDiscPath(path).toUpperCase() + '/' : '';
    const names = new Map<string, string>();
    for (const file of this.files) {
      if (!file.path.toUpperCase().startsWith(prefix)) continue;
      const child = file.path.slice(prefix.length).split('/')[0]!;
      names.set(child.toUpperCase(), child);
    }
    if (names.size > 4096) throw new EngineError('ITEM_TOO_LARGE', 'Disc directory exceeds 4096 entries');
    return [...names.values()].sort();
  }
}
export interface DiscStream { readonly pid: number; readonly codingType: number; readonly format: number; readonly rate: number; readonly dynamicRange: number; readonly colorSpace: number; }
export interface DiscClip {
  readonly id: string; readonly start90k: string; readonly in90k: string; readonly out90k: string;
  readonly stillMode: number; readonly video: readonly DiscStream[]; readonly audio: readonly DiscStream[]; readonly pgs: readonly DiscStream[];
}
export interface DiscTitle {
  readonly index: number; readonly playlist: number; readonly duration90k: string; readonly angles: number;
  readonly clips: readonly DiscClip[]; readonly chapters: readonly { readonly start90k: string; readonly duration90k: string; readonly clip: number }[];
}
export interface DiscInventory { readonly provider: 'libbluray-1.5.0'; readonly timeBase: '1/90000'; readonly titles: readonly DiscTitle[]; }
export function validateLinearTitle(title: DiscTitle): void {
  if (title.angles !== 1) throw new EngineError('UNSUPPORTED_PROFILE', 'Only single-angle titles are admitted');
  requireCondition(title.clips.length > 0 && title.clips.length <= 1024, 'Invalid title clip count');
  let total = 0n;
  for (const clip of title.clips) {
    requireCondition(/^\d{5}$/.test(clip.id) && /^\d+$/.test(clip.start90k) && /^\d+$/.test(clip.in90k) && /^\d+$/.test(clip.out90k), 'Malformed title clock or clip ID');
    if (clip.stillMode !== 0) throw new EngineError('UNSUPPORTED_PROFILE', 'Still/menu titles are not admitted');
    const start=BigInt(clip.start90k), begin=BigInt(clip.in90k), end=BigInt(clip.out90k);
    requireCondition(end > begin && start === total, 'Title has invalid or non-linear clip spans');
    total += end - begin;
  }
  requireCondition(/^\d+$/.test(title.duration90k) && BigInt(title.duration90k) === total, 'Title duration does not match clip trims');
  requireCondition(title.chapters.length <= 10000, 'Too many title chapters');
  for(const chapter of title.chapters) requireCondition(Number.isSafeInteger(chapter.clip) && chapter.clip >= 0 && chapter.clip < title.clips.length && /^\d+$/.test(chapter.start90k) && /^\d+$/.test(chapter.duration90k) && BigInt(chapter.start90k) + BigInt(chapter.duration90k) <= total, 'Invalid chapter');
}
export function locateTitleTime(title: DiscTitle, time90k: bigint): { readonly clip: DiscClip; readonly clipIndex: number; readonly mediaTime90k: bigint } {
  validateLinearTitle(title);
  requireCondition(time90k >= 0n && time90k < BigInt(title.duration90k), 'Seek is outside the title');
  for(let i=0;i<title.clips.length;i++){
    const clip=title.clips[i]!, start=BigInt(clip.start90k), end=start+BigInt(clip.out90k)-BigInt(clip.in90k);
    if(time90k<end)return {clip,clipIndex:i,mediaTime90k:BigInt(clip.in90k)+time90k-start};
  }
  throw new EngineError('INTERNAL','Validated title seek has no clip');
}
