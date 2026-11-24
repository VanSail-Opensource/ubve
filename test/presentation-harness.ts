import { PcmOutput, SubtitleController, PgsDecoder } from '../packages/presentation/src/index.js';
import type { PcmEvent, SubtitleStatus } from '../packages/presentation/src/index.js';

const check = (condition: unknown, text: string): void => { if (!condition) throw new Error(text); };
const wait = async (predicate: () => boolean): Promise<void> => {
  const until = performance.now() + 7000;
  while (!predicate()) { if (performance.now() > until) throw new Error('Presentation check deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

async function audioChecks(): Promise<unknown> {
  const events: PcmEvent[] = [];
  const audio = await PcmOutput.create({ sampleRate: 48000, channelLabels: ['FL', 'FR'], blockFrames: 256, poolBlocks: 16, primeMs: 8, onEvent: event => events.push(event) });
  try {
    audio.setVolume(0);
    const block = new Float32Array(512);
    for (let i = 0; i < 256; i++) { block[i * 2] = i / 65536; block[i * 2 + 1] = -i / 65536; }
    check(audio.tryWrite(block, 0n) && audio.tryWrite(block, 256n), 'Initial pool admission failed');
    const started = await audio.start();
    await wait(() => events.some(event => event.type === 'underrun'));
    const missing = events.find(event => event.type === 'underrun')!.nextMediaSample;
    audio.tryWrite(block, 512n);
    await wait(() => events.some(event => event.type === 'rejected' && event.reason === 'NOT_ACCEPTING'));
    const frozen = audio.snapshot!.nextMediaSample;
    check(missing === 512 && frozen === 512, 'Underrun did not freeze at the missing source sample');
    await audio.reset(BigInt(missing));
    check(audio.tryWrite(block, BigInt(missing)) && audio.tryWrite(block, BigInt(missing + 256)), 'Reprime pool admission failed');
    await audio.end(BigInt(missing + 512)); const restarted = await audio.start();
    await wait(() => events.some(event => event.type === 'ended' && event.epoch === 1));
    const final = audio.snapshot!;
    check(final.nextMediaSample === 1024 && final.underruns === 1, 'Reprime/EOS sample boundary mismatch');
    await audio.reset(10000n);
    check(audio.tryWrite(block, 10000n) && audio.tryWrite(block, 10256n), 'Seek pool admission failed');
    const paused = await audio.pause(); check(paused === 10000n, 'Paused seek advanced media');
    await audio.end(10512n); await audio.start();
    await wait(() => events.some(event => event.type === 'ended' && event.epoch === 2));
    await audio.dispose();
    check(audio.context.state === 'closed', 'AudioContext did not close');
    return { status: 'PASS', started, missing, frozen, restarted, final, paused: String(paused),
      disposed: audio.context.state, transportBytes: audio.transportBytes, events };
  } finally { await audio.dispose(); }
}

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
YCbCr Matrix: TV.709
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,32,&H00FFFFFF,&H0000FFFF,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,24,24,24,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:20.00,Default,,0,0,0,,{\\pos(320,310)\\blur(1)}ASS worker: motion, shaping & outlines
Dialogue: 1,0:00:00.00,0:00:20.00,Default,,0,0,0,,{\\move(60,65,580,65)\\c&H78EEAA&\\k100}UBVE
`;

const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/text" xml:lang="en"><head><styling><style xml:id="base" tts:fontSize="10%" tts:color="white" tts:textAlign="center"/></styling><layout><region xml:id="bottom" tts:origin="10% 60%" tts:extent="80% 30%"/></layout></head><body region="bottom" style="base"><div><p begin="0s" end="4s">IMSC timed text</p><p begin="4s" end="8s">Second cue</p></div></body></tt>`;

async function subtitleChecks(): Promise<unknown> {
  const video = document.querySelector('video')!;
  const overlay = document.querySelector<HTMLElement>('#overlay')!;
  const statuses: SubtitleStatus[] = [];
  const subtitles = new SubtitleController({ video, overlay, onStatus: status => statuses.push(status) });
  try {
    await subtitles.load({ kind: 'ass', data: ass });
    await subtitles.renderAt(1, 640, 360); check(subtitles.getStatus().renderer === 'jassub-2.5.38', 'ASS worker not initialized');
    await subtitles.setQuality('performance'); check(subtitles.getStatus().rasterCap === 1080, 'Subtitle raster cap not reported');
    await subtitles.load({ kind: 'ass', data: ass.split('Dialogue:')[0]!, streaming: true });
    await subtitles.addPacket({ kind: 'ass', data: new TextEncoder().encode('0,0,Default,,0,0,0,,Streamed ASS'), ptsSeconds: 1, durationSeconds: 2, epoch: 0 });
    await subtitles.renderAt(1.5, 640, 360); check(subtitles.getStatus().eventCount === 1, 'ASS stream packet not admitted');
    await subtitles.resetStream(1); check(subtitles.getStatus().eventCount === 0, 'ASS epoch not cleared');
    await subtitles.load({ kind: 'ttml', data: ttml });
    await subtitles.renderAt(1, 640, 360); check(overlay.textContent?.includes('IMSC timed text'), 'IMSC first cue absent');
    await subtitles.renderAt(5, 640, 360); check(overlay.textContent?.includes('Second cue') && !overlay.textContent.includes('IMSC timed text'), 'IMSC cue update failed');
    await subtitles.renderAt(1, 640, 360); check(overlay.textContent?.includes('IMSC timed text'), 'IMSC backward seek failed');
    await subtitles.clear(); check(!overlay.childElementCount && !subtitles.requiresOverlay, 'Subtitle clear leaked output');
    // Leave the animated ASS example for an independent visual inspection.
    await subtitles.load({ kind: 'ass', data: ass }); await subtitles.renderAt(2, 640, 360);
    return { status: 'PASS', statuses, final: subtitles.getStatus(), visualInspectionRequired: true,
      scope: 'Real JASSUB worker/WASM and IMSC parsing/rendering, finite sidecar and streaming paths, backward seek and clear. No physical HDR or language-family conformance claim.' };
  } catch (error) { await subtitles.dispose(); throw error; }
}

const button = document.querySelector<HTMLButtonElement>('#run')!;
button.onclick = async () => {
  button.disabled = true; const output = document.querySelector('#result')!;
  const evidence: Record<string, unknown> = { schema: 'ubve-presentation-browser-v2', recordedAt: new Date().toISOString(),
    qualifiedPlayback: false, gpuExecuted: false, nativeDecoderExecuted: false,
    userAgent: navigator.userAgent, crossOriginIsolated, status: 'RUNNING' };
  try {
    output.textContent = 'Running real AudioWorklet protocol checks…'; evidence.audio = await audioChecks();
    output.textContent = 'Running real ASS/IMSC subtitle checks…'; evidence.subtitles = await subtitleChecks();
    // Pure PGS decoder exists in this same browser bundle; detailed binary
    // boundary/reference checks remain the reproducible Node test lane.
    evidence.pgsConstructor = new PgsDecoder('bt709-limited').paletteInterpretation;
    evidence.status = 'COMPONENT_VERIFIED';
  } catch (error) { evidence.status = 'FAILED'; evidence.error = error instanceof Error ? error.stack : String(error); }
  output.textContent = JSON.stringify(evidence, null, 2);
  try { await fetch('/__evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: output.textContent }); }
  catch { /* DOM result remains the reviewable evidence if persistence fails. */ }
  button.disabled = false;
};
