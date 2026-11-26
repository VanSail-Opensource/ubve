import { CODEC_AGAIN, CODEC_EOF, CODEC_OK } from '../src/portable-protocol.js';
import type { PortableHeader, PortableKind, PortableOpen, PortablePacket, PortableStep, PortableTaken } from '../src/portable-protocol.js';

declare const UBVE_PORTABLE_PINS: Readonly<Record<PortableKind, { readonly bytes: number; readonly sha256: string }>>;
interface Module {
  readonly HEAPU8: Uint8Array<ArrayBuffer>;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _ubve_open(name: number, video: number, width: number, height: number, rate: number, channels: number, extra: number, size: number, num: number, den: number): number;
  _ubve_close(): void;
  _ubve_packet(size: number, token: number, pts: bigint, dts: bigint, duration: bigint, key: number): number;
  _ubve_send(): number;
  _ubve_flush(): number;
  _ubve_receive(): number;
  _ubve_release(): void;
  _ubve_shape(): number;
  _ubve_plane(index: number): number;
  _ubve_pts(): bigint;
  _ubve_duration(): bigint;
}

const ctx = self as DedicatedWorkerGlobalScope;
let instance: Module | null = null;
let options: PortableOpen | null = null;
let output: PortableHeader | null = null;
let eof = false, sealed = false, pending = false, busy = false;
const fail = (message: string): never => { throw new Error(message); };
const integer = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
const bounds = (m: Module, ptr: number, length: number) => {
  if (!integer(ptr, 1, m.HEAPU8.byteLength) || !integer(length, 0, m.HEAPU8.byteLength - ptr)) fail('Software codec plane escapes its WASM heap');
};
const success = (code: number) => { if (code !== CODEC_OK) fail(`Software codec rejected operation (${code})`); };

async function init(kind: PortableKind): Promise<unknown> {
  if (instance || (kind !== 'video' && kind !== 'audio')) fail('Invalid software codec module selection');
  const pin = UBVE_PORTABLE_PINS[kind];
  const response = await fetch(new URL(`${kind}.wasm`, ctx.location.href), { signal: AbortSignal.timeout(9000) });
  if (!response.ok || response.headers.has('content-length') && Number(response.headers.get('content-length')) !== pin.bytes) fail('Software codec asset unavailable or wrong length');
  const wasmBinary = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasmBinary)), x => x.toString(16).padStart(2, '0')).join('');
  if (wasmBinary.byteLength !== pin.bytes || hash !== pin.sha256) fail('Software codec module integrity mismatch');
  const { default: create } = await import(new URL(`${kind}.mjs`, ctx.location.href).href) as { default: (options: { wasmBinary: ArrayBuffer }) => Promise<Module> };
  instance = await create({ wasmBinary });
  return { abi: 'ubve-software-decode-v1', provider: 'FFmpeg 9.0.2', kind, sha256: hash, workerThreads: 1, sharedMemory: false };
}

function open(m: Module, o: PortableOpen): void {
  if (options || !/^[a-z0-9_-]{1,20}$/.test(o.decoder) || !(o.description instanceof Uint8Array) ||
      o.description.byteLength > 1048576 || !Array.isArray(o.tb) || !o.tb.every(n => integer(n, 1, 2147483647))) fail('Invalid software codec configuration');
  const name = new TextEncoder().encode(o.decoder + '\0');
  const ptr = m._malloc(name.byteLength + o.description.byteLength);
  try {
    bounds(m, ptr, name.byteLength + o.description.byteLength);
    m.HEAPU8.set(name, ptr);
    m.HEAPU8.set(o.description, ptr + name.byteLength);
    success(m._ubve_open(ptr, Number(o.kind === 'video'), o.width, o.height, o.sampleRate, o.channels,
      ptr + name.byteLength, o.description.byteLength, ...o.tb));
    options = o;
  } finally { if (ptr) m._free(ptr); }
}

function receive(m: Module): void {
  if (output || eof) fail('Software codec already holds an output or reached EOF');
  const code = m._ubve_receive();
  if (code === CODEC_EOF) { eof = true; return; }
  if (code === CODEC_AGAIN) return;
  success(code);
  const ptr = m._ubve_shape();
  bounds(m, ptr, 64 * 4);
  const v = new DataView(m.HEAPU8.buffer, ptr, 64 * 4);
  const shape = Array.from({ length: 41 }, (_, i) => v.getInt32(i * 4, true));
  const o = options!;
  let bytes: number;
  if (o.kind === 'video') {
    const depth = shape[2]!, w = shape[3]!, h = shape[4]!;
    if (shape[0] !== 1 || (depth !== 8 && depth !== 10) ||
        !integer(w, 1, o.width) || !integer(h, 1, o.height)) fail('Software video changed geometry or is not admitted 4:2:0 8/10-bit');
    bytes = (w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2)) * (depth === 10 ? 2 : 1);
  } else {
    if (shape[0] !== 0 || shape[4] !== o.sampleRate || shape[6] !== o.channels || !integer(shape[2], 1, 4) ||
        !integer(shape[5], 1, 65536)) fail('Software audio changed rate/layout or exceeds its frame bounds');
    // Transfer planar/interleaved data as supplied by the decoder. The worker
    // allocates a single canonical interleaved output, with 32-bit storage.
    bytes = shape[5]! * shape[6]! * 4;
  }
  output = { bytes, shape, pts: m._ubve_pts(), duration: m._ubve_duration() };
}

function submit(m: Module, packet: PortablePacket | undefined): PortableStep {
  if (!options || output || eof || sealed) fail('Software codec cannot accept input in this state');
  if (packet) {
    if (pending || !(packet.data instanceof Uint8Array) || !integer(packet.data.byteLength, 1, 32 * 1024 * 1024) ||
        !integer(packet.token, 1, 2147483647) || typeof packet.pts !== 'bigint' ||
        typeof packet.dts !== 'bigint' || typeof packet.duration !== 'bigint') fail('Invalid software codec packet');
    const ptr = m._ubve_packet(packet.data.byteLength, packet.token, packet.pts, packet.dts, packet.duration, Number(packet.key));
    bounds(m, ptr, packet.data.byteLength);
    m.HEAPU8.set(packet.data, ptr);
    pending = true;
  }
  if (!pending) fail('No pending software packet to resubmit');
  const code = m._ubve_send();
  const accepted = code !== CODEC_AGAIN;
  if (accepted) { success(code); pending = false; }
  receive(m);
  return { accepted, eof, output };
}

function take(m: Module, credit: number): PortableTaken {
  const frame = output;
  if (!frame || frame.bytes !== credit) return fail('Software output lacks matching allocation credit');
  const data = new ArrayBuffer(frame.bytes), shape = frame.shape;
  if (shape[0] === 1) {
    const packed = new Uint8Array(data), bytesPerSample = shape[2] === 10 ? 2 : 1;
    let at = 0;
    for (let plane = 0; plane < 3; plane++) {
      const w = plane === 0 ? shape[3]! : Math.ceil(shape[3]! / 2);
      const h = plane === 0 ? shape[4]! : Math.ceil(shape[4]! / 2);
      const row = w * bytesPerSample, stride = shape[13 + plane]!, ptr = m._ubve_plane(plane);
      if (stride < row) fail('Software video returned an invalid plane stride');
      bounds(m, ptr, stride * (h - 1) + row);
      for (let y = 0; y < h; y++, at += row) packed.set(m.HEAPU8.subarray(ptr + y * stride, ptr + y * stride + row), at);
    }
  } else {
    const kind = shape[2]!, planar = shape[3] === 1, frames = shape[5]!, channels = shape[6]!;
    const width = kind === 1 ? 2 : kind === 4 ? 8 : 4;
    const planes = Array.from({ length: planar ? channels : 1 }, (_, i) => {
      const ptr = m._ubve_plane(i), length = frames * width * (planar ? 1 : channels);
      if (shape[8]! < length) fail('Software audio returned an invalid plane stride');
      bounds(m, ptr, length);
      return new DataView(m.HEAPU8.buffer, ptr, length);
    });
    const integerData = kind <= 2 ? new Int32Array(data) : null;
    const floatData = integerData ? null : new Float32Array(data);
    for (let f = 0; f < frames; f++) for (let channel = 0; channel < channels; channel++) {
      const i = f * channels + channel, plane = planes[planar ? channel : 0]!, offset = (planar ? f : i) * width;
      if (integerData) integerData[i] = kind === 1 ? plane.getInt16(offset, true) * 65536 : plane.getInt32(offset, true);
      else floatData![i] = kind === 3 ? plane.getFloat32(offset, true) : plane.getFloat64(offset, true);
    }
  }
  m._ubve_release();
  output = null;
  receive(m);
  return { data, output, eof };
}

ctx.onmessage = async ({ data: message }: MessageEvent<{ id: number; command: { type: string; data: unknown } }>) => {
  const { id, command } = message;
  if (busy || !integer(id, 1, Number.MAX_SAFE_INTEGER) || !command) return;
  busy = true;
  try {
    let data: unknown;
    const transfers: Transferable[] = [];
    if (command.type === 'init') data = await init(command.data as PortableKind);
    else if (command.type === 'close') {
      instance?._ubve_close(); instance = null; options = null; output = null; data = { closed: true };
    } else {
      const m = instance ?? fail('Software module is not initialized');
      if (command.type === 'open') open(m, command.data as PortableOpen);
      else if (command.type === 'submit') data = submit(m, command.data as PortablePacket);
      else if (command.type === 'retry') data = submit(m, undefined);
      else if (command.type === 'flush') {
        if (!options || pending || output || sealed) fail('Software codec cannot flush in this state');
        const code = m._ubve_flush();
        if (code === CODEC_EOF) eof = sealed = true;
        else if (code !== CODEC_AGAIN) { success(code); sealed = true; }
        if (!eof) receive(m);
        data = { accepted: sealed, eof, output } satisfies PortableStep;
      } else if (command.type === 'take') {
        const frame = take(m, command.data as number);
        transfers.push(frame.data); data = frame;
      } else fail('Unknown software codec command');
    }
    ctx.postMessage({ id, success: true, data }, transfers);
  } catch (error) {
    ctx.postMessage({ id, success: false, error: { message: error instanceof Error ? error.message : String(error) } });
  } finally { busy = false; }
};
