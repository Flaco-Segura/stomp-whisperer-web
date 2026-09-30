import { describe, expect, it } from 'vitest';

import * as protocol from '../src/protocol';
import { fromHex, hasGolden, loadManifest, loadPatch, loadProtocol, toHex } from './golden';

describe('protocol', () => {
  it('packs and unpacks back to the original bytes', () => {
    const original = Uint8Array.from({ length: 86 }, (_, i) => i * 3); // with and without high bit
    const unpacked = protocol.unpack7to8(protocol.pack8to7(original));
    expect(toHex(unpacked.subarray(0, original.length))).toBe(toHex(original));
  });

  it('packs into 7-bit safe bytes', () => {
    const packed = protocol.pack8to7(new Uint8Array([0xff, 0x80, 0x7f, 0x00]));
    expect(packed.every((byte) => byte < 0x80)).toBe(true);
  });

  it('builds a patch upload that mirrors the download reply', () => {
    const data = Uint8Array.from({ length: 200 }, (_, i) => i);
    const body = protocol.patchUpload(23, 10, data);
    expect(Array.from(body.subarray(0, 12))).toEqual([
      0x52, 0x00, protocol.DEVICE_ID, 0x45, 0x00, 0x00, 2, 0, 2, 0, 200 & 0x7f, 200 >> 7,
    ]);
    expect(body.every((byte) => byte < 0x80)).toBe(true);
    // Decoded the way the pedal's reply to patch_download is.
    const packedLength = 200 + Math.floor(200 / 7) + 1;
    expect(toHex(protocol.unpack7to8(body.subarray(12, 12 + packedLength)))).toBe(toHex(data));
    expect((protocol.decodeChecksum(body) ^ 0xffffffff) >>> 0).toBe(protocol.crc32(data));
  });

  it('computes the standard CRC-32', () => {
    // The check value every CRC-32 implementation is tested against.
    expect(protocol.crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('rejects checksum replies shorter than 5 bytes', () => {
    expect(() => protocol.decodeChecksum(new Uint8Array(4))).toThrow();
  });
});

describe.skipIf(!hasGolden)('protocol against golden files', () => {
  it('builds the fixed messages', () => {
    const golden = loadProtocol();
    expect(protocol.DEVICE_ID).toBe(golden.device_id);

    const built: Record<string, Uint8Array | Uint8Array[]> = {
      pc_mode_on: protocol.pcModeOn(),
      pc_mode_off: protocol.pcModeOff(),
      editor_mode_on: protocol.editorModeOn(),
      editor_mode_off: protocol.editorModeOff(),
      patch_check: protocol.patchCheck(),
      patch_download_current: protocol.patchDownloadCurrent(),
      file_find_first: protocol.fileFindFirst(),
      file_find_next: protocol.fileFindNext(),
      file_find_end: protocol.fileFindEnd(),
      'file_open_read_FLST_SEQ.ZT2': protocol.fileOpenRead('FLST_SEQ.ZT2'),
      file_sync: protocol.fileSync(),
      file_read_block: protocol.fileReadBlock(),
      file_close: protocol.fileClose(),
    };
    const hexed = Object.fromEntries(
      Object.entries(built).map(([name, msg]) => [
        name,
        Array.isArray(msg) ? msg.map(toHex) : toHex(msg),
      ]),
    );
    expect(hexed).toEqual(golden.messages);
  });

  const { bank_size: bankSize } = hasGolden ? loadProtocol() : { bank_size: 0 };
  const slots = hasGolden ? loadManifest().patches.map((p) => p.slot) : [];

  it.each(slots)('slot %i: SysEx messages', (slot) => {
    const { raw, golden } = loadPatch(slot);
    const { sysex } = golden;

    expect(toHex(protocol.patchDownload(slot, bankSize))).toBe(sysex.patch_download);

    const packed = protocol.pack8to7(raw);
    expect(toHex(packed)).toBe(sysex.packed_8to7);
    expect(toHex(protocol.unpack7to8(packed)) === toHex(raw)).toBe(sysex.unpacks_back);

    expect(toHex(protocol.encodeChecksum(raw))).toBe(sysex.checksum);

    const upload = protocol.patchUpload(slot, bankSize, fromHex(golden.encoded));
    expect(toHex(upload)).toBe(sysex.patch_upload_encoded);
  });
});
