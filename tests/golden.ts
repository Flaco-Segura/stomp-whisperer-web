// Access to the golden files exported by the Python app (`stomp-whisperer golden`).
// They hold personal patches, so they are git-ignored and absent in CI: tests that need
// them must be wrapped in `describe.skipIf(!hasGolden)`.
import { existsSync, readFileSync } from 'node:fs';

const GOLDEN_DIR = new URL('../golden/', import.meta.url);

export const hasGolden = existsSync(new URL('manifest.json', GOLDEN_DIR));

export interface Manifest {
  format_version: number;
  source_commit: string;
  patches: { slot: number; name: string; roundtrip: boolean; edits: number }[];
}

export interface ProtocolGolden {
  device_id: number;
  bank_size: number;
  messages: Record<string, string | string[]>;
  format_name: { input: string; stored?: string; error?: boolean }[];
  param_limits: number[];
}

export interface EffectGolden {
  id: number;
  enabled: boolean;
  params: number[];
  extra: number;
  origin: number | null;
}

export interface ParsedGolden {
  name: string;
  display_name: string;
  version: number;
  target: number;
  reserved: string;
  effect_ids: number[];
  effects: EffectGolden[];
  chunks: Record<string, string>;
}

// The edit operations of golden.py, applied in order before encoding.
export type EditOp =
  | { op: 'toggle'; index: number }
  | { op: 'set_params'; index: number; params: number[] }
  | { op: 'rename'; name: string }
  | { op: 'reverse' }
  | { op: 'remove'; index: number }
  | { op: 'add'; effect: Omit<EffectGolden, 'origin'> };

export interface EditGolden {
  name: string;
  ops: EditOp[];
  preamp: (boolean | null)[] | null;
  encoded: string;
  reparsed: ParsedGolden;
}

export interface PatchGolden {
  slot: number;
  input: string;
  sha256: string;
  declared_length: number;
  parsed: ParsedGolden;
  encoded: string;
  roundtrip: boolean;
  edits: EditGolden[];
  sysex: {
    patch_download: string;
    packed_8to7: string;
    unpacks_back: boolean;
    checksum: string;
    patch_upload_encoded: string;
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, GOLDEN_DIR), 'utf8')) as T;
}

export const loadManifest = () => readJson<Manifest>('manifest.json');
export const loadProtocol = () => readJson<ProtocolGolden>('protocol.json');

export function loadPatch(slot: number): { raw: Uint8Array; golden: PatchGolden } {
  const name = String(slot).padStart(3, '0');
  const golden = readJson<PatchGolden>(`patches/${name}.json`);
  const raw = new Uint8Array(readFileSync(new URL(`patches/${golden.input}`, GOLDEN_DIR)));
  return { raw, golden };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}
