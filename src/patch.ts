// Decoding and encoding of the "PTCF" patch format stored on the pedal.
// Port of stomp_whisperer/patch.py.
//
// Layout based on mungewell/zoom-zt2's `decode_preset.py`:
// https://github.com/mungewell/zoom-zt2
//
//     offset  size  field
//     0       4     "PTCF"
//     4       4     length (uint32 LE)
//     8       4     version (uint32 LE)
//     12      4     fx_count (uint32 LE)
//     16      4     target (bitfield: which pedal models the patch is for)
//     20      6     unknown
//     26      10    name (ASCII, space/NUL padded)
//     36      4*n   effect ids (uint32 LE, one per effect slot)
//     ...           chunks: TXJ1, TXE1, EDTB, PPRM/PRM2, NAME (version > 1)
//
// Each chunk is a 4-byte tag followed by a uint32 LE length and its payload.
// The optional NAME chunk holds the full (possibly longer) patch name.
//
// The EDTB chunk holds one 24-byte record per effect slot. Read as a 192-bit
// little-endian integer, from the least significant bit up:
//
//     bits  field
//     1     enabled
//     29    effect id (same value as in the header id list)
//     12    param1 .. param5 (12 bits each)
//     8     param6 .. param8 (8 bits each)
//     12    param9 .. param12 (12 bits each)
//     30    unknown
//
// Only the first `length` bytes of a download are the patch: the pedal pads the
// rest of the slot with leftovers from whatever it held before.
//
// JavaScript numbers lose bitwise precision past 32 bits, so the 192-bit records
// (and PRM2 below) are handled as BigInt, the equivalent of Python's unbounded int.

export const MAGIC = 'PTCF';
const HEADER_SIZE = 36;
const EDTB_RECORD_SIZE = 24;
const ID_BITS = 29;
const PARAM_BITS = [12, 12, 12, 12, 12, 8, 8, 8, 12, 12, 12, 12] as const;
export const PARAM_COUNT = PARAM_BITS.length;
export const MAX_EFFECTS = 11;

/** Largest value the EDTB record can store for parameter `index` (0-based). */
export function paramLimit(index: number): number {
  const width = PARAM_BITS[index];
  if (width === undefined) {
    throw new RangeError(`There is no parameter ${index}`);
  }
  return 2 ** width - 1;
}

/** Thrown when patch data does not look like a PTCF patch. */
export class PatchFormatError extends Error {
  override name = 'PatchFormatError';
}

export interface Effect {
  id: number;
  enabled: boolean;
  params: number[];
  extra: number; // the record's 30 unknown top bits, written back as read
  origin: number | null; // position (0-based) in the patch as read; null if added since
}

export interface Patch {
  name: string;
  version: number;
  target: number;
  effectIds: number[];
  effects: Effect[];
  chunks: Map<string, Uint8Array>; // a Map keeps insertion order for any tag, even "1234"
  reserved: Uint8Array; // the header's unknown bytes, written back as read
}

// The characters Python's str.split() and str.rstrip() treat as whitespace. JavaScript's
// \s differs slightly (it skips \x1c-\x1f and includes ﻿), and the port must match.
const SPACE = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SPACES = new RegExp(`[${SPACE}]+`);
const LEADING_SPACES = new RegExp(`^[${SPACE}]+`);
const TRAILING_SPACES = new RegExp(`[${SPACE}]+$`);

const words = (text: string) => text.split(SPACES).filter((word) => word !== '');

/** Name with the pedal's two-line padding collapsed to single spaces. */
export const displayName = (patch: Patch) => words(patch.name).join(' ');

/** The patch's English description (TXE1 chunk), or '' if it has none. */
export function patchDescription(patch: Patch): string {
  const raw = patch.chunks.get('TXE1') ?? new Uint8Array();
  const end = raw.indexOf(0);
  return decodeAscii(end < 0 ? raw : raw.subarray(0, end))
    .replace(LEADING_SPACES, '')
    .replace(TRAILING_SPACES, '');
}

// The pedal shows a name on two lines of 14 characters; Zoom pads the first line
// with spaces so words aren't split across them ("OverDrive     +Delay").
export const NAME_LINE = 14;
export const NAME_LENGTH = 2 * NAME_LINE;

/**
 * Lay out a new patch name the way Zoom's own are stored.
 *
 * Words that don't fit the first line move to the second; a name with no space to
 * break at is split at the line end. Throws if it can't fit or be shown.
 */
export function formatName(text: string): string {
  const name = words(text).join(' ');
  if (!name) {
    throw new Error("The name can't be empty");
  }
  if (/[^ -~]/.test(name)) {
    throw new Error('Only plain ASCII letters, digits and symbols can be shown on the pedal');
  }
  if (name.length <= NAME_LINE) {
    return name;
  }
  const cut = name.lastIndexOf(' ', NAME_LINE - 1); // a full first line would run into the second
  const splits: [string, string][] = cut > 0 ? [[name.slice(0, cut), name.slice(cut + 1)]] : [];
  splits.push([name.slice(0, NAME_LINE), name.slice(NAME_LINE).trimStart()]);
  for (const [first, second] of splits) {
    if (second.length <= NAME_LINE) {
      return first.padEnd(NAME_LINE) + second;
    }
  }
  throw new Error(`The name doesn't fit the pedal's two lines of ${NAME_LINE} characters`);
}

// ---------- byte helpers ----------

// A DataView reads multi-byte integers (struct.unpack in Python). It must cover exactly
// the bytes of `data`, which may be a window (subarray) into a larger buffer.
const viewOf = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

// Like bytes.decode("ascii", errors="replace"). TextDecoder("ascii") would not do:
// browsers treat that label as windows-1252.
const decodeAscii = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : '�')).join('');

// Like str.encode("ascii"): refuses anything outside ASCII.
function encodeAscii(text: string): Uint8Array {
  if (/[^\x00-\x7f]/.test(text)) {
    throw new RangeError(`Not plain ASCII: ${JSON.stringify(text)}`);
  }
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function padEnd(bytes: Uint8Array, length: number, fill: number): Uint8Array {
  if (bytes.length >= length) {
    return bytes;
  }
  const padded = new Uint8Array(length).fill(fill);
  padded.set(bytes);
  return padded;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${value} doesn't fit in 32 bits`); // DataView would wrap it silently
  }
  const bytes = new Uint8Array(4);
  viewOf(bytes).setUint32(0, value, true);
  return bytes;
}

// int.from_bytes(bytes, "little")
function fromLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]!);
  }
  return value;
}

// int.to_bytes(size, "little"), which also refuses values that don't fit.
function toLittleEndian(value: bigint, size: number): Uint8Array {
  if (value < 0n || value >> BigInt(8 * size) !== 0n) {
    throw new RangeError(`Value doesn't fit in ${size} bytes`);
  }
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

// ---------- decoding ----------

function decodeName(raw: Uint8Array): string {
  const end = raw.indexOf(0);
  return decodeAscii(end < 0 ? raw : raw.subarray(0, end)).replace(TRAILING_SPACES, '');
}

function decodeEffect(record: Uint8Array, origin: number | null): Effect {
  let bits = fromLittleEndian(record);
  const take = (width: number) => {
    const value = Number(bits & ((1n << BigInt(width)) - 1n));
    bits >>= BigInt(width);
    return value;
  };
  const enabled = take(1) === 1;
  const id = take(ID_BITS);
  const params = PARAM_BITS.map((width) => take(width));
  return { id, enabled, params, extra: Number(bits), origin };
}

function decodeEffects(edtb: Uint8Array): Effect[] {
  const effects: Effect[] = [];
  for (let i = 0; i + EDTB_RECORD_SIZE <= edtb.length; i += EDTB_RECORD_SIZE) {
    effects.push(decodeEffect(edtb.subarray(i, i + EDTB_RECORD_SIZE), i / EDTB_RECORD_SIZE));
  }
  return effects;
}

function readChunks(data: Uint8Array, offset: number): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array>();
  const view = viewOf(data);
  while (offset + 8 <= data.length) {
    const tag = decodeAscii(data.subarray(offset, offset + 4));
    if (!/^[A-Za-z0-9]{4}$/.test(tag)) {
      break; // padding / trailing garbage
    }
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    chunks.set(tag, data.slice(start, start + length)); // slice copies, like bytes()
    offset = start + length;
  }
  return chunks;
}

/**
 * The bytes that belong to the patch, as its header's length says. The pedal sends a full
 * patch-size buffer, and past that length it holds leftovers of other patches that change
 * on their own. Data that doesn't look like a patch is returned whole.
 */
export function patchBytes(input: Uint8Array): Uint8Array {
  if (input.length < HEADER_SIZE || decodeAscii(input.subarray(0, 4)) !== MAGIC) {
    return input;
  }
  const length = viewOf(input).getUint32(4, true);
  return HEADER_SIZE <= length && length <= input.length ? input.subarray(0, length) : input;
}

export function parsePatch(input: Uint8Array): Patch {
  if (input.length < HEADER_SIZE || decodeAscii(input.subarray(0, 4)) !== MAGIC) {
    throw new PatchFormatError('missing PTCF header');
  }

  const view = viewOf(input);
  const version = view.getUint32(8, true);
  const fxCount = view.getUint32(12, true);
  const target = view.getUint32(16, true);
  const reserved = input.slice(20, 26);
  const rawName = input.subarray(26, HEADER_SIZE);

  const data = patchBytes(input);
  const idsEnd = HEADER_SIZE + 4 * fxCount;
  if (idsEnd > data.length) {
    throw new PatchFormatError(`fx_count=${fxCount} exceeds patch size`);
  }
  const effectIds = Array.from({ length: fxCount }, (_, i) => view.getUint32(HEADER_SIZE + 4 * i, true));

  const chunks = readChunks(data, idsEnd);
  const nameChunk = chunks.get('NAME');
  const name = decodeName(nameChunk ?? rawName);

  const effects = decodeEffects(chunks.get('EDTB') ?? new Uint8Array());

  return { name, version, target, effectIds, effects, chunks, reserved };
}

// ---------- encoding ----------
//
// PRM2 holds 32 bytes of patch-wide settings. Read as a 256-bit little-endian
// integer (layout from mungewell/zoom-zt2's decode_preset.py), some fields name
// effect slots, so they must follow the effects when these are moved or removed:
// 11-bit fields with one bit per slot, and the index of the slot being edited.
// On a MS-50G+ only the preamp field is ever set: it marks exactly the effects of
// the PREAMP group (checked against all 100 patches of a real pedal).
const PRM2_SIZE = 32;
export const PRM2_PREAMP_SLOTS = 161;
const PRM2_SLOT_FIELDS = [22, 33, 55, 66, PRM2_PREAMP_SLOTS, 172, 183];
const PRM2_SLOT_MASK = (1n << 11n) - 1n;
const PRM2_EDIT_SLOT = 85n;
const PRM2_EDIT_MASK = 0b111n;
const CHUNK_ORDER = ['TXJ1', 'TXE1', 'EDTB', 'PRM2', 'NAME'];

function encodeEffect(effect: Effect): Uint8Array {
  let bits = effect.enabled ? 1n : 0n;
  let shift = 1n;
  bits |= BigInt(effect.id) << shift;
  shift += BigInt(ID_BITS);
  PARAM_BITS.forEach((width, i) => {
    bits |= BigInt(effect.params[i]!) << shift;
    shift += BigInt(width);
  });
  bits |= BigInt(effect.extra) << shift;
  return toLittleEndian(bits, EDTB_RECORD_SIZE);
}

function remapPrm2(prm2: Uint8Array, effects: Effect[], preamp: (boolean | null)[] | null): Uint8Array {
  if (prm2.length !== PRM2_SIZE) {
    return prm2;
  }
  let bits = fromLittleEndian(prm2);
  for (const field of PRM2_SLOT_FIELDS) {
    const shift = BigInt(field);
    const old = (bits >> shift) & PRM2_SLOT_MASK;
    let fresh = 0n;
    effects.forEach((effect, index) => {
      const forced = field === PRM2_PREAMP_SLOTS ? (preamp?.[index] ?? null) : null;
      const flag = forced ?? (effect.origin !== null && ((old >> BigInt(effect.origin)) & 1n) === 1n);
      if (flag) {
        fresh |= 1n << BigInt(index);
      }
    });
    bits = (bits & ~(PRM2_SLOT_MASK << shift)) | (fresh << shift);
  }
  const edited = Number((bits >> PRM2_EDIT_SLOT) & PRM2_EDIT_MASK);
  const newEdited = Math.max(0, effects.findIndex((e) => e.origin === edited));
  bits = (bits & ~(PRM2_EDIT_MASK << PRM2_EDIT_SLOT)) | (BigInt(newEdited) << PRM2_EDIT_SLOT);
  return toLittleEndian(bits, PRM2_SIZE);
}

/**
 * Build the PTCF bytes for `patch`: the inverse of `parsePatch`.
 *
 * Chunks other than EDTB, PRM2 and NAME are written back as read. `preamp` says,
 * per effect, whether it belongs to the PREAMP group; where it's null (or it's
 * omitted) an effect keeps the flag it was read with.
 */
export function encodePatch(patch: Patch, preamp: (boolean | null)[] | null = null): Uint8Array {
  if (patch.effects.length > MAX_EFFECTS) {
    throw new RangeError(`A patch holds at most ${MAX_EFFECTS} effect slots`);
  }
  if (preamp !== null && preamp.length !== patch.effects.length) {
    throw new RangeError('One preamp flag is needed per effect');
  }
  for (const effect of patch.effects) {
    if (!Number.isInteger(effect.id) || effect.id < 0 || effect.id >= 2 ** ID_BITS) {
      throw new RangeError(`Effect id 0x${effect.id.toString(16)} doesn't fit`);
    }
    if (
      effect.params.length !== PARAM_COUNT ||
      effect.params.some((value, i) => !Number.isInteger(value) || value < 0 || value > paramLimit(i))
    ) {
      throw new RangeError(`Parameters out of range for effect 0x${effect.id.toString(16)}`);
    }
  }

  const rawName = padEnd(encodeAscii(patch.name), NAME_LENGTH, 0x20);
  const chunks = new Map(patch.chunks);
  chunks.set('EDTB', concat(patch.effects.map(encodeEffect)));
  const prm2 = chunks.get('PRM2');
  if (prm2 !== undefined) {
    chunks.set('PRM2', remapPrm2(prm2, patch.effects, preamp));
  }
  if (chunks.has('NAME') || patch.version > 1) {
    chunks.set('NAME', padEnd(rawName, (rawName.length + 4) & ~3, 0));
  }
  const ordered = CHUNK_ORDER.filter((tag) => chunks.has(tag));
  ordered.push(...[...chunks.keys()].filter((tag) => !ordered.includes(tag)));

  const body = concat([
    ...patch.effects.map((e) => uint32(e.id)),
    ...ordered.flatMap((tag) => {
      const payload = chunks.get(tag)!;
      return [encodeAscii(tag), uint32(payload.length), payload];
    }),
  ]);
  const header = concat([
    encodeAscii(MAGIC),
    uint32(HEADER_SIZE + body.length),
    uint32(patch.version),
    uint32(patch.effects.length),
    uint32(patch.target),
    padEnd(patch.reserved.subarray(0, 6), 6, 0),
    rawName.subarray(0, 10),
  ]);
  return concat([header, body]);
}
