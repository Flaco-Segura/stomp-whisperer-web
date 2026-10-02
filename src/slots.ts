// What the UI shows for each patch slot read from the pedal.

import { type Effect, type Patch, PatchFormatError, parsePatch } from './patch';
import type { SlotRead } from './pedal';

/** Slots 1–85 hold factory patches (never to be overwritten); 86–100 are the user's. */
export const FIRST_USER_SLOT = 86;

export const isFactorySlot = (slot: number) => slot < FIRST_USER_SLOT;

export interface SlotEntry {
  slot: number;
  checksumOk: boolean;
  patch: Patch | null;
  error: string | null;
}

export function toSlotEntry({ slot, data, checksumOk }: SlotRead): SlotEntry {
  if (data.length === 0) {
    return { slot, checksumOk, patch: null, error: 'Slot is empty' };
  }
  try {
    return { slot, checksumOk, patch: parsePatch(data), error: null };
  } catch (error) {
    if (error instanceof PatchFormatError) {
      return { slot, checksumOk, patch: null, error: error.message };
    }
    throw error;
  }
}

/** The effects actually placed in the patch (id 0 marks an empty position). */
export const usedEffects = (patch: Patch): Effect[] => patch.effects.filter((e) => e.id !== 0);

export const effectIdHex = (effect: Effect) => effect.id.toString(16).padStart(8, '0');
