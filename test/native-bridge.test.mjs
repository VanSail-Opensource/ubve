import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { openMedia } from '../packages/io-demux/dist/index.js';
import { runFragmentedRemux, selectNativeTracks } from '../packages/native-bridge/dist/index.js';
import { CodecNodeWorker } from './helpers/codec-node-worker.mjs';

const fixture = new URL('./fixtures/primary/combined-720p60.mkv', import.meta.url);
const digest = data => createHash('sha256').update(data).digest('hex');
const probe = command => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0;
const haveFfmpeg = probe('ffmpeg') && probe('ffprobe');
const selection = { videoTrackId: 'mkv:1', audioTrackId: 'mkv:2', subtitleTrackId: 'mkv:3' };

async function setup(t) {
  const temp = await mkdtemp(join(tmpdir(), 'ubve-n2-')), file = join(temp, 'bridge.mp4');
  t.after(() => rm(temp, { recursive: true, force: true }));
  await Promise.all([
    copyFile(new URL('../node_modules/@mediabunny/truehd/dist/bundles/mediabunny-truehd.worker.js', import.meta.url), join(temp, 'truehd.worker.js')),
    copyFile(new URL('../node_modules/@mediabunny/flac-encoder/dist/bundles/mediabunny-flac-encoder.worker.js', import.meta.url), join(temp, 'flac.worker.js')),
  ]);
  const originalWorker = globalThis.Worker;
  globalThis.Worker = CodecNodeWorker;
  t.after(() => { globalThis.Worker = originalWorker; });
  const source = await readFile(fixture), media = await openMedia(new Blob([source]));
  t.after(() => media.dispose());
  return { media, source, file, assetBaseUrl: pathToFileURL(temp + '/').href };
}

test('exact AV1/TrueHD/ASS fixture exercises both real WASM workers and the fragmented N2 stream', async t => {
  const { media, source, file, assetBaseUrl } = await setup(t);
  assert.equal(digest(source), '4e681a037ee5a4fdf57ac7512e702012d15b986133e27410e826c45fe76ad187');
  const chunks = [], cuePayload = createHash('sha256');
  let length = 0;
  const stats = await runFragmentedRemux(media, selection, { allowExperimental: true, assetBaseUrl,
    onSubtitle: packet => { assert.equal(packet.durationTicks, 800000000n); cuePayload.update(digest(packet.bytes.borrow()) + '\n'); },
  }, async (data, position) => { assert.equal(position, length); length += data.length; chunks.push(Buffer.from(data)); });
  assert.equal(cuePayload.digest('hex'), '1547915a386a4a1055aebf5999853d67c376620a68dfe1d295c3ee794bdfa3a6');
  assert.deepEqual([stats.route, stats.confidence, stats.videoPackets, stats.audioPackets, stats.subtitlePackets, stats.pcmFrames, stats.fragments, stats.heldBytes], ['N2', 'NOT_QUALIFIED', 48, 960, 24, 38400, 1, 0]);
  assert.deepEqual(stats.sourcePcmChannels, ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']);
  assert.equal(stats.outputBytes, length);
  assert.ok(stats.peakHeldBytes < 32 * 1024 * 1024);
  assert.equal(media.snapshot().packets.bytes, 0);
  const output = Buffer.concat(chunks), container = new Input({ source: new BufferSource(output), formats: ALL_FORMATS });
  try {
    const video = await container.getPrimaryVideoTrack(), audio = await container.getPrimaryAudioTrack();
    assert.equal(await video.getCodecParameterString(), media.tracks[0].codecString);
    assert.deepEqual(await video.getColorSpace(), { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false });
    assert.equal(await audio.getCodec(), 'flac');
    assert.equal(await audio.getSampleRate(), 48000);
    assert.equal(await audio.getNumberOfChannels(), 6);
    const payload = createHash('sha256'), pts = createHash('sha256');
    for await (const packet of new EncodedPacketSink(video).packets()) {
      payload.update(digest(packet.data) + '\n');
      pts.update(String(Math.round(packet.timestamp * 1e9)) + '\n');
    }
    // Independent ffprobe aggregate from I02. Verify exact source AV1 PTS rather
    // than the earlier +/- one 57.6kHz tick reconstruction.
    assert.equal(payload.digest('hex'), 'ea0e5dfaccb9d37ba3f843d432d368745bfd760ae0421d641b8567630c09931a');
    assert.equal(pts.digest('hex'), 'bcb0bcaaba52bef3112e8a2eda9cb65d28b7b1109545bb43528fa28ff2aadfdb');
    let audioFrames = 0;
    for await (const packet of new EncodedPacketSink(audio).packets()) {
      assert.equal(Math.round(packet.timestamp * 48000), audioFrames);
      audioFrames += Math.round(packet.duration * 48000);
    }
    assert.equal(audioFrames, 38400);
  } finally { container.dispose(); }
  await t.test('independent FFmpeg decodes identical 24-bit PCM and observes PQ/BT.2020, FLAC 5.1(side)', {
    skip: !haveFfmpeg && process.env.UBVE_REQUIRE_FFMPEG_EVIDENCE !== '1',
  }, async () => {
    await writeFile(file, output);
    const audio = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s32le', '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8' });
    assert.equal(audio.status, 0, audio.stderr);
    assert.equal(audio.stdout.trim(), 'SHA256=f1db9cca8ab0e76c740f7075359bd5fc8d0bbfc8d9ddfb0ed049da8780de48b8');
    const video = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' });
    assert.equal(video.status, 0, video.stderr);
    const [v, a] = JSON.parse(video.stdout).streams;
    assert.deepEqual([v.codec_name, v.pix_fmt, v.color_space, v.color_transfer, v.color_primaries, v.time_base], ['av1', 'yuv420p10le', 'bt2020nc', 'smpte2084', 'bt2020', '1/1000000']);
    assert.deepEqual([a.codec_name, a.codec_tag_string, a.channel_layout, a.bits_per_raw_sample, a.time_base, a.duration_ts], ['flac', 'fLaC', '5.1(side)', '24', '1/48000', 38400]);
    const videoFrames = path => {
      const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=side_data_list', '-of', 'json', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).frames.map(frame => frame.side_data_list?.filter(({ side_data_type }) => ['Mastering display metadata', 'Content light level metadata'].includes(side_data_type)));
    };
    const sourceFrames = videoFrames(fileURLToPath(fixture)), outputFrames = videoFrames(file);
    assert.equal(sourceFrames.length, 48);
    assert.ok(sourceFrames.every(frame => frame.length === 2), 'independent decoder sees both HDR10 metadata blocks on every frame');
    assert.deepEqual(outputFrames, sourceFrames);
  });
});

test('native remux refuses candidate metadata loss and dropped required ASS', async t => {
  const { media } = await setup(t);
  const video = media.tracks[0];
  const mediaWithMastering = { tracks: [{ ...video, matroskaTrack: { ...video.matroskaTrack, mastering: { maxLuminance: 1000 } } }, ...media.tracks.slice(1)] };
  assert.throws(() => selectNativeTracks(mediaWithMastering, selection), { code: 'UNSUPPORTED_PROFILE' });
  await assert.rejects(runFragmentedRemux(media, selection, { allowExperimental: true }, async () => {}), { code: 'UNSUPPORTED_PROFILE' });
  assert.equal(media.snapshot().packets.bytes, 0);
});
