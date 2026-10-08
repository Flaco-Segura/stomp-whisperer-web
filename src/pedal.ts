// Request/reply exchanges with the pedal, and the operations built on them: reading every
// slot and writing one user slot. Port of stomp_whisperer/pedal.py.
//
// The MIDI connection itself comes from outside as a SysexTransport: src/webmidi.ts in
// the browser, a fake pedal in the tests. That keeps this module free of browser APIs.

import * as protocol from './protocol';
import { FIRST_USER_SLOT } from './slots';

export interface SysexTransport {
  /** Send one SysEx body (without the F0 / F7 framing). */
  send(body: Uint8Array): void;
  /** Set the handler for incoming SysEx bodies (without F0 / F7). */
  listen(handler: (body: Uint8Array) => void): void;
  close(): void;
}

export class PedalTimeoutError extends Error {
  override name = 'PedalTimeoutError';
}

/** The pedal didn't store what was written: the slot read back holds something else. */
export class PedalWriteError extends Error {
  override name = 'PedalWriteError';
}

export interface PatchInfo {
  count: number;
  patchSize: number;
  bankSize: number;
}

export interface SlotRead {
  slot: number;
  data: Uint8Array; // empty for an empty slot
  checksumOk: boolean;
}

/** The patch bytes in a reply to patchDownload (headerLength 12) or patchDownloadCurrent (8). */
export function decodePatchReply(
  reply: Uint8Array,
  headerLength: number,
): { data: Uint8Array; checksumOk: boolean } {
  if (reply.length < headerLength) {
    throw new RangeError(`Patch reply too short: ${reply.length} bytes`);
  }
  const length = reply[headerLength - 1]! * 128 + reply[headerLength - 2]!;
  if (length === 0) {
    return { data: new Uint8Array(), checksumOk: true };
  }
  const packed = reply.subarray(headerLength, headerLength + length + Math.floor(length / 7) + 1);
  const data = protocol.unpack7to8(packed);
  const checksumOk = (protocol.decodeChecksum(reply) ^ 0xffffffff) >>> 0 === protocol.crc32(data);
  return { data, checksumOk };
}

export class Pedal {
  private readonly transport: SysexTransport;
  private readonly timeoutMs: number;
  private waiting: ((reply: Uint8Array) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(transport: SysexTransport, timeoutMs = 2000) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    // A reply nobody is waiting for (a late one, after a timeout) is dropped.
    transport.listen((reply) => {
      const waiting = this.waiting;
      this.waiting = null;
      waiting?.(reply);
    });
  }

  close(): void {
    this.transport.close();
  }

  /**
   * Send `body` and resolve with the next SysEx reply, or null after the timeout.
   * Exchanges are queued so a reply can't be taken by the wrong request.
   */
  private exchange(body: Uint8Array): Promise<Uint8Array | null> {
    const run = () =>
      new Promise<Uint8Array | null>((resolve) => {
        const timer = setTimeout(() => {
          this.waiting = null;
          resolve(null);
        }, this.timeoutMs);
        this.waiting = (reply) => {
          clearTimeout(timer);
          resolve(reply);
        };
        this.transport.send(body);
      });
    const result = this.queue.then(run, run);
    this.queue = result;
    return result;
  }

  private async request(body: Uint8Array, what: string): Promise<Uint8Array> {
    const reply = await this.exchange(body);
    if (reply === null) {
      throw new PedalTimeoutError(`Pedal did not respond to ${what}`);
    }
    return reply;
  }

  // The pedal's answer to these doesn't matter, nor whether it answers at all.
  async pcModeOn(): Promise<void> {
    await this.exchange(protocol.pcModeOn());
  }

  async pcModeOff(): Promise<void> {
    await this.exchange(protocol.pcModeOff());
  }

  async patchCheck(): Promise<PatchInfo> {
    const reply = await this.request(protocol.patchCheck(), 'patch_check');
    if (reply.length < 12) {
      throw new RangeError(`patch_check reply too short: ${reply.length} bytes`);
    }
    return {
      count: reply[5]! * 128 + reply[4]!,
      patchSize: reply[7]! * 128 + reply[6]!,
      bankSize: reply[11]! * 128 + reply[10]!,
    };
  }

  async downloadPatch(location: number, bankSize: number): Promise<SlotRead> {
    const reply = await this.request(
      protocol.patchDownload(location, bankSize),
      `patch_download(${location})`,
    );
    return { slot: location, ...decodePatchReply(reply, 12) };
  }

  /**
   * Store PTCF `patch` bytes in user slot `location`, then read the slot back to check it.
   *
   * The slot is sent padded with zeros to its full size, as the Python app does. Only the
   * patch's own bytes are compared (see patchBytes): the pedal fills the rest of the slot
   * with leftovers. Factory slots are refused here too, whatever the caller checked.
   * Returns the slot as read back; throws PedalWriteError if it doesn't hold `patch`.
   * Call it inside PC mode (writeSlot does).
   */
  async uploadPatch(location: number, info: PatchInfo, patch: Uint8Array): Promise<SlotRead> {
    if (!Number.isInteger(location) || location < FIRST_USER_SLOT || location > info.count) {
      throw new RangeError(`Only user slots ${FIRST_USER_SLOT}–${info.count} can be written, not ${location}`);
    }
    if (patch.length === 0 || patch.length > info.patchSize) {
      throw new RangeError(`A patch must be 1 to ${info.patchSize} bytes, not ${patch.length}`);
    }
    const isPtcf = patch.length >= 8 && String.fromCharCode(...patch.subarray(0, 4)) === 'PTCF';
    const length = isPtcf ? new DataView(patch.buffer, patch.byteOffset, 8).getUint32(4, true) : 0;
    if (!isPtcf || length < 8 || length > patch.length) {
      throw new RangeError('Not a PTCF patch');
    }
    const data = new Uint8Array(info.patchSize);
    data.set(patch);
    await this.request(protocol.patchUpload(location, info.bankSize, data), `patch_upload(${location})`);
    const stored = await this.downloadPatch(location, info.bankSize);
    const same = stored.data.length >= length && patch.subarray(0, length).every((byte, i) => byte === stored.data[i]);
    if (!stored.checksumOk || !same) {
      throw new PedalWriteError(`Slot ${location} doesn't hold the patch after writing it`);
    }
    return stored;
  }

  /** Write one user slot inside PC mode and return it as read back (see uploadPatch). */
  async writeSlot(location: number, patch: Uint8Array): Promise<SlotRead> {
    await this.pcModeOn();
    try {
      return await this.uploadPatch(location, await this.patchCheck(), patch);
    } finally {
      await this.pcModeOff();
    }
  }

  /** Read every patch slot, in order, reporting each one as it arrives. */
  async readAllSlots(onSlot?: (read: SlotRead, info: PatchInfo) => void): Promise<SlotRead[]> {
    await this.pcModeOn();
    try {
      const info = await this.patchCheck();
      const slots: SlotRead[] = [];
      for (let slot = 1; slot <= info.count; slot++) {
        const read = await this.downloadPatch(slot, info.bankSize);
        slots.push(read);
        onSlot?.(read, info);
      }
      return slots;
    } finally {
      await this.pcModeOff();
    }
  }
}
