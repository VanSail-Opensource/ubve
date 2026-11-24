// Production packet-fed adapter over the pinned libmedia 1.3.1 C ABI.
// The atomic candidate is deliberate: the default SIMD/four-thread candidate is blocked.
import { compileResource, AVCodecParameters, AVFrame, AVPacket, AVFrameSideData, AVMasteringDisplayMetadata, AVContentLightMetadata, AVRational, getAVFrameSideData, createAVFrame, destroyAVFrame, createAVPacket, destroyAVPacket, addAVPacketData, unrefAVPacket, avMallocz, freeCodecParameters } from '@libmedia/avutil';
import { WebAssemblyRunner, Memory, mapStruct, sizeof, offsetof, memcpyFromUint8Array, config } from '@libmedia/cheap';
import { initMain } from '../../../node_modules/@libmedia/cheap/dist/esm/heap.js';
import { support } from '@libmedia/common';

const PIN = '9a3048be7f159a6e8976349045a296c7c14a5a3d91f4e2cf52e42c2214025a63';
let runner, parameters = 0, packet = 0, frame = 0, packetView, frameView, openAttempted = false;
let pendingInput = false, outputReady = false, closed = false, configured, frames = 0, packets = 0;
const fail = message => { throw Error(message); };
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');

async function initialize(value) {
  if (runner || closed) fail('Decoder worker can initialize only once');
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') fail('Atomic dav1d requires an isolated document with shared memory');
  if (![1, 2, 4].includes(value.threads) || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || value.width > 4096 || value.height > 2160) fail('AV1 geometry/thread profile is not admitted');
  configured = value;
  if (!Memory) initMain();
  if (!Memory || !config.USE_THREADS) fail('Pinned shared heap could not initialize');
  const response = await fetch(value.wasmUrl); if (!response.ok) fail('AV1 module fetch failed');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== 844881 || await digest(bytes) !== PIN) fail('AV1 module integrity mismatch');
  const resource = await compileResource(bytes, true);
  parameters = avMallocz(sizeof(AVCodecParameters));
  const view = mapStruct(parameters, AVCodecParameters);
  view.codecType = 0; view.codecId = 225; view.format = -1; view.width = value.width; view.height = value.height;
  view.profile = 0; view.bitsPerRawSample = 0; view.sampleAspectRatio.num = 1; view.sampleAspectRatio.den = 1;
  if (value.description?.byteLength) {
    if (value.description.byteLength > 1048576) fail('AV1 configuration exceeds 1 MiB');
    view.extradata = avMallocz(value.description.byteLength + 64); memcpyFromUint8Array(view.extradata, value.description.byteLength, value.description); view.extradataSize = value.description.byteLength;
  }
  packet = createAVPacket(); frame = createAVFrame(); packetView = mapStruct(packet, AVPacket); frameView = mapStruct(frame, AVFrame);
  runner = new WebAssemblyRunner(resource); await runner.run(undefined, value.threads); openAttempted = true;
  const result = support.jspi ? await runner.invokeAsync('decoder_open', parameters, 0, value.threads, 0) : runner.invoke('decoder_open', parameters, 0, value.threads, 0);
  if (!support.jspi) await runner.childThreadsReady();
  if (result !== 0) fail(`dav1d open failed (${result})`);
  return { candidate: 'libmedia-1.3.1-dav1d-atomic', wasmSha256: PIN, requestedThreads: value.threads, childThreads: runner.getChildThreadCount(), heapBytes: Memory.buffer.byteLength, shared: Memory.buffer instanceof SharedArrayBuffer };
}
function send(value) {
  if (closed || !runner) fail('Decoder is unavailable');
  if (outputReady) fail('Pending AV1 output must be taken before resubmission');
  if (!pendingInput) {
    if (!(value.data instanceof Uint8Array) || value.data.length < 1 || value.data.length > 33554432 || !Number.isSafeInteger(value.token) || value.token < 1) fail('Invalid bounded AV1 packet');
    unrefAVPacket(packet); const data = avMallocz(value.data.length + 64);
    memcpyFromUint8Array(data, value.data.length, value.data); addAVPacketData(packet, data, value.data.length);
    packetView.pts = BigInt(value.token); packetView.dts = -(1n << 63n); packetView.duration = 0n;
    packetView.pos = -1n; packetView.streamIndex = 0; packetView.flags = value.key ? 1 : 0; packetView.timeBase.num = 1; packetView.timeBase.den = 1;
    pendingInput = true;
  }
  const result = runner.invoke('decoder_decode', packet);
  if (result === -11) return { accepted: false, outputReady: probe() }; // Keep the same C AVPacket for resubmission.
  if (result !== 0) fail(`dav1d send failed (${result})`);
  pendingInput = false; unrefAVPacket(packet); packets++; return { accepted: true, outputReady: probe() };
}
function structure(pointer, bytes, Struct) {
  if (!Number.isSafeInteger(pointer) || pointer <= 0 || !Number.isSafeInteger(bytes) || bytes < sizeof(Struct) || pointer + bytes > Memory.buffer.byteLength) fail('Invalid HDR side-data bounds');
  return mapStruct(pointer, Struct);
}
function hdrMetadata() {
  const read = type => { const pointer = getAVFrameSideData(frame, type); if (!pointer) return null; const side = structure(pointer, sizeof(AVFrameSideData), AVFrameSideData); return { pointer: side.data, bytes: side.size }; };
  const master = read(11), light = read(14); let mastering = null, contentLight = null;
  if (master) {
    const value = structure(master.pointer, master.bytes, AVMasteringDisplayMetadata);
    const rational = (name, index = 0) => {
      const pointer = master.pointer + offsetof(AVMasteringDisplayMetadata.prototype, name) + index * sizeof(AVRational);
      if (pointer < master.pointer || pointer + sizeof(AVRational) > master.pointer + master.bytes) fail('Invalid HDR rational field');
      const v = mapStruct(pointer, AVRational); return { numerator: BigInt(v.num), denominator: BigInt(v.den) };
    };
    if (value.hasPrimaries && value.hasLuminance) mastering = { red: { x: rational('displayPrimaries', 0), y: rational('displayPrimaries', 1) }, green: { x: rational('displayPrimaries', 2), y: rational('displayPrimaries', 3) }, blue: { x: rational('displayPrimaries', 4), y: rational('displayPrimaries', 5) }, white: { x: rational('whitePoint'), y: rational('whitePoint', 1) }, minimumLuminance: rational('minLuminance'), maximumLuminance: rational('maxLuminance') };
  }
  if (light) { const v = structure(light.pointer, light.bytes, AVContentLightMetadata); contentLight = { maximumContentLightLevel: v.maxCLL || null, maximumFrameAverageLightLevel: v.maxFALL || null }; }
  return { mastering, contentLight };
}
// Hold one actual decoder-owned AVFrame, without allocating an owned JS copy
// or asking the host to wait for a credit for a potentially empty receive.
function probe() {
  if (closed || !runner) fail('Decoder is unavailable');
  if (outputReady) return true;
  const result = runner.invoke('decoder_receive', frame);
  if (result === 0) return false;
  if (result !== 1) fail(`dav1d receive failed (${result})`);
  outputReady = true; return true;
}
function take() {
  if (!outputReady) fail('No decoded AV1 output to take');
  const width = frameView.width, height = frameView.height, format = frameView.format;
  if (![0, 62].includes(format) || width > configured.width || height > configured.height || width < 1 || height < 1 || frameView.decodeErrorFlags) fail('Unexpected AV1 output geometry, format or corruption');
  const word = format === 62 ? 2 : 1;
  const layouts = [[width * word, height], [Math.ceil(width / 2) * word, Math.ceil(height / 2)], [Math.ceil(width / 2) * word, Math.ceil(height / 2)]];
  const data = new Uint8Array(layouts.reduce((sum, [rowBytes, rows]) => sum + rowBytes * rows, 0)); const planes = []; let destination = 0;
  for (let i = 0; i < layouts.length; i++) {
    const [rowBytes, rows] = layouts[i], offset = frameView.data[i], stride = frameView.linesize[i];
    if (!Number.isSafeInteger(offset) || offset <= 0 || !Number.isSafeInteger(stride) || stride < rowBytes || offset + (rows - 1) * stride + rowBytes > Memory.buffer.byteLength) fail('AV1 plane exceeds heap bounds');
    planes.push({ offsetBytes: destination, strideBytes: rowBytes, rows });
    const heap = new Uint8Array(Memory.buffer);
    for (let row = 0; row < rows; row++) { data.set(heap.subarray(offset + row * stride, offset + row * stride + rowBytes), destination); destination += rowBytes; }
  }
  const primaries = ({ 1: 'bt709', 9: 'bt2020', 12: 'smpte432' })[frameView.colorPrimaries] ?? null;
  const transfer = ({ 1: 'bt709', 16: 'smpte2084', 18: 'arib-std-b67' })[frameView.colorTrc] ?? null;
  const matrix = ({ 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' })[frameView.colorSpace] ?? null;
  const range = frameView.colorRange === 1 ? 'limited' : frameView.colorRange === 2 ? 'full' : null;
  const known = value => value === null ? { state: 'unknown', reason: 'Decoder did not expose this field' } : { state: 'known', value, origin: 'decoder' };
  const hdr = hdrMetadata();
  const value = { kind: 'video', format: format === 62 ? 'I420P10' : 'I420P8', codedWidth: width, codedHeight: height,
    visibleRect: { x: frameView.cropLeft, y: frameView.cropTop, width: width - frameView.cropLeft - frameView.cropRight, height: height - frameView.cropTop - frameView.cropBottom }, planes, data,
    color: { primaries, transfer, matrix, range }, signalMetadata: { epoch: 0, bitDepth: known(word === 2 ? 10 : 8), chromaSubsampling: known('420'), primaries: known(primaries), transfer: known(transfer), matrix: known(matrix), range: known(range), chromaLocation: known(({ 1: 'left', 2: 'center', 3: 'top-left', 4: 'top', 5: 'bottom-left', 6: 'bottom' })[frameView.chromaLocation] ?? null), masteringDisplay: known(hdr.mastering), contentLightLevel: known(hdr.contentLight) } };
  const token = frameView.pts.toString();
  outputReady = false; frames++;
  return { frame: value, token, outputReady: probe(), heapBytes: Memory.buffer.byteLength, frames, packets };
}
function close() {
  if (closed) return { closed: true, failures: [], termination: 'host-termination-required' };
  closed = true; const failures = [];
  for (const [stage, release] of [
    ['decoder-close', () => { if (openAttempted) runner.invoke('decoder_close'); }],
    ['frame', () => { if (frame) destroyAVFrame(frame); }], ['packet', () => { if (packet) destroyAVPacket(packet); }],
    ['parameters', () => { if (parameters) freeCodecParameters(parameters); }], ['runner', () => runner?.destroy()],
  ]) { try { release(); } catch (error) { failures.push({ stage, message: String(error) }); } }
  return { closed: true, failures, frames, packets, childThreadExitAcknowledged: false, termination: 'runtime-close-returned; host-termination-required' };
}
let chain = Promise.resolve();
self.onmessage = ({ data: message }) => {
  chain = chain.then(async () => {
    const { id, command } = message;
    try {
      let result;
      if (command.type === 'init') result = await initialize(command.data);
      else if (command.type === 'submit') result = send(command.data);
      else if (command.type === 'take') result = take();
      else if (command.type === 'flush') { if (pendingInput || outputReady) fail('Cannot flush with pending AV1 input or output'); const code = runner.invoke('decoder_flush'); if (code !== 0) fail(`dav1d flush failed (${code})`); result = { flushAccepted: true, codecEofObservable: false, outputReady: probe() }; }
      else if (command.type === 'close') result = close();
      else fail('Unknown decoder command');
      self.postMessage({ id, success: true, data: result }, result.frame ? [result.frame.data.buffer] : []);
    } catch (error) { self.postMessage({ id, success: false, error: { message: error.message || String(error) } }); }
  });
};
