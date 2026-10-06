import { describe, expect, it } from 'vitest';

import {
  BackupFormatError,
  backupFileName,
  backupToJson,
  createBackup,
  fromBase64,
  parseBackup,
  toBase64,
} from '../src/backup';
import type { PatchInfo, SlotRead } from '../src/pedal';
import { hasGolden, loadPatch } from './golden';

const info: PatchInfo = { count: 3, patchSize: 16, bankSize: 10 };
const slots: SlotRead[] = [
  { slot: 1, data: Uint8Array.from([0, 1, 2, 0x7f, 0x80, 0xff]), checksumOk: true },
  { slot: 2, data: new Uint8Array(), checksumOk: true },
  { slot: 3, data: new Uint8Array(16).fill(0xaa), checksumOk: false },
];
const date = new Date(2026, 9, 6, 18, 30);

/** Edit the JSON of a valid backup and return the text again. */
function tamper(edit: (file: any) => void): string {
  const file = JSON.parse(backupToJson(createBackup(info, slots, date)));
  edit(file);
  return JSON.stringify(file);
}

describe('backup', () => {
  it('round-trips every byte through base64', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
    expect(toBase64(new Uint8Array())).toBe('');
  });

  it('round-trips a backup through JSON', () => {
    const backup = parseBackup(backupToJson(createBackup(info, slots, date)));
    expect(backup).toEqual({ createdAt: date, info, slots });
  });

  it('refuses a partial or out-of-order slot list', () => {
    expect(() => createBackup(info, slots.slice(0, 2))).toThrow('expected 3 slots, got 2');
    expect(() => createBackup(info, [slots[1]!, slots[0]!, slots[2]!])).toThrow('out of order');
  });

  it('rejects files that are not valid backups', () => {
    const cases: [string, string][] = [
      ['{oops', 'not a JSON file'],
      ['[]', 'not a StompWhisperer backup'],
      [tamper((f) => (f.version = 2)), 'unsupported backup version: 2'],
      [tamper((f) => (f.createdAt = 'yesterday')), 'invalid creation date'],
      [tamper((f) => (f.pedal.count = -1)), 'invalid pedal information'],
      [tamper((f) => delete f.slots), 'missing slot list'],
      [tamper((f) => (f.slots[0].checksumOk = 'yes')), 'invalid slot entry'],
      [tamper((f) => (f.slots[0].data = '***')), 'invalid base64 data'],
      [tamper((f) => f.slots.pop()), 'expected 3 slots, got 2'],
      [tamper((f) => (f.slots[2].data = toBase64(new Uint8Array(17)))), 'larger than a patch'],
    ];
    for (const [text, message] of cases) {
      expect(() => parseBackup(text)).toThrow(BackupFormatError);
      expect(() => parseBackup(text)).toThrow(message);
    }
  });

  it('names the file after the local date and time', () => {
    expect(backupFileName(date)).toBe('stomp-whisperer-backup-2026-10-06-1830.json');
  });
});

describe.skipIf(!hasGolden)('backup against golden files', () => {
  it('keeps all 100 real patches intact', () => {
    const real: PatchInfo = { count: 100, patchSize: 848, bankSize: 10 };
    const reads = Array.from({ length: 100 }, (_, i) => ({
      slot: i + 1,
      data: loadPatch(i + 1).raw,
      checksumOk: true,
    }));
    expect(parseBackup(backupToJson(createBackup(real, reads))).slots).toEqual(reads);
  });
});
