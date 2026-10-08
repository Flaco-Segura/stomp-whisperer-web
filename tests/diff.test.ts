import { describe, expect, it } from 'vitest';

import { patchChanges } from '../src/diff';
import { type Effect, type Patch, parsePatch } from '../src/patch';
import { hasGolden, loadPatch } from './golden';

const effect = (id: number, enabled = true, params = Array(12).fill(0)): Effect =>
  ({ id, enabled, params, extra: 0, origin: null });

/** A PRM2 chunk with `selected` in bits 85–87 and any extra bytes set. */
function prm2(selected: number, bytes: Record<number, number> = {}): Uint8Array {
  const data = new Uint8Array(32);
  data[10] = selected << 5;
  for (const [i, value] of Object.entries(bytes)) {
    data[Number(i)]! |= value;
  }
  return data;
}

function patch(fields: Partial<Patch> = {}): Patch {
  return {
    name: 'Clean',
    version: 2,
    target: 0,
    effectIds: [],
    effects: [effect(0x10), effect(0x20)],
    chunks: new Map([['TXE1', new Uint8Array([0x41])], ['PRM2', prm2(0)]]),
    reserved: new Uint8Array(6),
    ...fields,
  };
}

describe('patchChanges', () => {
  it('finds nothing in identical patches', () => {
    expect(patchChanges(patch(), patch())).toEqual([]);
  });

  it('reports sound changes in words', () => {
    const after = patch({
      name: 'Dirty',
      effects: [effect(0x10, false, [5, ...Array(11).fill(0)]), effect(0x30), effect(0x40)],
      chunks: new Map([['TXE1', new Uint8Array([0x42])], ['PRM2', prm2(0)]]),
    });
    expect(patchChanges(patch(), after)).toEqual([
      { kind: 'sound', text: 'Name: "Clean" → "Dirty"' },
      { kind: 'sound', text: 'Effect 1 turned off' },
      { kind: 'sound', text: 'Effect 1 P1: 0 → 5' },
      { kind: 'sound', text: 'Effect 2 replaced: 00000020 → 00000030' },
      { kind: 'sound', text: 'Effect 3 added: 00000040' },
      { kind: 'sound', text: 'Description changed' },
    ]);
    expect(patchChanges(after, patch())).toContainEqual({ kind: 'sound', text: 'Effect 3 removed: 00000040' });
  });

  it('reports PRM2 as pedal state, the selected effect apart from the other bits', () => {
    const after = patch({ chunks: new Map([['TXE1', new Uint8Array([0x41])], ['PRM2', prm2(2, { 10: 1, 11: 0x7f })]]) });
    expect(patchChanges(patch(), after)).toEqual([
      { kind: 'state', text: 'Effect selected on screen: 1 → 3' },
      { kind: 'state', text: 'PRM2 byte 10: 00 → 01 (meaning unknown)' },
      { kind: 'state', text: 'PRM2 byte 11: 00 → 7f (meaning unknown)' },
    ]);
  });
});

describe.skipIf(!hasGolden)('patchChanges against golden files', () => {
  it('finds no changes between a real patch and itself, and some between different ones', () => {
    for (let slot = 1; slot <= 100; slot++) {
      const real = parsePatch(loadPatch(slot).raw);
      expect(patchChanges(real, parsePatch(loadPatch(slot).raw))).toEqual([]);
    }
    const changes = patchChanges(parsePatch(loadPatch(1).raw), parsePatch(loadPatch(2).raw));
    expect(changes.some((c) => c.kind === 'sound')).toBe(true);
  });
});
