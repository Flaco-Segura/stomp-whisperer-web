import { describe, expect, it } from 'vitest';

import { Pedal, PedalTimeoutError, decodePatchReply } from '../src/pedal';
import * as protocol from '../src/protocol';
import { FakePedal } from './fake-pedal';
import { hasGolden, loadManifest, loadPatch, toHex } from './golden';

const PC_MODE_ON = 0x52;
const PC_MODE_OFF = 0x53;
const PATCH_CHECK = 0x44;
const PATCH_DOWNLOAD = 0x46;

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
  it('reads every slot inside PC mode', async () => {
    const slots = [bytes(50, 3), new Uint8Array(), bytes(80, 5)];
    const fake = new FakePedal(slots, { bankSize: 2 });
    const pedal = new Pedal(fake);
    const progress: number[] = [];

    const reads = await pedal.readAllSlots((read, info) => {
      expect(info).toEqual({ count: 3, patchSize: 1024, bankSize: 2 });
      progress.push(read.slot);
    });

    expect(progress).toEqual([1, 2, 3]);
    expect(reads.map((r) => toHex(r.data))).toEqual(slots.map(toHex));
    expect(reads.every((r) => r.checksumOk)).toBe(true);
    expect(fake.commands()).toEqual([
      PC_MODE_ON, PATCH_CHECK, PATCH_DOWNLOAD, PATCH_DOWNLOAD, PATCH_DOWNLOAD, PC_MODE_OFF,
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

describe.skipIf(!hasGolden)('Pedal against golden files', () => {
  it('reads back all the golden dumps', async () => {
    const raws = hasGolden ? loadManifest().patches.map((p) => loadPatch(p.slot).raw) : [];
    const reads = await new Pedal(new FakePedal(raws)).readAllSlots();
    expect(reads.map((r) => toHex(r.data))).toEqual(raws.map(toHex));
    expect(reads.every((r) => r.checksumOk)).toBe(true);
  });
});
