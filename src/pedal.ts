// Request/reply exchanges with the pedal, and the read-only operations built on them.
// Port of the read side of stomp_whisperer/pedal.py.
//
// The MIDI connection itself comes from outside as a SysexTransport: src/webmidi.ts in
// the browser, a fake pedal in the tests. That keeps this module free of browser APIs.

import * as protocol from './protocol';

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
