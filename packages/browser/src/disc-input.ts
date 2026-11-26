import { EngineError, sessionStamp, type RandomAccessSource } from '@ubve/core';
import { DiscSession, DiscTitleReader, validateLinearTitle, type DiscTitle, type LocalDiscFile } from '@ubve/disc';
import { operationContext, type MediaSourceSession } from '@ubve/io-demux';

export type LocalBluRay = File | readonly LocalDiscFile[];
/** Whole original clip, explicitly selected within a local clear Blu-ray title. Not MPLS title playback. */
export interface BluRayClipInput {
  readonly kind: 'bluray-clip';
  readonly disc: LocalBluRay;
  readonly title: number;
  readonly clip: number;
  readonly label?: string;
}
export interface BluRayClipChoice {
  readonly title: number;
  readonly playlist: number;
  readonly clip: number;
  readonly stream: string;
}
export const isDiscImageName = (filename: string): boolean => /\.(iso|udf)$/i.test(filename);
const begin = (input: LocalBluRay, signal: AbortSignal | undefined, assets: string) => DiscSession.open(input,
  { ...(signal ? { signal } : {}), workerUrl: `${assets.replace(/\/?$/, '/')}disc/disc-worker.mjs` });

function choices(title: DiscTitle): BluRayClipChoice[] {
  try { validateLinearTitle(title); } catch { return []; }
  if (title.clips.some(clip => clip.video.length !== 1)) return [];
  return title.clips.flatMap((clip, index) => {
    const video = clip.video[0]!;
    // Do not silently drop embedded PGS or an unsupported selected audio track.
    return [0x1b, 0x24].includes(video.codingType) && clip.pgs.length === 0 &&
      clip.audio.every(audio => [0x81, 0x84, 0x87].includes(audio.codingType))
      ? [{ title: title.index, playlist: title.playlist, clip: index, stream: `${clip.id}.m2ts` }] : [];
  });
}

export async function inspectBluRayClips(input: LocalBluRay, options: { signal?: AbortSignal; assetBaseUrl?: string } = {}): Promise<readonly BluRayClipChoice[]> {
  const owner = await begin(input, options.signal, options.assetBaseUrl ?? '/vendor/');
  try {
    const available: BluRayClipChoice[] = [];
    for (const title of owner.inventory?.titles ?? []) {
      const discovered = choices(title);
      if (available.length + discovered.length > 2048) throw new EngineError('ITEM_TOO_LARGE', 'Blu-ray clip picker exceeds its 2048-entry limit');
      available.push(...discovered);
    }
    if (!available.length) throw new EngineError('UNSUPPORTED_PROFILE', 'No clear, single-angle Blu-ray clip with admitted video/audio and no embedded PGS was found');
    return available;
  } finally { await owner.close(); }
}

export async function openBluRayClip(input: BluRayClipInput, signal: AbortSignal, assets: string): Promise<{
  source: RandomAccessSource;
  validate(media: MediaSourceSession): void;
}> {
  const owner = await begin(input.disc, signal, assets);
  try {
    const title = owner.inventory?.titles.find(candidate => candidate.index === input.title);
    if (!title || !choices(title).some(choice => choice.clip === input.clip)) throw new EngineError('UNSUPPORTED_PROFILE', 'Choose an admitted clip from this local Blu-ray');
    const reader = DiscTitleReader.select(owner, input.title, title.clips.map(clip => ({ videoPid: clip.video[0]!.pid })));
    const { source } = await reader.openClip(input.clip, operationContext(sessionStamp(crypto.randomUUID(), 0), 'disc-clip-open', signal, 10000));
    const clip = title.clips[input.clip]!;
    let closing: Promise<void> | null = null;
    return {
      source: { ...source, close() { return closing ??= (async () => { try { await source.close(); } finally { await owner.close(); } })(); } },
      validate(media) {
        const expected = [...clip.video, ...clip.audio].map(x => x.pid).sort((a, b) => a - b);
        const received = media.tracks.map(track => track.transportPid ?? -1).sort((a, b) => a - b);
        if (media.container !== 'mpegts' || expected.length !== received.length || expected.some((pid, i) => pid !== received[i])) {
          throw new EngineError('UNSUPPORTED_PROFILE', 'The transport program does not match the chosen Blu-ray clip streams');
        }
      },
    };
  } catch (error) { await owner.close().catch(() => undefined); throw error; }
}
