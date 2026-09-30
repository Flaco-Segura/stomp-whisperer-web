// Low-level SysEx protocol helpers for the Zoom "MS Plus" pedal series
// (MS-50G+, MS-60B+, MS-70CDR+, MS-80IR+). Port of stomp_whisperer/protocol.py.
//
// Reverse-engineered by the mungewell/zoom-zt2 project:
// https://github.com/mungewell/zoom-zt2
//
// All functions here work with SysEx *bodies* (no leading 0xF0 / trailing 0xF7).

export const PORT_NAME_HINT = 'ZOOM MS Plus Series';

// Device ID shared by the whole "Plus" series (not model-specific).
export const DEVICE_ID = 0x6e;

// A SysEx body may only hold 7-bit bytes. Uint8Array would silently wrap anything larger
// (256 becomes 0) where Python's bytes() raises, so check before building the message.
function message(bytes: number[]): Uint8Array {
  bytes.forEach((byte, i) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0x7f) {
      throw new RangeError(`SysEx byte ${i} out of range: ${byte}`);
    }
  });
  return Uint8Array.from(bytes);
}

export const pcModeOn = () => message([0x52, 0x00, DEVICE_ID, 0x52]);
export const pcModeOff = () => message([0x52, 0x00, DEVICE_ID, 0x53]);
export const editorModeOn = () => message([0x52, 0x00, DEVICE_ID, 0x50]);
export const editorModeOff = () => message([0x52, 0x00, DEVICE_ID, 0x51]);
export const patchCheck = () => message([0x52, 0x00, DEVICE_ID, 0x44]);
export const patchDownloadCurrent = () => message([0x52, 0x00, DEVICE_ID, 0x64, 0x13]);

function bankAndLocation(location: number, bankSize: number): [number, number] {
  const bank = Math.floor((location - 1) / bankSize);
  return [bank, location - bank * bankSize - 1];
}

export function patchDownload(location: number, bankSize: number): Uint8Array {
  const [bank, loc] = bankAndLocation(location, bankSize);
  return message([
    0x52, 0x00, DEVICE_ID, 0x46, 0x00, 0x00,
    bank & 0x7f, bank >> 7,
    loc & 0x7f, loc >> 7,
  ]);
}

// Standard CRC-32 (the one in zip, PNG and Python's binascii.crc32). Browsers have no
// built-in for it, so we carry our own table.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The 5-byte, 7-bit-packed CRC32 trailer for `data` (inverse of decodeChecksum). */
export function encodeChecksum(data: Uint8Array): Uint8Array {
  const crc = (crc32(data) ^ 0xffffffff) >>> 0;
  return message([
    crc & 0x7f, (crc >>> 7) & 0x7f, (crc >>> 14) & 0x7f, (crc >>> 21) & 0x7f,
    (crc >>> 28) & 0x0f,
  ]);
}

/** Store `data` in a patch slot. Same layout as the pedal's reply to patchDownload. */
export function patchUpload(location: number, bankSize: number, data: Uint8Array): Uint8Array {
  const [bank, loc] = bankAndLocation(location, bankSize);
  const length = data.length;
  return message([
    0x52, 0x00, DEVICE_ID, 0x45, 0x00, 0x00,
    bank & 0x7f, bank >> 7,
    loc & 0x7f, loc >> 7,
    length & 0x7f, (length >> 7) & 0x7f,
    ...pack8to7(data),
    ...encodeChecksum(data),
  ]);
}

/**
 * Unpack 7-bit-per-byte MIDI SysEx payload back into 8-bit data.
 *
 * Every 8th byte carries the high bit of the following 7 bytes.
 */
export function unpack7to8(packet: Uint8Array): Uint8Array {
  const data: number[] = [];
  let loop = -1;
  let hibits = 0;
  for (const byte of packet) {
    if (loop !== -1) {
      data.push(hibits & (1 << loop) ? 0x80 + byte : byte);
      loop -= 1;
    } else {
      hibits = byte;
      loop = 6;
    }
  }
  return Uint8Array.from(data);
}

/** Pack 8-bit data into 7-bit MIDI-safe bytes (inverse of unpack7to8). */
export function pack8to7(data: Uint8Array): Uint8Array {
  const packet: number[] = [];
  let group = [0];
  for (const byte of data) {
    group[0]! += (byte & 0x80) >> group.length;
    group.push(byte & 0x7f);
    if (group.length > 7) {
      packet.push(...group);
      group = [0];
    }
  }
  if (group.length > 1) {
    packet.push(...group);
  }
  return Uint8Array.from(packet);
}

/** Decode the 5-byte, 7-bit-packed CRC32 trailer used on patch replies. */
export function decodeChecksum(reply: Uint8Array): number {
  if (reply.length < 5) {
    throw new RangeError(`checksum needs 5 bytes, got ${reply.length}`);
  }
  // Multiply instead of shifting: `x << 28` overflows JS's signed 32-bit shifts.
  let crc = 0;
  reply.subarray(-5).forEach((byte, i) => {
    crc += (i === 4 ? byte & 0x0f : byte) * 2 ** (7 * i);
  });
  return crc;
}

// ---------- file access (the pedal's internal storage) ----------
//
// Only the read side is implemented: listing and downloading. Effect binaries
// live here as *.ZD2 files, indexed by FLST_SEQ.ZT2.

const FILE_CMD = 0x60;

function fileName(name: string): number[] {
  const codes = Array.from(name, (char) => char.charCodeAt(0));
  if (codes.some((code) => code > 0x7f)) {
    throw new RangeError(`file name must be ASCII: ${name}`);
  }
  return [...codes, 0x00];
}

export const fileFindFirst = (pattern = '*') =>
  message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x25, 0x00, 0x00, ...fileName(pattern)]);

export const fileFindNext = (pattern = '*') =>
  message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x26, 0x00, 0x00, ...fileName(pattern)]);

export const fileFindEnd = () => message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x27]);

export const fileOpenRead = (name: string) =>
  message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x20, 0x02, ...Array(9).fill(0x00), ...fileName(name)]);

export const fileSync = () => message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x05, 0x00]);

export const fileReadBlock = () =>
  message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x22, 0x14, 0x2f, 0x60, 0x00, 0x0c, 0x00, 0x04,
    0x00, 0x00, 0x00]);

/** Closing takes two messages, sent in order. */
export const fileClose = () => [
  message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x21, 0x40, 0x00, 0x00, 0x00, 0x00]),
  message([0x52, 0x00, DEVICE_ID, FILE_CMD, 0x09]),
];
