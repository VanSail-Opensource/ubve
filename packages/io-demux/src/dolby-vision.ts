import { EngineError } from '@ubve/core';

export interface DolbyVisionConfig {
  readonly sampleEntry: string;
  readonly profile: number | null;
  readonly level: number | null;
  readonly compatibilityId: number | null;
  readonly rpuPresent: boolean | null;
  readonly enhancementLayerPresent: boolean | null;
  readonly baseLayerPresent: boolean | null;
}

export function readDolbyVisionConfig(sampleEntry: string, bytes: Uint8Array): DolbyVisionConfig {
  if (bytes.length < 4 || bytes[0] !== 1 || bytes[1] !== 0)
    return { sampleEntry, profile: null, level: null, compatibilityId: null, rpuPresent: null, enhancementLayerPresent: null, baseLayerPresent: null };
  const flags = bytes[3]!;
  return { sampleEntry, profile: bytes[2]! >>> 1, level: ((bytes[2]! & 1) << 5) | (flags >>> 3),
    compatibilityId: bytes.length >= 5 ? bytes[4]! >>> 4 : null, rpuPresent: Boolean(flags & 4),
    enhancementLayerPresent: Boolean(flags & 2), baseLayerPresent: Boolean(flags & 1) };
}

export type HevcPacketMode = 'ordinary' | 'profile-81' | 'profile-7';
export type Hdr10BaseMode = Exclude<HevcPacketMode, 'ordinary'>;
export function hdr10BaseMode(config: DolbyVisionConfig): Hdr10BaseMode | null {
  if (!config.baseLayerPresent || !config.rpuPresent) return null;
  if (config.profile === 8 && config.compatibilityId === 1 && config.enhancementLayerPresent === false) return 'profile-81';
  if (config.profile === 7 && config.compatibilityId === 6 && config.enhancementLayerPresent === true) return 'profile-7';
  return null;
}

const invalid = (message: string): never => { throw new EngineError('INVALID_PACKET', message); };
const unsupported = (message: string): never => { throw new EngineError('UNSUPPORTED_PROFILE', message, 'caller-fix'); };
const MAX_NALS = 65536;

function header(bytes: Uint8Array, start: number, end: number): { type: number; layer: number } {
  if (end - start < 2) return invalid('Truncated HEVC NAL unit header');
  const a = bytes[start]!, b = bytes[start + 1]!;
  if ((a & 128) !== 0 || (b & 7) === 0) return invalid('Invalid HEVC NAL unit header');
  return { type: (a >>> 1) & 63, layer: (a & 1) * 32 + (b >>> 3) };
}

/** Validate the original hvcC. The HDR base configuration cannot contain
 * an EL/RPU array or describe a non-Main-10, non-4:2:0 base. */
export function hevcLengthBytes(config: Uint8Array, base: boolean): 1 | 2 | 4 {
  if (config.length < 23 || config[0] !== 1) return invalid('Missing or malformed HEVC decoder configuration (hvcC)');
  const width = (config[21]! & 3) + 1;
  if (width === 3) return invalid('Unsupported HEVC NAL length field width');
  if (base && ((config[1]! & 31) !== 2 || (config[16]! & 3) !== 1 || (config[17]! & 7) !== 2 || (config[18]! & 7) !== 2))
    return unsupported('The Dolby Vision base must declare Main 10 with 10-bit 4:2:0 HEVC.');
  const data = new DataView(config.buffer, config.byteOffset, config.byteLength);
  let at = 23, sps = false, pps = false, units = 0;
  for (let array = 0; array < config[22]!; array++) {
    if (config.length - at < 3) return invalid('Truncated HEVC parameter array');
    const type = config[at]! & 63, count = data.getUint16(at + 1); at += 3;
    for (let i = 0; i < count; i++) {
      if (++units > MAX_NALS || config.length - at < 2) return invalid('Invalid HEVC parameter count');
      const length = data.getUint16(at); at += 2;
      if (length > config.length - at) return invalid('HEVC parameter escapes hvcC');
      const info = header(config, at, at + length);
      if (type !== info.type) return invalid('HEVC parameter type disagrees with its array');
      if (info.layer !== 0 || type === 62 || type === 63) return unsupported('The HEVC decoder configuration includes unsupported non-base data.');
      sps ||= type === 33; pps ||= type === 34;
      at += length;
    }
  }
  if (at !== config.length) return invalid('Trailing bytes in HEVC decoder configuration');
  if (base && (!sps || !pps)) return unsupported('The Dolby Vision HDR10 base lacks stable HEVC parameter sets.');
  return width as 1 | 2 | 4;
}

function ignore(mode: HevcPacketMode, type: number, layer: number): boolean {
  if (layer !== 0 || type === 63) {
    if (mode === 'profile-7') return true;
    return unsupported('The selected HEVC track has an unadmitted enhancement layer.');
  }
  if (type === 62) {
    if (mode !== 'ordinary') return true;
    return unsupported('Dolby Vision data was found in HEVC without a verified HDR10-compatible configuration.');
  }
  return false;
}

/** Annex B is permitted only for the plain HEVC boundary. The HDR10 fallback
 * always follows the length prefixes in the validated hvcC. */
function guardAnnexB(bytes: Uint8Array): void {
  let unit = -1, zeros = 0, seen = 0;
  const check = (end: number) => {
    if (++seen > MAX_NALS) return invalid('HEVC access unit exceeds its NAL count bound');
    const { type, layer } = header(bytes, unit, end);
    ignore('ordinary', type, layer);
  };
  for (let i = 0; i < bytes.length; i++) {
    const n = bytes[i];
    if (n === 0) { zeros++; continue; }
    if (n === 1 && zeros >= 2) {
      if (unit >= 0) check(i - zeros);
      unit = i + 1;
    } else if (unit < 0) return invalid('HEVC packet does not declare Annex B start codes');
    zeros = 0;
  }
  if (unit < 0) return invalid('HEVC packet has no Annex B NAL unit');
  check(bytes.length);
}

export interface HevcCopyPlan { readonly bytes: number; write(target: Uint8Array): void; }

/** No buffer allocation in the NAL scan. The demux owner's byte ledger
 * reserves the result before the copy. Retain original length prefixes and all
 * base-layer parameter sets and static SEI. */
export function hevcPacketFilter(mode: HevcPacketMode, config: Uint8Array): (bytes: Uint8Array) => HevcCopyPlan | null {
  const width = config.length ? hevcLengthBytes(config, mode !== 'ordinary') : null;
  if (!width && mode !== 'ordinary') return unsupported('The HDR10 fallback needs an HEVC decoder configuration.');
  return bytes => {
    if (!width) { guardAnnexB(bytes); return null; }
    const lengthBytes = width;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    function scan(visit: (start: number, end: number) => void) {
      let count = 0, offset = 0;
      while (offset < bytes.length) {
        if (++count > MAX_NALS || bytes.length - offset < lengthBytes) return invalid('Malformed or too many HEVC NAL length fields');
        const start = offset + lengthBytes;
        const length = lengthBytes === 4 ? data.getUint32(offset) : lengthBytes === 2 ? data.getUint16(offset) : data.getUint8(offset);
        if (length > bytes.length - start) return invalid('HEVC NAL unit escapes its access unit');
        const end = start + length, { type, layer } = header(bytes, start, end);
        if (!ignore(mode, type, layer)) visit(offset, end);
        offset = end;
      }
    }
    let kept = 0;
    scan((start, end) => { kept += end - start; });
    if (kept === 0) return invalid('HEVC access unit contains no base-layer data');
    if (kept === bytes.length) return null;
    return { bytes: kept, write(target) {
      let at = 0;
      scan((start, end) => { target.set(bytes.subarray(start, end), at); at += end - start; });
    } };
  };
}
