// Backups of every patch slot as one JSON file, so the user can restore the pedal before
// (and after) anything is written to it.
//
// The Python app keeps one patch_NNN.bin per slot; a browser would need one download per
// file, so here all slots go into a single JSON document with the bytes in base64.
// A backup file comes back from the user's disk later, so parseBackup checks everything.

import type { PatchInfo, SlotRead } from './pedal';

export const BACKUP_FORMAT = 'stomp-whisperer-backup';
export const BACKUP_VERSION = 1;

export class BackupFormatError extends Error {
  override name = 'BackupFormatError';
}

export interface Backup {
  createdAt: Date;
  info: PatchInfo;
  slots: SlotRead[];
}

/** The JSON shape on disk. */
interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  pedal: PatchInfo;
  slots: { slot: number; checksumOk: boolean; data: string }[];
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: String.fromCharCode(...hugeArray) can overflow the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new BackupFormatError('invalid base64 data');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A backup must hold every slot the pedal reported, in order: a partial one is refused. */
export function createBackup(info: PatchInfo, slots: SlotRead[], createdAt = new Date()): Backup {
  checkSlots(info, slots);
  return { createdAt, info, slots };
}

export function backupToJson(backup: Backup): string {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: backup.createdAt.toISOString(),
    pedal: backup.info,
    slots: backup.slots.map(({ slot, checksumOk, data }) => ({ slot, checksumOk, data: toBase64(data) })),
  };
  return JSON.stringify(file, null, 1);
}

/** Read a backup file's text, checking its structure; throws BackupFormatError. */
export function parseBackup(text: string): Backup {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BackupFormatError('not a JSON file');
  }
  if (!isObject(file) || file.format !== BACKUP_FORMAT) {
    throw new BackupFormatError('not a StompWhisperer backup');
  }
  if (file.version !== BACKUP_VERSION) {
    throw new BackupFormatError(`unsupported backup version: ${String(file.version)}`);
  }
  const createdAt = new Date(typeof file.createdAt === 'string' ? file.createdAt : NaN);
  if (Number.isNaN(createdAt.getTime())) {
    throw new BackupFormatError('invalid creation date');
  }
  const pedal = file.pedal;
  if (!isObject(pedal) || !isPositiveInt(pedal.count) || !isPositiveInt(pedal.patchSize) ||
      !isPositiveInt(pedal.bankSize)) {
    throw new BackupFormatError('invalid pedal information');
  }
  const info: PatchInfo = { count: pedal.count, patchSize: pedal.patchSize, bankSize: pedal.bankSize };
  if (!Array.isArray(file.slots)) {
    throw new BackupFormatError('missing slot list');
  }
  const slots = file.slots.map((entry: unknown): SlotRead => {
    if (!isObject(entry) || !isPositiveInt(entry.slot) || typeof entry.checksumOk !== 'boolean' ||
        typeof entry.data !== 'string') {
      throw new BackupFormatError('invalid slot entry');
    }
    return { slot: entry.slot, checksumOk: entry.checksumOk, data: fromBase64(entry.data) };
  });
  checkSlots(info, slots);
  return { createdAt, info, slots };
}

/** A file name with the local date and time, e.g. stomp-whisperer-backup-2026-10-06-1830.json. */
export function backupFileName(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${BACKUP_FORMAT}-${day}-${two(date.getHours())}${two(date.getMinutes())}.json`;
}

function checkSlots(info: PatchInfo, slots: SlotRead[]): void {
  if (slots.length !== info.count) {
    throw new BackupFormatError(`expected ${info.count} slots, got ${slots.length}`);
  }
  slots.forEach((read, i) => {
    if (read.slot !== i + 1) {
      throw new BackupFormatError(`slot ${read.slot} out of order (expected ${i + 1})`);
    }
    if (read.data.length > info.patchSize) {
      throw new BackupFormatError(`slot ${read.slot} is larger than a patch (${read.data.length} bytes)`);
    }
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
