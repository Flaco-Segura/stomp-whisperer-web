// A pretend MS-50G+ behind a SysexTransport, so the Pedal class can be tested without
// hardware. It answers the commands the way the real pedal does, and stores uploads.
import { type SysexTransport, decodePatchReply } from '../src/pedal';
import * as protocol from '../src/protocol';

export class FakePedal implements SysexTransport {
  readonly sent: Uint8Array[] = [];
  silent = false; // when true, it never answers
  corruptWrites = false; // when true, an upload stores its data with one byte flipped
  editBuffer = new Uint8Array(); // the patch on screen, edits included (patch_download_current)
  files = new Map<string, Uint8Array>(); // the pedal's storage (file commands 0x60)
  fileBlockSize = 16; // bytes per file block (the real pedal sends larger ones)
  corruptFileBlocks = false; // when true, file blocks arrive with a wrong checksum
  private found: string[] = []; // names left for file_find_next
  private openFile: { data: Uint8Array; offset: number } | null = null;
  private pendingBlock: Uint8Array | null = null; // answered by the sync after a block read
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
      case 0x64: { // patch_download_current: header 52 00 6E 64 12 01 <len lo> <len hi>
        const upload = protocol.patchUpload(1, this.bankSize, this.editBuffer);
        return Uint8Array.from([...head, 0x64, 0x12, 0x01, ...upload.subarray(10)]);
      }
      case 0x60:
        return this.answerFile(body);
      default: // pc mode on/off and anything else get a bare acknowledgement
        return Uint8Array.from([...head, 0x00]);
    }
  }

  private answerFile(body: Uint8Array): Uint8Array {
    const head = [0x52, 0x00, protocol.DEVICE_ID, 0x60];
    const ack = Uint8Array.from([...head, 0x00]);
    const name = (from: number) => String.fromCharCode(...body.subarray(from, body.indexOf(0, from)));
    switch (body[4]) {
      case 0x25: // file_find_first (only "*" is supported)
      case 0x26: { // file_find_next: 0x04 + the name at offset 14 while files remain
        if (body[4] === 0x25) {
          this.found = [...this.files.keys()];
        }
        const next = this.found.shift();
        if (next === undefined) {
          return ack;
        }
        const raw = new Uint8Array(12);
        raw.set(Array.from(next, (char) => char.charCodeAt(0)));
        return Uint8Array.from([...head, 0x04, ...new Uint8Array(9), ...raw]);
      }
      case 0x20: { // file_open_read: the name starts at offset 15
        const data = this.files.get(name(15));
        this.openFile = data ? { data, offset: 0 } : null;
        return ack;
      }
      case 0x22: // file_read_block
        if (this.openFile) {
          const { data, offset } = this.openFile;
          this.pendingBlock = data.subarray(offset, offset + this.fileBlockSize);
          this.openFile.offset += this.pendingBlock.length;
        }
        return ack;
      case 0x05: { // file_sync: after a block read it carries the block (empty at the end)
        const block = this.pendingBlock;
        this.pendingBlock = null;
        if (block === null) {
          return ack;
        }
        const checksum = protocol.encodeChecksum(this.corruptFileBlocks ? Uint8Array.of(...block, 1) : block);
        const length = [block.length & 0x7f, block.length >> 7];
        return Uint8Array.from([...head, 0x04, 0, 0, 0, ...length, ...protocol.pack8to7(block), ...checksum]);
      }
      default: // file_find_end, file_close
        this.openFile = null;
        return ack;
    }
  }
}
