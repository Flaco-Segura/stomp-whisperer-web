import { describe, expect, it } from 'vitest';

import { patchDescription } from '../src/patch';
import { isFactorySlot, toSlotEntry, usedEffects } from '../src/slots';
import { hasGolden, loadPatch } from './golden';

describe('slots', () => {
  it('reports empty and unreadable slots instead of failing', () => {
    expect(toSlotEntry({ slot: 3, data: new Uint8Array(), checksumOk: true }).error).toBe('Slot is empty');
    const garbage = toSlotEntry({ slot: 4, data: new Uint8Array(64), checksumOk: false });
    expect(garbage).toMatchObject({ patch: null, error: 'missing PTCF header', checksumOk: false });
  });

  it('tells factory slots from user slots', () => {
    expect(isFactorySlot(85)).toBe(true);
    expect(isFactorySlot(86)).toBe(false);
  });
});

describe.skipIf(!hasGolden)('slots against golden files', () => {
  it('parses a real patch with its description', () => {
    const entry = toSlotEntry({ slot: 1, data: loadPatch(1).raw, checksumOk: true });
    expect(entry.error).toBeNull();
    expect(usedEffects(entry.patch!)).toHaveLength(1);
    expect(patchDescription(entry.patch!)).toMatch(/^This high-gain sound/);
  });
});
