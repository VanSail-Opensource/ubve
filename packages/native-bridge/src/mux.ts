import { EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, type AudioCodec, type VideoCodec } from 'mediabunny';
import { BudgetLedger, EngineError, OwnedLease, byteLength, type EncodedPacket as CorePacket } from '@ubve/core';
import { packetSeconds, type MediaSourceSession, type MediaTrack } from '@ubve/io-demux';
import { FlacPacketEncoder, TrueHdPacketCodec, type FlacPacket, type IntegerPcmBlock, type TrueHdPacket } from '@ubve/wasm-adapters';

export interface NativeTrackSelection { readonly videoTrackId?: string; readonly audioTrackId?: string; readonly subtitleTrackId?: string; }
export interface RemuxOptions { readonly allowExperimental: true; readonly signal?: AbortSignal; readonly startTime?: number; readonly assetBaseUrl?: string; readonly onSubtitle?: (packet: CorePacket) => void | Promise<void>; }
export interface NativeBridgeStatistics { route: 'N1' | 'N2'; confidence: 'NOT_QUALIFIED'; packets: number; videoPackets: number; audioPackets: number; subtitlePackets: number; outputBytes: number; fragments: number; pcmFrames: number; heldBytes: number; peakHeldBytes: number; mimeType: string; nativeClock: 'single-video-element'; opaqueMuxerMemory: true; source: ReturnType<MediaSourceSession['snapshot']>; }
export interface SelectedNativeTracks { readonly video: MediaTrack | null; readonly audio: MediaTrack | null; readonly subtitle: MediaTrack | null; readonly route: 'N1' | 'N2'; readonly mimeType: string; }

const videos = new Set<VideoCodec>(['avc', 'hevc', 'av1', 'vp9']);
const audios = new Set<AudioCodec>(['aac', 'opus', 'flac', 'mp3', 'ac3', 'eac3']);
export function selectNativeTracks(media: MediaSourceSession, selection: NativeTrackSelection): SelectedNativeTracks {
  const find = (id: string | undefined, kind: MediaTrack['kind']) => {
    if (!id) return null;
    const track = media.tracks.find(track => track.id === id && track.kind === kind);
    if (!track) throw new EngineError('INVALID_ARGUMENT', `Selected ${kind} track does not exist`);
    return track;
  };
  const video = find(selection.videoTrackId, 'video'), audio = find(selection.audioTrackId, 'audio'), subtitle = find(selection.subtitleTrackId, 'subtitle');
  if (!video && !audio) throw new EngineError('INVALID_ARGUMENT', 'Native stream needs one selected video or audio track');
  if (video && (!videos.has(video.codec as VideoCodec) || !video.videoConfig || !video.codecString)) throw new EngineError('UNSUPPORTED_CODEC', 'Video has no admitted unchanged-packet MP4 configuration');
  if (audio && audio.codec !== 'truehd' && (!audios.has(audio.codec as AudioCodec) || !audio.audioConfig || !audio.codecString)) throw new EngineError('UNSUPPORTED_CODEC', 'Audio has no admitted MP4 configuration');
  if (audio?.codec === 'truehd' && (!audio.sampleRate || !audio.channelCount || audio.channelCount > 8)) throw new EngineError('UNSUPPORTED_PROFILE', 'TrueHD bridge needs a known rate and at most eight channels');
  if ([video, audio].some(track => (track?.matroskaTrack?.codecDelayNs ?? 0n) !== 0n)) throw new EngineError('UNSUPPORTED_PROFILE', 'Native remux does not yet qualify container CodecDelay/decoder trim');
  const route = audio?.codec === 'truehd' ? 'N2' : 'N1';
  const codecs = [video?.codecString, audio ? route === 'N2' ? 'flac' : audio.codecString : null].filter(Boolean);
  return { video, audio, subtitle, route, mimeType: `${video ? 'video' : 'audio'}/mp4; codecs="${codecs.join(',')}"` };
}

/** Counts exact fragment samples without expanding attacker-controlled sample tables. */
export function fragmentSampleCounts(bytes: Uint8Array): Map<number, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = new Map<number, number>();
  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 3) throw new EngineError('INVALID_PACKET', 'MP4 fragment nesting exceeds profile');
    let track = 0, samples = 0;
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) throw new EngineError('INVALID_PACKET', 'Truncated fragment box');
      const size = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (size < 8 || offset + size > end) throw new EngineError('INVALID_PACKET', 'Fragment box exceeds bounds');
      if (type === 'moof' || type === 'traf') walk(offset + 8, offset + size, depth + 1);
      if (type === 'tfhd') { if (size < 16) throw new EngineError('INVALID_PACKET', 'Truncated tfhd'); track = view.getUint32(offset + 12); }
      if (type === 'trun') { if (size < 16) throw new EngineError('INVALID_PACKET', 'Truncated trun'); samples += view.getUint32(offset + 12); if (samples > 20000) throw new EngineError('ITEM_TOO_LARGE', 'Fragment exceeds 20000 samples'); }
      offset += size;
    }
    if (track) result.set(track, (result.get(track) ?? 0) + samples);
  };
  walk(0, bytes.length, 0); return result;
}

/** One central packet pass, bounded fragment ownership, and streamed output backpressure. */
export async function runFragmentedRemux(media: MediaSourceSession, selection: NativeTrackSelection, options: RemuxOptions, write: (data: Uint8Array, position: number) => Promise<void>, observe?: (statistics: NativeBridgeStatistics) => void): Promise<NativeBridgeStatistics> {
  if (options.allowExperimental !== true) throw new EngineError('UNSUPPORTED_PROFILE', 'Unqualified native remux requires an explicit experimental opt-in');
  const tracks = selectNativeTracks(media, selection);
  if (tracks.subtitle && !options.onSubtitle) throw new EngineError('UNSUPPORTED_PROFILE', 'Selected subtitles require a native-clock overlay consumer');
  const stats: NativeBridgeStatistics = { route: tracks.route, confidence: 'NOT_QUALIFIED', packets: 0, videoPackets: 0, audioPackets: 0, subtitlePackets: 0, outputBytes: 0, fragments: 0, pcmFrames: 0, heldBytes: 0, peakHeldBytes: 0, mimeType: tracks.mimeType, nativeClock: 'single-video-element', opaqueMuxerMemory: true, source: media.snapshot() };
  const ledger = new BudgetLedger({ bytes: byteLength(32 * 1024 * 1024), maxSingleItemBytes: byteLength(32 * 1024 * 1024), items: 20000 });
  const queued = new Map<number, { lease: OwnedLease<Uint8Array>; timestamp: number }[]>();
  let counts = new Map<number, number>(), outputPosition = 0, firstHeldTimestamp: number | null = null;
  let truehd: TrueHdPacketCodec | null = null, flac: FlacPacketEncoder | null = null;
  let audioConfig = tracks.audio?.audioConfig ?? null;
  let output: Output<Mp4OutputFormat, StreamTarget> | null = null;
  const active = () => { if (options.signal?.aborted) throw options.signal.reason ?? new EngineError('CANCELLED', 'Native remux canceled'); };
  const snapshot = () => { const held = ledger.snapshot(); stats.heldBytes = held.bytes; stats.peakHeldBytes = held.peakBytes; stats.source = media.snapshot(); observe?.({ ...stats }); };
  try {
    if (tracks.route === 'N2') {
      const audio = tracks.audio!;
      truehd = await TrueHdPacketCodec.create({ sampleRate: audio.sampleRate!, channelLabels: Array.from({ length: audio.channelCount! }, (_, i) => `unverified-channel-${i + 1}`), ...(options.assetBaseUrl === undefined ? {} : { assetBaseUrl: options.assetBaseUrl }), timestampResolutionSeconds: Number(media.matroska?.timecodeScaleNs ?? 0n) / 1e9 });
      flac = await FlacPacketEncoder.create({ sampleRate: audio.sampleRate!, channels: audio.channelCount!, ...(options.assetBaseUrl === undefined ? {} : { assetBaseUrl: options.assetBaseUrl }) });
      audioConfig = { codec: 'flac', sampleRate: audio.sampleRate!, numberOfChannels: audio.channelCount!, description: flac.description as Uint8Array<ArrayBuffer> };
    }
    active();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.5,
      onMoof: data => { counts = fragmentSampleCounts(data); stats.fragments++; },
      onMdat: data => {
        if (data.length > 32 * 1024 * 1024 + 16) throw new EngineError('ITEM_TOO_LARGE', 'Fragment serialized media exceeds 32 MiB');
        // The pinned muxer has copied these exact samples into its writer before this callback.
        for (const [track, count] of counts) { const owners = queued.get(track); if (!owners || count > owners.length) throw new EngineError('INTERNAL', 'Fragment sample ownership accounting mismatch'); for (let i = 0; i < count; i++) owners.shift()!.lease.release(); }
        counts.clear(); firstHeldTimestamp = null;
        for (const values of queued.values()) if (values[0]) firstHeldTimestamp = firstHeldTimestamp === null ? values[0].timestamp : Math.min(firstHeldTimestamp, values[0].timestamp);
        snapshot();
      },
    }), target: new StreamTarget(new WritableStream({ write: async chunk => { active(); if (chunk.position !== outputPosition || chunk.data.length > 32 * 1024 * 1024) throw new EngineError('INVALID_PACKET', 'Fragmented writer must be sequential and bounded'); await write(chunk.data, chunk.position); outputPosition += chunk.data.length; stats.outputBytes = outputPosition; snapshot(); } }), { chunked: true, chunkSize: 512 * 1024 }) });
    const videoSource = tracks.video ? new EncodedVideoPacketSource(tracks.video.codec as VideoCodec) : null;
    const audioSource = tracks.audio ? new EncodedAudioPacketSource(tracks.route === 'N2' ? 'flac' : tracks.audio.codec as AudioCodec) : null;
    // Pinned Mediabunny 1.66.4 assigns MP4 IDs in this insertion order. The fragment
    // sample-count test verifies that identity without accessing its private track fields.
    const videoOutputId = videoSource ? 1 : 0, audioOutputId = audioSource ? videoSource ? 2 : 1 : 0;
    if (videoSource) { output.addVideoTrack(videoSource, { decoderConfig: tracks.video!.videoConfig!, ...(tracks.video!.name ? { name: tracks.video!.name } : {}) }); queued.set(videoOutputId, []); }
    if (audioSource) { output.addAudioTrack(audioSource, { decoderConfig: audioConfig!, ...(tracks.audio!.name ? { name: tracks.audio!.name } : {}) }); queued.set(audioOutputId, []); }
    const add = async (trackId: number, source: EncodedVideoPacketSource | EncodedAudioPacketSource, data: Uint8Array, key: boolean, timestamp: number, duration: number, sequence: number) => {
      active();
      if (firstHeldTimestamp !== null && timestamp - firstHeldTimestamp > 8) throw new EngineError('UNSUPPORTED_PROFILE', 'No fragment recovery boundary within eight seconds');
      const reservation = ledger.tryReserve(byteLength(data.length)); if (!reservation) throw new EngineError('ITEM_TOO_LARGE', 'One remux fragment exceeds the 32 MiB/20000-packet admission');
      let owner: OwnedLease<Uint8Array>;
      try { owner = OwnedLease.adopt<Uint8Array>(reservation, data.slice()); } catch (error) { reservation.release(); throw error; }
      queued.get(trackId)!.push({ lease: owner, timestamp }); firstHeldTimestamp ??= timestamp; snapshot();
      await source.add(new EncodedPacket(owner.borrow(), key ? 'key' : 'delta', timestamp, duration, sequence));
    };
    await output.start();
    let batch: TrueHdPacket[] = [], batchBytes = 0, audioSequence = 0;
    const channels = tracks.audio?.channelCount ?? 1, sampleRate = tracks.audio?.sampleRate ?? 48000;
    const aggregate = new Int32Array(4096 * channels); let aggregateFrames = 0, aggregateStart = 0;
    const addFlac = async (packets: FlacPacket[]) => { for (const packet of packets) await add(audioOutputId, audioSource!, packet.data, true, packet.firstSample / sampleRate, packet.frames / sampleRate, audioSequence++); };
    const emitAggregate = async () => { if (!aggregateFrames) return; await addFlac(await flac!.encode({ data: aggregate.subarray(0, aggregateFrames * channels), firstSample: aggregateStart, frames: aggregateFrames, channels, sampleRate })); aggregateFrames = 0; };
    const consumePcm = async (block: IntegerPcmBlock) => {
      stats.pcmFrames += block.frames; let offset = 0;
      while (offset < block.frames) {
        if (!aggregateFrames) aggregateStart = block.firstSample + offset;
        else if (aggregateStart + aggregateFrames !== block.firstSample + offset) throw new EngineError('UNSUPPORTED_PROFILE', 'Audio epoch discontinuity cannot be flattened by remux');
        const count = Math.min(4096 - aggregateFrames, block.frames - offset);
        aggregate.set(block.data.subarray(offset * channels, (offset + count) * channels), aggregateFrames * channels); aggregateFrames += count; offset += count;
        if (aggregateFrames === 4096) await emitAggregate();
      }
    };
    const decodeBatch = async () => { if (!batch.length) return; const packets = batch; batch = []; batchBytes = 0; for (const block of await truehd!.decode(packets)) await consumePcm(block); };
    const ids = [tracks.video?.id, tracks.audio?.id, tracks.subtitle?.id].filter((id): id is string => Boolean(id));
    for await (const packet of media.packets(ids, { ...(options.startTime === undefined ? {} : { startTime: options.startTime }), ...(options.signal === undefined ? {} : { signal: options.signal }) })) {
      try {
        active(); stats.packets++;
        if (packet.discardPaddingNs !== 0n) throw new EngineError('UNSUPPORTED_PROFILE', 'DiscardPadding requires an implemented trim transform before native playback');
        const timing = packetSeconds(packet);
        if (packet.trackId === tracks.video?.id) { stats.videoPackets++; await add(videoOutputId, videoSource!, packet.bytes.borrow(), packet.recovery === 'key', timing.timestamp, timing.duration, packet.decodeSequence); }
        else if (packet.trackId === tracks.audio?.id) {
          stats.audioPackets++;
          if (truehd) {
            const data = packet.bytes.borrow(); if (data.length > 4 * 1024 * 1024) throw new EngineError('ITEM_TOO_LARGE', 'TrueHD packet exceeds bridge batch budget');
            if (batchBytes + data.length > 4 * 1024 * 1024) await decodeBatch();
            batch.push({ data: data.slice(), timestampSamples: Math.round(timing.timestamp * sampleRate) }); batchBytes += data.length;
            if (batch.length >= 26) await decodeBatch();
          } else await add(audioOutputId, audioSource!, packet.bytes.borrow(), packet.recovery === 'key', timing.timestamp, timing.duration, packet.decodeSequence);
        } else { stats.subtitlePackets++; await options.onSubtitle?.(packet); }
      } finally { packet.bytes.release(); }
    }
    if (truehd) { await decodeBatch(); await truehd.flush(); await emitAggregate(); await addFlac(await flac!.flush()); }
    await output.finalize(); active();
    if (ledger.snapshot().bytes !== 0) throw new EngineError('INTERNAL', 'Finalized muxer still owns encoded packets');
    stats.mimeType = await output.getMimeType(); snapshot(); return stats;
  } finally {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
    for (const values of queued.values()) for (const value of values) value.lease.release();
    await truehd?.dispose(); flac?.dispose(); snapshot();
  }
}
