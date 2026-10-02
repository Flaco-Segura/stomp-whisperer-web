import { describe, expect, it } from 'vitest';

import {
  type Patch,
  PatchFormatError,
  displayName,
  encodePatch,
  formatName,
  paramLimit,
  parsePatch,
} from '../src/patch';
import {
  type EditOp,
  type ParsedGolden,
  fromHex,
  hasGolden,
  loadManifest,
  loadPatch,
  loadProtocol,
  toHex,
} from './golden';

// Same shape as golden.py's _patch_json, so a parse can be compared with one toEqual.
function patchJson(patch: Patch): ParsedGolden {
  return {
    name: patch.name,
    display_name: displayName(patch),
    version: patch.version,
    target: patch.target,
    reserved: toHex(patch.reserved),
    effect_ids: patch.effectIds,
    effects: patch.effects.map((e) => ({ ...e, params: [...e.params] })),
    chunks: Object.fromEntries([...patch.chunks].map(([tag, payload]) => [tag, toHex(payload)])),
  };
}

// Port of golden.py's _apply.
function applyOp(patch: Patch, op: EditOp): void {
  switch (op.op) {
    case 'toggle': {
      const effect = patch.effects[op.index]!;
      effect.enabled = !effect.enabled;
      break;
    }
    case 'set_params':
      patch.effects[op.index]!.params = [...op.params];
      break;
    case 'rename':
      patch.name = op.name;
      break;
    case 'reverse':
      patch.effects.reverse();
      break;
    case 'remove':
      patch.effects.splice(op.index, 1);
      break;
    case 'add':
      patch.effects.push({ ...op.effect, params: [...op.effect.params], origin: null });
      break;
  }
}

function samplePatch(): Patch {
  return {
    name: 'Test',
    version: 2,
    target: 0x40000,
    effectIds: [],
    effects: [
      { id: 0x4000081, enabled: true, params: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], extra: 0, origin: 0 },
      { id: 0x1234, enabled: false, params: Array(12).fill(0), extra: 7, origin: 1 },
    ],
    chunks: new Map([['TXJ1', new Uint8Array([1, 2, 3])]]),
    reserved: new Uint8Array(6),
  };
}

describe('patch', () => {
  it('knows the width of each parameter', () => {
    expect(paramLimit(0)).toBe(4095);
    expect(paramLimit(5)).toBe(255);
    expect(() => paramLimit(12)).toThrow(RangeError);
  });

  it('lays out names on the two lines of the display', () => {
    expect(formatName('OverDrive +Delay')).toBe('OverDrive     +Delay');
    expect(() => formatName('   ')).toThrow();
  });

  it('rejects data without the PTCF header', () => {
    expect(() => parsePatch(new Uint8Array(40))).toThrow(PatchFormatError);
  });

  it('parses back what it encodes', () => {
    const patch = samplePatch();
    const parsed = parsePatch(encodePatch(patch));
    expect(parsed.name).toBe('Test');
    expect(parsed.effectIds).toEqual([0x4000081, 0x1234]);
    expect(parsed.effects).toEqual(patch.effects);
    expect([...parsed.chunks.keys()]).toEqual(['TXJ1', 'EDTB', 'NAME']);
  });

  it('refuses values that do not fit the format', () => {
    const tooMany = samplePatch();
    tooMany.effects = Array.from({ length: 12 }, () => ({ ...samplePatch().effects[0]! }));
    expect(() => encodePatch(tooMany)).toThrow(RangeError);

    const bigParam = samplePatch();
    bigParam.effects[0]!.params[5] = 256;
    expect(() => encodePatch(bigParam)).toThrow(RangeError);

    const notAscii = samplePatch();
    notAscii.name = 'Señal';
    expect(() => encodePatch(notAscii)).toThrow();
  });
});

describe.skipIf(!hasGolden)('patch against golden files', () => {
  it('formats names and knows the parameter limits', () => {
    const golden = loadProtocol();
    for (const { input, stored, error } of golden.format_name) {
      if (error) {
        expect(() => formatName(input), JSON.stringify(input)).toThrow();
      } else {
        expect(formatName(input), JSON.stringify(input)).toBe(stored);
      }
    }
    expect(golden.param_limits.map((_, i) => paramLimit(i))).toEqual(golden.param_limits);
  });

  const slots = hasGolden ? loadManifest().patches.map((p) => p.slot) : [];

  it.each(slots)('slot %i: parse and encode', (slot) => {
    const { raw, golden } = loadPatch(slot);
    const patch = parsePatch(raw);
    expect(patchJson(patch)).toEqual(golden.parsed);

    const encoded = toHex(encodePatch(patch));
    expect(encoded).toBe(golden.encoded);
    expect(encoded === toHex(raw.subarray(0, golden.declared_length))).toBe(golden.roundtrip);
  });

  it.each(slots)('slot %i: edits', (slot) => {
    const { raw, golden } = loadPatch(slot);
    for (const edit of golden.edits) {
      const patch = parsePatch(raw);
      edit.ops.forEach((op) => applyOp(patch, op));
      const encoded = encodePatch(patch, edit.preamp);
      expect(toHex(encoded), edit.name).toBe(edit.encoded);
      expect(patchJson(parsePatch(fromHex(edit.encoded))), edit.name).toEqual(edit.reparsed);
    }
  });
});
