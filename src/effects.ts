// Effect metadata read from the pedal's own effect files.
// Port of stomp_whisperer/effects.py (the DATA program's ranges and labels, from
// effect_params.py, are not ported yet: max/default/labels stay null).
//
// The pedal stores each built-in effect as a `*.ZD2` file, indexed by `FLST_SEQ.ZT2`.
// Layouts based on mungewell/zoom-zt2's `zoomzt2.py`:
// https://github.com/mungewell/zoom-zt2
//
// FLST_SEQ.ZT2 is a list of groups. Each group starts with ">>>\0" + group byte + 21 bytes
// of padding, holds 26-byte effect entries, and ends with "<<<\0" + group byte + 21 bytes
// of padding. An effect entry is:
//
//     size  field
//     12    file name (ASCII, NUL padded)
//     1     NUL
//     4     version (ASCII, e.g. "1.10")
//     1     NUL
//     1     installed flag
//     4     effect id (uint32 LE, same value patches use)
//     3     zeros
//
// A ZD2 file starts with "ZDLF" and a fixed header holding the effect id (uint32 LE at
// offset 96), its display name (11 bytes at 100) and its group name (11 bytes at 111).
// Tagged chunks follow (4-byte tag, uint32 LE length, payload), starting at "ICON". Of
// those, TXE1 is the English description, PRME is JSON listing the parameters (name +
// English explanation) in the order patches store their values, and DATA is the effect's
// DSP program, where each parameter's range, default and display labels live.
//
// Only this metadata is kept; the effect binaries themselves are never stored.

import { decodeAscii, readChunks, strip, viewOf } from './patch';

export const INDEX_FILE = 'FLST_SEQ.ZT2';

const GROUP_START = Uint8Array.of(0x3e, 0x3e, 0x3e, 0x00); // ">>>\0"
const GROUP_END = Uint8Array.of(0x3c, 0x3c, 0x3c, 0x00); // "<<<\0"
const GROUP_HEADER_SIZE = 26;
const ENTRY_SIZE = 26;
const ENTRY_ID_OFFSET = 19;

const ZD2_MAGIC = 'ZDLF';
const ZD2_ID_OFFSET = 96;
const ZD2_NAME_OFFSET = 100;
const ZD2_GROUP_OFFSET = 111;
const ZD2_NAME_SIZE = 11;

// Some of Zoom's PRME lists end with a trailing comma ("},\r\n  ]"), which isn't valid JSON.
const TRAILING_COMMA = /,(\s*[\]}])/g;

/** Thrown when an effect file or the effect index cannot be decoded. */
export class EffectFormatError extends Error {
  override name = 'EffectFormatError';
}

export interface Param {
  name: string;
  explanation: string;
  max: number | null; // the minimum is always 0
  default: number | null;
  labels: string[] | null; // what the pedal shows for each value, if known
}

export interface EffectInfo {
  id: number;
  file: string;
  name: string;
  group: string;
  description: string;
  params: Param[];
}

/** What the pedal shows for `value` of `param`. */
export function displayParam(param: Param, value: number): string {
  const label = param.labels?.[value];
  return label ?? String(value);
}

// Like bytes.split(b"\0", 1)[0].decode("ascii", errors="replace").strip().
function cstring(raw: Uint8Array): string {
  const end = raw.indexOf(0);
  return strip(decodeAscii(end < 0 ? raw : raw.subarray(0, end)));
}

// Like bytes.find(needle, start): the offset of `needle` in `data`, or -1.
function find(data: Uint8Array, needle: Uint8Array, start: number): number {
  for (let offset = start; offset + needle.length <= data.length; offset++) {
    if (startsWith(data, needle, offset)) {
      return offset;
    }
  }
  return -1;
}

function startsWith(data: Uint8Array, prefix: Uint8Array, offset: number): boolean {
  return offset + prefix.length <= data.length && prefix.every((b, i) => data[offset + i] === b);
}

/** Map effect id -> ZD2 file name, from FLST_SEQ.ZT2. */
export function parseEffectIndex(data: Uint8Array): Map<number, string> {
  const files = new Map<number, string>();
  const view = viewOf(data);
  let offset = find(data, GROUP_START, 1); // skip the file header, which uses the same marker
  while (offset !== -1 && startsWith(data, GROUP_START, offset)) {
    offset += GROUP_HEADER_SIZE;
    while (offset + ENTRY_SIZE <= data.length && !startsWith(data, GROUP_END, offset)) {
      files.set(view.getUint32(offset + ENTRY_ID_OFFSET, true), cstring(data.subarray(offset, offset + 12)));
      offset += ENTRY_SIZE;
    }
    offset = find(data, GROUP_START, offset);
  }
  if (files.size === 0) {
    throw new EffectFormatError(`No effects found in ${INDEX_FILE}`);
  }
  return files;
}

function parseParams(prme: Uint8Array): Param[] {
  let spec: unknown;
  try {
    spec = JSON.parse(cstring(prme).replace(TRAILING_COMMA, '$1') || '{}');
  } catch {
    return []; // keep the name and description even if the parameter list is unreadable
  }
  const list = (spec as { Parameters?: unknown } | null)?.Parameters;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((p: { name?: unknown; explanation?: unknown }) => ({
    name: typeof p?.name === 'string' ? p.name : '',
    explanation: typeof p?.explanation === 'string' ? p.explanation : '',
    max: null,
    default: null,
    labels: null,
  }));
}

/** Decode the name, group, description and parameter names of a ZD2 file. */
export function parseEffectFile(data: Uint8Array, file = ''): EffectInfo {
  if (decodeAscii(data.subarray(0, 4)) !== ZD2_MAGIC || data.length < ZD2_GROUP_OFFSET + ZD2_NAME_SIZE) {
    throw new EffectFormatError(`${file || 'Effect file'} is not a ZD2 file`);
  }
  const icon = find(data, Uint8Array.of(0x49, 0x43, 0x4f, 0x4e), ZD2_GROUP_OFFSET); // "ICON"
  const chunks = icon === -1 ? new Map<string, Uint8Array>() : readChunks(data, icon);
  const prme = chunks.get('PRME');
  return {
    id: viewOf(data).getUint32(ZD2_ID_OFFSET, true),
    file,
    name: cstring(data.subarray(ZD2_NAME_OFFSET, ZD2_NAME_OFFSET + ZD2_NAME_SIZE)),
    group: cstring(data.subarray(ZD2_GROUP_OFFSET, ZD2_GROUP_OFFSET + ZD2_NAME_SIZE)),
    description: cstring(chunks.get('TXE1') ?? new Uint8Array()),
    params: prme ? parseParams(prme) : [],
  };
}
