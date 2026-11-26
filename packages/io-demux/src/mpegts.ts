import { EngineError, type OperationContext } from '@ubve/core';
import type { SourceCache } from './source.js';

const PREFIX_BYTES = 192 * 1024;
interface Layout { readonly bytes: number; readonly prefix: number; }
export interface TransportTrack { readonly pid: number; readonly kind: 'video' | 'audio'; readonly codec: string; }
export interface TransportProfile { readonly layout: Layout; readonly program: number; readonly pmt: number; readonly tracks: readonly TransportTrack[]; }
const layouts: readonly Layout[] = [{ bytes: 188, prefix: 0 }, { bytes: 192, prefix: 4 }, { bytes: 204, prefix: 0 }];
const invalid = (message: string): never => { throw new EngineError('INVALID_MEDIA', message); };
const unsupported = (message: string): never => { throw new EngineError('UNSUPPORTED_PROFILE', message, 'caller-fix'); };
const word = (data: Uint8Array, at: number) => data[at]! * 256 + data[at + 1]!;

function packet(bytes: Uint8Array, at: number): { pid: number; payload: number | null; start: boolean; continuity: number } {
  if (bytes[at] !== 0x47 || bytes[at + 1]! >= 128) return invalid('MPEG-TS packet sync or transport-error flag is invalid');
  const flags = bytes[at + 3]!;
  if (flags >= 64) throw new EngineError('ENCRYPTED_MEDIA', 'Scrambled MPEG-TS is outside the clear-file profile');
  const adaptation = Math.floor(flags / 16) % 4;
  if (!adaptation) return invalid('Reserved MPEG-TS adaptation mode');
  const size = adaptation >= 2 ? bytes[at + 4] : 0;
  if (size !== undefined && ((adaptation === 2 && size !== 183) || (adaptation === 3 && size > 182))) return invalid('MPEG-TS adaptation field escapes its packet');
  return { pid: word(bytes, at + 1) % 8192, payload: adaptation === 2 || size === undefined ? null : at + 4 + (adaptation === 3 ? size + 1 : 0),
    start: (bytes[at + 1]! & 64) !== 0, continuity: flags % 16 };
}

function crcValid(table: Uint8Array): boolean {
  let crc = 0xffffffff;
  for (const value of table) {
    crc ^= value << 24;
    for (let i = 0; i < 8; i++) crc = (crc << 1) ^ ((crc & 0x80000000) !== 0 ? 0x04c11db7 : 0);
  }
  return crc === 0;
}

function tableLength(data: Uint8Array, at = 0): number {
  if ((data[at + 1]! & 0xf0) !== 0xb0) return invalid('Invalid MPEG-TS table section flags');
  const length = word(data, at + 1) % 4096;
  if (length < 9 || length > 1021) return invalid('Invalid MPEG-TS table section length');
  return 3 + length;
}

function section(bytes: Uint8Array, layout: Layout, pid: number, kind: number): Uint8Array {
  // MPEG-TS limits each PSI section to 1024 bytes. Never accumulate a table by
  // concatenating arbitrary packet payloads or trusting an unframed pointer.
  const scratch = new Uint8Array(1024);
  let used = 0, total = 0, continuity = -1;
  for (let at = layout.prefix; at + 188 <= bytes.length; at += layout.bytes) {
    const p = packet(bytes, at);
    if (p.pid !== pid || p.payload === null) continue;
    let start = p.payload;
    if (p.start) {
      if (used) return unsupported('Overlapping MPEG-TS table sections are not admitted');
      start += 1 + bytes[start]!;
      if (start >= at + 188 || bytes[start] !== kind) continue;
    } else if (!used) continue;
    if (used && p.continuity !== (continuity + 1) % 16) return invalid('MPEG-TS table packet continuity changed');
    continuity = p.continuity;
    for (let i = start; i < at + 188; i++) {
      scratch[used++] = bytes[i]!;
      if (used === 3) total = tableLength(scratch);
      if (total && used === total) {
        const row = scratch.subarray(0, total);
        if (!crcValid(row)) return invalid('MPEG-TS table CRC does not match');
        if ((row[5]! & 1) === 0) { used = 0; total = 0; break; }
        if (row[6] !== 0 || row[7] !== 0) return unsupported('Multi-section MPEG-TS program tables are not admitted');
        return row;
      }
    }
  }
  return unsupported('MPEG-TS program tables are missing from the bounded header window');
}

function selectedProgram(table: Uint8Array): { program: number; pmt: number } {
  const end = table.length - 4;
  if ((end - 8) % 4) return invalid('Truncated MPEG-TS PAT program row');
  let program = 0, pmt = -1;
  for (let at = 8; at < end; at += 4) {
    const id = word(table, at);
    if (id === 0) continue; // A network table entry is not a playback program.
    if (program) return unsupported('Select and repack one program from a multi-program transport stream');
    program = id; pmt = word(table, at + 2) % 8192;
  }
  if (!program || pmt < 0x10 || pmt >= 0x1fff) return invalid('MPEG-TS PAT does not identify a usable program');
  return { program, pmt };
}

function descriptorTags(table: Uint8Array, start: number, end: number): Set<number> {
  const tags = new Set<number>();
  for (let at = start; at < end;) {
    if (end - at < 2 || table[at + 1]! > end - at - 2) return invalid('MPEG-TS descriptor escapes its row');
    tags.add(table[at]!); at += 2 + table[at + 1]!;
  }
  if (tags.has(9)) throw new EngineError('ENCRYPTED_MEDIA', 'Transport stream declares conditional access');
  return tags;
}

function codecs(table: Uint8Array, program: number): TransportTrack[] {
  if (word(table, 3) !== program || table.length < 16) return invalid('MPEG-TS PMT does not match the selected program');
  const end = table.length - 4;
  const out: TransportTrack[] = [];
  let at = 12 + word(table, 10) % 4096;
  if (at > end) return invalid('MPEG-TS PMT program descriptors escape their section');
  descriptorTags(table, 12, at);
  const pids = new Set<number>();
  for (; at < end;) {
    if (end - at < 5) return invalid('Truncated MPEG-TS PMT stream row');
    const type = table[at]!, pid = word(table, at + 1) % 8192, length = word(table, at + 3) % 4096;
    at += 5;
    if (length > end - at || pid < 0x20 || pid >= 0x1fff || pids.has(pid)) return invalid('Invalid MPEG-TS stream descriptor extent or PID');
    pids.add(pid);
    const descriptors = descriptorTags(table, at, at + length);
    at += length;
    const kind = type === 0x1b || type === 0x24 ? 'video' : 'audio';
    const codec = type === 0x1b ? 'avc' : type === 0x24 ? 'hevc' : type === 0x0f ? 'aac' :
      type === 0x81 || (type === 6 && descriptors.has(0x6a)) ? 'ac3' : type === 0x87 || (type === 6 && descriptors.has(0x7a)) ? 'eac3' : null;
    if (!codec) return unsupported(`MPEG-TS stream type 0x${type.toString(16)} is not admitted and cannot be silently omitted`);
    if (out.length >= 32) throw new EngineError('ITEM_TOO_LARGE', 'MPEG-TS stream count exceeds 32');
    out.push({ pid, kind, codec });
  }
  if (!out.length) return unsupported('MPEG-TS program has no admitted audio or video');
  return out;
}

export function validateTransportRead(bytes: Uint8Array, absoluteStart: number, profile: TransportProfile): void {
  const { layout } = profile;
  const first = Math.max(0, Math.ceil((absoluteStart - layout.prefix) / layout.bytes));
  for (let at = first * layout.bytes + layout.prefix - absoluteStart; at + 4 <= bytes.length; at += layout.bytes) {
    const p = packet(bytes, at);
    if (!p.start || p.payload === null || (p.pid !== 0 && p.pid !== profile.pmt) || at + 188 > bytes.length) continue;
    const start = p.payload + 1 + bytes[p.payload]!;
    if (start + 3 > at + 188 || bytes[start] !== (p.pid === 0 ? 0 : 2)) continue;
    const end = start + tableLength(bytes, start);
    if (end > at + 188) continue; // This read does not own a complete PSI section.
    const row = bytes.subarray(start, end);
    if (!crcValid(row)) return invalid('MPEG-TS table CRC does not match');
    if ((row[5]! & 1) === 0) continue;
    if (row[6] !== 0 || row[7] !== 0) return unsupported('Multi-section MPEG-TS program tables are not admitted');
    if (p.pid === 0) {
      const selected = selectedProgram(row);
      if (selected.program !== profile.program || selected.pmt !== profile.pmt) return unsupported('MPEG-TS program changed');
    } else {
      const tracks = codecs(row, profile.program);
      if (tracks.length !== profile.tracks.length || tracks.some((track, i) => track.pid !== profile.tracks[i]!.pid || track.codec !== profile.tracks[i]!.codec)) {
        return unsupported('MPEG-TS stream mapping changed');
      }
    }
  }
}

export function openTransportProfile(cache: SourceCache, operation: OperationContext): Promise<TransportProfile> {
  return cache.readValue(0, Math.min(cache.source.size, PREFIX_BYTES), operation, bytes => {
    const layout = layouts.find(x => [0, 1, 2].every(i => bytes[x.prefix + i * x.bytes] === 0x47));
    if (!layout || cache.source.size % layout.bytes) return invalid('MPEG-TS source is not a whole supported packet layout');
    const { program, pmt } = selectedProgram(section(bytes, layout, 0, 0));
    const profile = { layout, program, pmt, tracks: codecs(section(bytes, layout, pmt, 2), program) };
    validateTransportRead(bytes, 0, profile);
    return profile;
  });
}
