import { EngineError, byteRange, type OperationContext, type RandomAccessSource } from '@ubve/core';
import { type DiscClip, type DiscStream, type DiscTitle, validateLinearTitle } from './folder.js';
import type { DiscSession } from './session.js';

const M2TS_PACKET_BYTES = 192;
const PREFIX_PACKETS = 8;

export interface DiscClipTrackSelection {
  readonly videoPid: number;
  readonly audioPid?: number;
  readonly pgsPid?: number;
}
export interface DiscClipPlan {
  readonly index: number;
  readonly path: string;
  readonly playlistStart90k: bigint;
  readonly playlistEnd90k: bigint;
  readonly sourceStart90k: bigint;
  readonly sourceEnd90k: bigint;
  readonly streams: { readonly video: DiscStream; readonly audio: DiscStream | null; readonly pgs: DiscStream | null };
}
export interface OpenedDiscClip {
  readonly clip: DiscClipPlan;
  /** Original .m2ts extent-backed source. The caller owns this file handle, not the shared disc. */
  readonly source: RandomAccessSource;
  /** A format/protection preview only, not a guarantee of complete essence admission. */
  readonly checkedHeaderPackets: number;
}

function selectStream(streams: readonly DiscStream[], pid: number | undefined, kind: string): DiscStream | null {
  if (pid === undefined) return null;
  if (!Number.isInteger(pid) || pid < 0x20 || pid >= 0x1fff) throw new EngineError('INVALID_ARGUMENT', `Invalid selected ${kind} PID`);
  const match = streams.filter(stream => stream.pid === pid);
  if (match.length !== 1) throw new EngineError('UNSUPPORTED_PROFILE', `Selected ${kind} PID ${pid} is not uniquely declared in the clip`);
  const stream = match[0]!;
  for (const value of [stream.codingType, stream.format, stream.rate, stream.dynamicRange, stream.colorSpace])
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new EngineError('INVALID_MEDIA', `Malformed selected ${kind} stream descriptor`);
  // A verified clip-local identity is not inferred to mean continuity across clips.
  return Object.freeze({ ...stream });
}
function planClip(clip: DiscClip, index: number, choice: DiscClipTrackSelection): DiscClipPlan {
  const playlistStart90k = BigInt(clip.start90k), sourceStart90k = BigInt(clip.in90k), sourceEnd90k = BigInt(clip.out90k);
  const video = selectStream(clip.video, choice.videoPid, 'video');
  if (!video) throw new EngineError('INVALID_ARGUMENT', 'Disc clips require an explicit video PID');
  const audio = selectStream(clip.audio, choice.audioPid, 'audio'), pgs = selectStream(clip.pgs, choice.pgsPid, 'PGS');
  const pids = [video.pid, ...(audio ? [audio.pid] : []), ...(pgs ? [pgs.pid] : [])];
  if (new Set(pids).size !== pids.length) throw new EngineError('INVALID_MEDIA', 'Selected disc PIDs collide across stream kinds');
  return Object.freeze({ index, path: `BDMV/STREAM/${clip.id}.m2ts`, playlistStart90k, playlistEnd90k: playlistStart90k + sourceEnd90k - sourceStart90k,
    sourceStart90k, sourceEnd90k, streams: Object.freeze({ video, audio, pgs }) });
}

/** Validate a Blu-ray 192-byte packet prefix. Parser/decoder admission remains separate. */
function checkM2tsPrefix(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i += M2TS_PACKET_BYTES) {
    const sync = bytes[i + 4]!, flags = bytes[i + 5]!, transportControl = bytes[i + 7]!;
    if (sync !== 0x47 || flags >= 0x80) throw new EngineError('INVALID_MEDIA', 'Invalid M2TS sync or transport error in clip prefix');
    const adaptation = Math.floor(transportControl / 16) % 4;
    if (adaptation === 0) throw new EngineError('INVALID_MEDIA', 'Reserved M2TS adaptation control in clip prefix');
    if (transportControl >= 0x40) throw new EngineError('ENCRYPTED_MEDIA', 'Scrambled transport packets are outside the clear-title profile');
    if (adaptation >= 2) {
      const size = bytes[i + 8]!;
      if ((adaptation === 2 && size !== 183) || (adaptation === 3 && size > 182)) throw new EngineError('INVALID_MEDIA', 'Invalid M2TS adaptation extent');
    }
  }
  return bytes.length / M2TS_PACKET_BYTES;
}

/** Exact playlist navigation and lazy clip source opening, not an A/V playback claim. */
export class DiscTitleReader {
  readonly titleIndex: number;
  readonly playlist: number;
  readonly duration90k: bigint;
  readonly clips: readonly DiscClipPlan[];
  readonly #disc: DiscSession;
  private constructor(disc: DiscSession, title: DiscTitle, choices: readonly DiscClipTrackSelection[]) {
    this.#disc = disc;
    this.titleIndex = title.index; this.playlist = title.playlist; this.duration90k = BigInt(title.duration90k);
    this.clips = Object.freeze(title.clips.map((clip, index) => planClip(clip, index, choices[index]!)));
  }
  static select(disc: DiscSession, titleIndex: number, choices: readonly DiscClipTrackSelection[]): DiscTitleReader {
    if (!Number.isInteger(titleIndex) || titleIndex < 0) throw new EngineError('INVALID_ARGUMENT', 'An explicit nonnegative Blu-ray title index is required');
    const inventory = disc.inventory;
    if (!inventory) throw new EngineError('UNSUPPORTED_PROFILE', 'UDF-only filesystem inspection has no title plan');
    const matches = inventory.titles.filter(title => title.index === titleIndex);
    if (matches.length !== 1) throw new EngineError('INVALID_ARGUMENT', 'Blu-ray title is not uniquely present');
    const title = matches[0]!;
    validateLinearTitle(title);
    if (choices.length !== title.clips.length || title.clips.some((_, index) => !choices[index]))
      throw new EngineError('INVALID_ARGUMENT', 'Select video, audio and subtitle PIDs explicitly for each clip');
    return new DiscTitleReader(disc, title, choices);
  }
  locate(playlist90k: bigint): { readonly clip: DiscClipPlan; readonly source90k: bigint } {
    if (typeof playlist90k !== 'bigint' || playlist90k < 0n || playlist90k >= this.duration90k) throw new EngineError('INVALID_ARGUMENT', 'Seek is outside the selected title');
    let first = 0, end = this.clips.length;
    while (first < end) {
      const mid = first + Math.floor((end - first) / 2);
      if (this.clips[mid]!.playlistEnd90k <= playlist90k) first = mid + 1; else end = mid;
    }
    const clip = this.clips[first]!;
    return { clip, source90k: clip.sourceStart90k + playlist90k - clip.playlistStart90k };
  }
  /** Returns null on preroll or after the clip cut. Decoders still need to consume their preroll. */
  mapSourceTime(clipIndex: number, source90k: bigint): bigint | null {
    const clip = this.#clip(clipIndex);
    if (typeof source90k !== 'bigint') throw new EngineError('INVALID_ARGUMENT', 'Source PTS must be in exact 90 kHz ticks');
    return source90k < clip.sourceStart90k || source90k >= clip.sourceEnd90k ? null : clip.playlistStart90k + source90k - clip.sourceStart90k;
  }
  #clip(index: number): DiscClipPlan {
    if (!Number.isInteger(index) || index < 0 || index >= this.clips.length) throw new EngineError('INVALID_ARGUMENT', 'Blu-ray clip index is outside the selected title');
    return this.clips[index]!;
  }
  async openClip(index: number, operation: OperationContext): Promise<OpenedDiscClip> {
    const clip = this.#clip(index), source = await this.#disc.source(clip.path, operation);
    try {
      if (source.size < M2TS_PACKET_BYTES * 2 || source.size % M2TS_PACKET_BYTES !== 0)
        throw new EngineError('INVALID_MEDIA', 'Clip is not a whole sequence of Blu-ray 192-byte transport packets');
      const limit = Math.min(source.size, M2TS_PACKET_BYTES * PREFIX_PACKETS);
      const read = await source.readExact(byteRange(0, limit), operation);
      try { return { clip, source, checkedHeaderPackets: checkM2tsPrefix(read.bytes.borrow()) }; }
      finally { read.bytes.release(); }
    } catch (error) { await source.close(); throw error; }
  }
}
