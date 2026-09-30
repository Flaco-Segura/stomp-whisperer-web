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
}

export interface PatchGolden {
  slot: number;
  input: string;
  sha256: string;
  declared_length: number;
  encoded: string;
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
