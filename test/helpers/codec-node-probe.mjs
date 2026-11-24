// Untimed production adapter probe. The Node-only worker shim supplies transport, not decode.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CodecNodeWorker } from './codec-node-worker.mjs';
import { assessPrimaryHdr10, sessionStamp } from '../../packages/core/dist/index.js';
import { openMedia, operationContext } from '../../packages/io-demux/dist/index.js';
import { Av1Decoder, TrueHdDecoder } from '../../packages/wasm-adapters/dist/index.js';

const assetBaseUrl = new URL('../../apps/vue-player/public/vendor/', import.meta.url).href;
const sha = data => createHash('sha256').update(data).digest('hex');
const rational = value => `${value.numerator}/${value.denominator}`;
const point = value => [rational(value.x), rational(value.y)];
const rejectWithin = (promise, ms, message) => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

export class CodecNodeProbe {
  static async open(source, { threads = 4, outputFrames = 2, audio = false } = {}) {
    globalThis.Worker = CodecNodeWorker;
    const setup = new CodecNodeProbe();
    setup.stamp = sessionStamp(crypto.randomUUID(), 0);
    try {
      setup.media = await openMedia(new Blob([source]), { stamp: setup.stamp });
      const options = { stamp: setup.stamp, assetBaseUrl, outputFrames };
      const vt = setup.media.tracks.find(track => track.codec === 'av1');
      const at = setup.media.tracks.find(track => track.codec === 'truehd');
      assert.ok(vt?.width && vt.height, 'Selected AV1 video needs known geometry');
      setup.video = await Av1Decoder.create({ ...options, width: vt.width, height: vt.height, description: vt.codecPrivate, threads });
      setup.routes = new Map([[vt.id, setup.video]]);
      if (audio) {
        assert.ok(at?.sampleRate && at.channelCount, 'Selected TrueHD needs sample rate and channels');
        setup.audio = await TrueHdDecoder.create({ ...options, sampleRate: at.sampleRate, channelLabels: Array.from({ length: at.channelCount }, (_, i) => `ch${i}`), timestampResolutionSeconds: Number(setup.media.matroska?.timecodeScaleNs ?? 0n) / 1e9 });
        setup.routes.set(at.id, setup.audio);
      }
      return setup;
    } catch (error) { await setup.dispose().catch(() => {}); throw error; }
  }
  async reset(stamp) {
    await Promise.all([...this.routes.values()].map(decoder => decoder.reset(stamp, operationContext(stamp, 'reset', undefined, 15_000))));
    this.stamp = stamp;
  }
  async dispose() {
    const results = await Promise.allSettled([this.video?.dispose(), this.audio?.dispose(), this.media?.dispose()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  async run({ expectedVideoFrames = 0, allowUnknownHdrFields = false, expectedStaticHdr } = {}) {
    const abort = new AbortController(), op = name => operationContext(this.stamp, name, abort.signal, 15_000);
    const pcm = createHash('sha256'), videoSha256 = [], videoOrigins = new Map();
    let held, hdr, samples = 0, audioNext = null, videoLedgerItemsAtEos, allHdrFieldsAdmitted = true;
    const consume = Promise.all([...this.routes.values()].map(decoder => (async () => {
      for (;;) {
        const output = await decoder.readOutput(op('read'));
        if (!output) break;
        try {
          const payload = output.payload.borrow();
          assert.deepEqual(output.stamp, this.stamp);
          if (payload.kind === 'video') {
            const packet = videoOrigins.get(output.sourcePacketId);
            assert.ok(packet, 'An output must identify its original packet');
            assert.deepEqual(output.pts, { ticks: packet.ptsTicks, timeBase: packet.timeBase });
            assert.equal(output.durationTicks, packet.durationTicks);
            videoOrigins.delete(output.sourcePacketId);
            assert.equal(payload.format, 'I420P10');
            assert.ok(payload.signalMetadata);
            const metadata = payload.signalMetadata;
            const admission = assessPrimaryHdr10(metadata);
            allHdrFieldsAdmitted &&= admission.admitted;
            if (!allowUnknownHdrFields) assert.equal(admission.admitted, true, admission.reasons.join(', '));
            if ((expectedStaticHdr || !hdr) && metadata.masteringDisplay.state === 'known' && metadata.contentLightLevel.state === 'known') {
              const value = metadata.masteringDisplay.value;
              const staticHdr = { red: point(value.red), green: point(value.green), blue: point(value.blue), white: point(value.white), minimumLuminance: rational(value.minimumLuminance), maximumLuminance: rational(value.maximumLuminance), ...metadata.contentLightLevel.value };
              if (expectedStaticHdr) assert.deepEqual(staticHdr, expectedStaticHdr);
              hdr ??= staticHdr;
            }
            videoSha256.push(sha(payload.data));
            if (expectedVideoFrames && videoSha256.length === expectedVideoFrames) {
              held = output.payload.move();
              break;
            }
          } else {
            assert.equal(payload.validBits, 24);
            if (audioNext !== null) assert.equal(output.pts.ticks, audioNext);
            audioNext = output.pts.ticks + BigInt(payload.frames);
            samples += payload.frames;
            pcm.update(payload.planes[0]);
          }
        } finally { output.payload.release(); }
      }
    })()));
    const produce = (async () => {
      for await (const packet of this.media.packets([...this.routes.keys()], { stamp: this.stamp, signal: abort.signal })) {
        const decoder = this.routes.get(packet.trackId);
        if (decoder === this.video) videoOrigins.set(packet.id, { ptsTicks: packet.ptsTicks, timeBase: packet.timeBase, durationTicks: packet.durationTicks });
        try {
          const work = decoder.trySubmit(packet, op('submit'));
          if (work.status !== 'accepted') throw work.error ?? Error(`Unexpected backpressure: ${work.reason}`);
          await work.inputConsumed;
        } finally { packet.bytes.release(); }
      }
      await Promise.all([...this.routes.values()].map(decoder => decoder.flushEndOfStream(op('eos'))));
    })();
    try {
      await rejectWithin(Promise.all([produce, consume]), 20_000, 'Component decode transaction did not finish');
      videoLedgerItemsAtEos = this.video.snapshot().output.items;
      if (held) assert.equal(await this.video.readOutput(op('verify-eos')), null);
      const observedVideoThreads = this.video.diagnostics().environment.childThreads;
      return { videoSha256, hdr, allHdrFieldsAdmitted, samples, audioSha256: pcm.digest('hex'), videoLedgerItemsAtEos, observedVideoThreads };
    } catch (error) { abort.abort(); throw error; }
    finally { held?.release(); }
  }
}
