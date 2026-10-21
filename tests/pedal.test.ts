import { describe, expect, it } from 'vitest';

import { encodePatch } from '../src/patch';
import { Pedal, PedalTimeoutError, PedalWriteError, SlotChangedError, decodePatchReply, hasUnsavedEdits } from '../src/pedal';
import * as protocol from '../src/protocol';
import { FakePedal } from './fake-pedal';
import { hasGolden, loadManifest, loadPatch, toHex } from './golden';

const PC_MODE_ON = 0x52;
const PC_MODE_OFF = 0x53;
const PATCH_CHECK = 0x44;
const PATCH_DOWNLOAD = 0x46;
const PATCH_UPLOAD = 0x45;
const PATCH_DOWNLOAD_CURRENT = 0x64;

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * seed) & 0xff);

describe('decodePatchReply', () => {
  it('unpacks the data and checks its CRC', () => {
    const data = bytes(300, 7);
    const reply = protocol.patchUpload(1, 10, data); // same layout as the pedal's reply
    const decoded = decodePatchReply(reply, 12);
    expect(toHex(decoded.data)).toBe(toHex(data));
    expect(decoded.checksumOk).toBe(true);
  });

  it('notices corrupted data', () => {
    const reply = protocol.patchUpload(1, 10, bytes(300, 7));
    reply[20] = reply[20]! ^ 0x01;
    expect(decodePatchReply(reply, 12).checksumOk).toBe(false);
  });

  it('reads an empty slot as no data', () => {
    const reply = protocol.patchUpload(1, 10, new Uint8Array());
    expect(decodePatchReply(reply, 12)).toEqual({ data: new Uint8Array(), checksumOk: true });
  });
});

describe('Pedal', () => {
  it('reads every slot and the patch on screen inside PC mode', async () => {
    const slots = [bytes(50, 3), new Uint8Array(), bytes(80, 5)];
    const fake = new FakePedal(slots, { bankSize: 2 });
    fake.editBuffer = bytes(80, 5);
    const pedal = new Pedal(fake);
    const progress: number[] = [];

    const { slots: reads, current } = await pedal.readAllSlots((read, info) => {
      expect(info).toEqual({ count: 3, patchSize: 1024, bankSize: 2 });
      progress.push(read.slot);
    });

    expect(progress).toEqual([1, 2, 3]);
    expect(reads.map((r) => toHex(r.data))).toEqual(slots.map(toHex));
    expect(reads.every((r) => r.checksumOk)).toBe(true);
    expect(toHex(current.data)).toBe(toHex(bytes(80, 5)));
    expect(fake.commands()).toEqual([
      PC_MODE_ON, PATCH_CHECK, PATCH_DOWNLOAD, PATCH_DOWNLOAD, PATCH_DOWNLOAD, PATCH_DOWNLOAD_CURRENT, PC_MODE_OFF,
    ]);
  });

  it('times out when the pedal stays silent, and still leaves PC mode', async () => {
    const fake = new FakePedal([bytes(10, 1)]);
    fake.silent = true;
    const pedal = new Pedal(fake, 20);

    await expect(pedal.readAllSlots()).rejects.toThrow(PedalTimeoutError);
    expect(fake.commands()).toEqual([PC_MODE_ON, PATCH_CHECK, PC_MODE_OFF]);
  });

  it('answers overlapping requests in order', async () => {
    const pedal = new Pedal(new FakePedal([bytes(10, 1), bytes(20, 2)]));
    const [first, second] = await Promise.all([pedal.downloadPatch(1, 10), pedal.downloadPatch(2, 10)]);
    expect([first.slot, first.data.length, second.slot, second.data.length]).toEqual([1, 10, 2, 20]);
  });
});

describe('Pedal edit buffer', () => {
  it('downloads the patch on the pedal\'s screen', async () => {
    const fake = new FakePedal([bytes(60, 1)]);
    fake.editBuffer = bytes(90, 7);
    const current = await new Pedal(fake).downloadCurrentPatch();

    expect(fake.commands()).toEqual([PATCH_DOWNLOAD_CURRENT]);
    expect(current.checksumOk).toBe(true);
    expect(toHex(current.data)).toBe(toHex(bytes(90, 7)));
  });
});

describe('hasUnsavedEdits', () => {
  const patch = (name: string) => encodePatch({
    name, version: 2, target: 0, effectIds: [], effects: [], chunks: new Map(), reserved: new Uint8Array(6),
  });
  // A slot as the pedal sends it: the patch, then leftovers of other patches.
  const withLeftovers = (data: Uint8Array, seed: number) => Uint8Array.from([...data, ...bytes(40, seed)]);
  const read = (slot: number, data: Uint8Array, checksumOk = true) => ({ slot, data, checksumOk });
  const slots = [read(1, withLeftovers(patch('One'), 3)), read(2, withLeftovers(patch('Two'), 5))];

  it('is false when the screen holds a stored slot, whatever the leftovers', () => {
    const current = { data: withLeftovers(patch('Two'), 9), checksumOk: true };
    expect(hasUnsavedEdits({ slots, current })).toBe(false);
  });

  it('is true when the screen holds a patch no slot holds', () => {
    const current = { data: withLeftovers(patch('Two edited'), 5), checksumOk: true };
    expect(hasUnsavedEdits({ slots, current })).toBe(true);
  });

  it('is true when the copy of the screen is damaged', () => {
    const current = { data: patch('Two'), checksumOk: false };
    expect(hasUnsavedEdits({ slots, current })).toBe(true);
  });

  it('ignores damaged slot copies', () => {
    const current = { data: patch('One'), checksumOk: true };
    expect(hasUnsavedEdits({ slots: [read(1, patch('One'), false)], current })).toBe(true);
  });
});

describe('Pedal writes', () => {
  const patch = encodePatch({
    name: 'Test', version: 2, target: 0, effectIds: [], effects: [], chunks: new Map(), reserved: new Uint8Array(6),
  });
  // 100 slots like the real pedal, 10 per bank; slot 86 has old data and leftovers.
  const pedalSlots = () => Array.from({ length: 100 }, (_, i) => bytes(i === 85 ? 120 : 60, i + 1));
  const lastRead = (slot: number) => pedalSlots()[slot - 1]!;
  const write = (slot: number, data = patch) => ({ slot, patch: data, lastRead: lastRead(slot) });

  it('writes a user slot inside PC mode and reads it back', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    const stored = await new Pedal(fake).writeSlot(86, patch, lastRead(86));

    // Re-read first, then upload and read back.
    expect(fake.commands()).toEqual([PC_MODE_ON, PATCH_CHECK, PATCH_DOWNLOAD, PATCH_UPLOAD, PATCH_DOWNLOAD, PC_MODE_OFF]);
    expect(stored.slot).toBe(86);
    // Sent padded with zeros to the full slot size.
    const expected = new Uint8Array(128);
    expected.set(patch);
    expect(toHex(fake.slots[85]!)).toBe(toHex(expected));
    expect(toHex(stored.data)).toBe(toHex(expected));
    expect(toHex(fake.slots[84]!)).toBe(toHex(pedalSlots()[84]!)); // its neighbour is untouched
  });

  it('refuses factory slots and anything that is not a PTCF patch, sending nothing', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    const pedal = new Pedal(fake);
    await expect(pedal.writeSlot(85, patch, lastRead(85))).rejects.toThrow('Only user slots 86–100');
    await expect(pedal.writeSlot(101, patch, new Uint8Array())).rejects.toThrow('Only user slots 86–100');
    await expect(pedal.writeSlot(86, bytes(40, 3), lastRead(86))).rejects.toThrow('Not a PTCF patch');
    await expect(pedal.writeSlot(86, new Uint8Array(), lastRead(86))).rejects.toThrow('1 to 128 bytes');
    await expect(pedal.writeSlot(86, new Uint8Array(129), lastRead(86))).rejects.toThrow('1 to 128 bytes');
    expect(fake.commands()).not.toContain(PATCH_UPLOAD);
  });

  it('notices when the slot read back holds something else', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    fake.corruptWrites = true;
    await expect(new Pedal(fake).writeSlot(86, patch, lastRead(86))).rejects.toThrow(PedalWriteError);
    expect(fake.commands().at(-1)).toBe(PC_MODE_OFF);
  });

  it('writes several slots in one PC mode session, reporting each one', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    const reported: number[] = [];
    const stored = await new Pedal(fake).writeSlots(
      [write(90), write(86)],
      (read) => reported.push(read.slot),
    );

    expect(fake.commands()).toEqual([
      PC_MODE_ON, PATCH_CHECK, PATCH_DOWNLOAD, PATCH_DOWNLOAD, // both re-read before any upload
      PATCH_UPLOAD, PATCH_DOWNLOAD, PATCH_UPLOAD, PATCH_DOWNLOAD, PC_MODE_OFF,
    ]);
    expect(stored.map((read) => read.slot)).toEqual([90, 86]);
    expect(reported).toEqual([90, 86]);
    expect(toHex(fake.slots[89]!.subarray(0, patch.length))).toBe(toHex(patch));
    expect(toHex(fake.slots[85]!.subarray(0, patch.length))).toBe(toHex(patch));
  });

  it('sends nothing if any write in the list is wrong', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    const pedal = new Pedal(fake);
    await expect(pedal.writeSlots([write(86), write(85)])).rejects.toThrow('Only user slots');
    await expect(pedal.writeSlots([write(86), write(87, bytes(40, 3))])).rejects.toThrow(
      'Not a PTCF patch',
    );
    await expect(pedal.writeSlots([write(86), write(86)])).rejects.toThrow('only be written once');
    expect(fake.commands()).not.toContain(PATCH_UPLOAD);
    expect(toHex(fake.slots[85]!)).toBe(toHex(pedalSlots()[85]!));
  });

  it('writes nothing if a slot changed on the pedal since it was read', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    fake.slots[86] = bytes(60, 99); // slot 87 was edited on the pedal after the read
    await expect(new Pedal(fake).writeSlots([write(86), write(87)])).rejects.toThrow(
      'Slot 87 changed on the pedal since it was read',
    );
    await expect(new Pedal(fake).writeSlot(87, patch, lastRead(87))).rejects.toThrow(SlotChangedError);
    expect(fake.commands()).not.toContain(PATCH_UPLOAD);
    expect(fake.commands().at(-1)).toBe(PC_MODE_OFF);
  });

  it('ignores leftovers after the patch when re-reading', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    const before = new Uint8Array(128);
    before.set(patch);
    const after = before.slice();
    after[120] = 0x55; // the pedal's leftovers changed, the patch didn't
    fake.slots[85] = after;
    await new Pedal(fake).writeSlots([{ slot: 86, patch, lastRead: before }]);
    expect(fake.commands()).toContain(PATCH_UPLOAD);
  });

  it('stops at the first slot that fails, keeping the ones written before', async () => {
    const fake = new FakePedal(pedalSlots(), { patchSize: 128 });
    const reported: number[] = [];
    let uploads = 0;
    const send = fake.send.bind(fake);
    fake.send = (body) => {
      // The second upload gets stored with a byte flipped.
      if (body[3] === PATCH_UPLOAD && ++uploads === 2) {
        fake.corruptWrites = true;
      }
      send(body);
    };
    await expect(
      new Pedal(fake).writeSlots(
        [write(86), write(87), write(88)],
        (read) => reported.push(read.slot),
      ),
    ).rejects.toThrow('Slot 87');

    expect(reported).toEqual([86]);
    expect(fake.commands().filter((command) => command === PATCH_UPLOAD)).toHaveLength(2); // 88 never sent
    expect(fake.commands().at(-1)).toBe(PC_MODE_OFF);
  });
});

describe.skipIf(!hasGolden)('Pedal against golden files', () => {
  it('reads back all the golden dumps', async () => {
    const raws = hasGolden ? loadManifest().patches.map((p) => loadPatch(p.slot).raw) : [];
    const { slots: reads } = await new Pedal(new FakePedal(raws)).readAllSlots();
    expect(reads.map((r) => toHex(r.data))).toEqual(raws.map(toHex));
    expect(reads.every((r) => r.checksumOk)).toBe(true);
  });
});
