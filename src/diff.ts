// What changed in a patch between two reads (e.g. a backup and the pedal now), in words.
//
// Changes come in two kinds:
// - 'sound': what you hear: name, description, effects, their on/off state and parameters.
// - 'state': PRM2, the patch-wide settings. The pedal rewrites part of it just by browsing
//   (which effect is selected on screen), so a slot with only 'state' changes probably
//   sounds the same. Most PRM2 bytes are not understood yet: they are shown as raw bytes.

import { type Effect, type Patch, editedEffect } from './patch';

export type ChangeKind = 'sound' | 'state';

export interface Change {
  kind: ChangeKind;
  text: string;
}

// The effect selected on screen lives in PRM2 bits 85–87 (see patch.ts): the top three bits
// of byte 10. That byte is compared without them, so the change is reported only once.
const EDIT_BYTE = 10;
const EDIT_BYTE_REST = 0b0001_1111;

const hex = (n: number, digits: number) => n.toString(16).padStart(digits, '0');
const quoted = (text: string) => JSON.stringify(text);

/** Every difference between `before` and `after`, sound changes first. */
export function patchChanges(before: Patch, after: Patch): Change[] {
  const sound: string[] = [];
  if (before.name !== after.name) {
    sound.push(`Name: ${quoted(before.name.trim())} → ${quoted(after.name.trim())}`);
  }
  if (before.version !== after.version || before.target !== after.target ||
      !sameBytes(before.reserved, after.reserved)) {
    sound.push('Patch header changed');
  }
  const positions = Math.max(before.effects.length, after.effects.length);
  for (let i = 0; i < positions; i++) {
    sound.push(...effectChanges(i + 1, before.effects[i], after.effects[i]));
  }
  const tags = new Set([...before.chunks.keys(), ...after.chunks.keys()]);
  for (const tag of tags) {
    // EDTB is compared effect by effect above, NAME as the name; PRM2 is pedal state.
    if (tag === 'EDTB' || tag === 'NAME' || tag === 'PRM2') {
      continue;
    }
    const a = before.chunks.get(tag);
    const b = after.chunks.get(tag);
    if (!a || !b || !sameBytes(a, b)) {
      sound.push(tag === 'TXE1' ? 'Description changed' : `${tag} data changed`);
    }
  }
  const changes: Change[] = sound.map((text) => ({ kind: 'sound', text }));
  return changes.concat(stateChanges(before, after).map((text) => ({ kind: 'state', text })));
}

function effectChanges(position: number, before: Effect | undefined, after: Effect | undefined): string[] {
  const label = `Effect ${position}`;
  const id = (effect: Effect | undefined) => effect?.id ?? 0;
  if (id(before) === 0 && id(after) === 0) {
    return [];
  }
  if (id(before) === 0) {
    return [`${label} added: ${hex(id(after), 8)}`];
  }
  if (id(after) === 0) {
    return [`${label} removed: ${hex(id(before), 8)}`];
  }
  const [a, b] = [before!, after!];
  if (a.id !== b.id) {
    return [`${label} replaced: ${hex(a.id, 8)} → ${hex(b.id, 8)}`];
  }
  const texts: string[] = [];
  if (a.enabled !== b.enabled) {
    texts.push(`${label} turned ${b.enabled ? 'on' : 'off'}`);
  }
  a.params.forEach((value, i) => {
    if (value !== b.params[i]) {
      texts.push(`${label} P${i + 1}: ${value} → ${b.params[i]}`);
    }
  });
  if (a.extra !== b.extra) {
    texts.push(`${label}: unknown bits changed`);
  }
  return texts;
}

function stateChanges(before: Patch, after: Patch): string[] {
  const a = before.chunks.get('PRM2');
  const b = after.chunks.get('PRM2');
  if (!a && !b) {
    return [];
  }
  if (!a || !b || a.length !== b.length) {
    return ['PRM2 settings added, removed or resized'];
  }
  const texts: string[] = [];
  const [editedA, editedB] = [editedEffect(before), editedEffect(after)];
  if (editedA !== editedB && editedA !== null && editedB !== null) {
    texts.push(`Effect selected on screen: ${editedA + 1} → ${editedB + 1}`);
  }
  a.forEach((byte, i) => {
    const mask = i === EDIT_BYTE && editedA !== null ? EDIT_BYTE_REST : 0xff;
    if ((byte & mask) !== (b[i]! & mask)) {
      texts.push(`PRM2 byte ${i}: ${hex(byte & mask, 2)} → ${hex(b[i]! & mask, 2)} (meaning unknown)`);
    }
  });
  return texts;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
