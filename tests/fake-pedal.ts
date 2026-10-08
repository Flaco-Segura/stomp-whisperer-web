// A pretend MS-50G+ behind a SysexTransport, so the Pedal class can be tested without
// hardware. It answers the commands the way the real pedal does, and stores uploads.
import { type SysexTransport, decodePatchReply } from '../src/pedal';
import * as protocol from '../src/protocol';

export class FakePedal implements SysexTransport {
  readonly sent: Uint8Array[] = [];
  silent = false; // when true, it never answers
  corruptWrites = false; // when true, an upload stores its data with one byte flipped
  private handler: ((body: Uint8Array) => void) | null = null;
  readonly slots: Uint8Array[];
  private readonly bankSize: number;
  private readonly patchSize: number;

  constructor(slots: Uint8Array[], { bankSize = 10, patchSize = 1024 } = {}) {
    this.slots = slots;
    this.bankSize = bankSize;
    this.patchSize = patchSize;
  }

  send(body: Uint8Array): void {
    this.sent.push(body);
    const reply = this.silent ? null : this.answer(body);
    if (reply) {
      setTimeout(() => this.handler?.(reply), 0); // replies arrive later, like real MIDI
    }
  }

  listen(handler: (body: Uint8Array) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.handler = null;
  }

  /** The command byte of each message sent so far. */
  commands(): number[] {
    return this.sent.map((body) => body[3]!);
  }

  private answer(body: Uint8Array): Uint8Array | null {
    const head = [0x52, 0x00, protocol.DEVICE_ID];
    const count = this.slots.length;
    switch (body[3]) {
      case 0x44: // patch_check
        return Uint8Array.from([
          ...head, 0x43,
          count & 0x7f, count >> 7,
          this.patchSize & 0x7f, this.patchSize >> 7,
          0, 0,
          this.bankSize & 0x7f, this.bankSize >> 7,
        ]);
      case 0x46: { // patch_download: the reply has the same layout as a patch upload
        const bank = body[6]! + (body[7]! << 7);
        const location = body[8]! + (body[9]! << 7);
        const slot = bank * this.bankSize + location + 1;
        return protocol.patchUpload(slot, this.bankSize, this.slots[slot - 1]!);
      }
      case 0x45: { // patch_upload: store the data
        const bank = body[6]! + (body[7]! << 7);
        const location = body[8]! + (body[9]! << 7);
        const slot = bank * this.bankSize + location + 1;
        const { data } = decodePatchReply(body, 12);
        if (this.corruptWrites) {
          data[10] = data[10]! ^ 0x01;
        }
        this.slots[slot - 1] = data;
        return Uint8Array.from([...head, 0x00]);
      }
      default: // pc mode on/off and anything else get a bare acknowledgement
        return Uint8Array.from([...head, 0x00]);
    }
  }
}
