import { describe, expect, it } from 'vitest';

import { EffectFormatError, type Param, displayParam, parseEffectFile, parseEffectIndex } from '../src/effects';

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const zeros = (count: number) => new Uint8Array(count);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function padTo(bytes: Uint8Array, length: number): Uint8Array {
  return concat(bytes, zeros(length - bytes.length));
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

// Same layout as struct.pack("<12sx4sxBI3x", name, b"1.10", 1, effect_id).
const entry = (name: string, effectId: number) =>
  concat(padTo(ascii(name), 12), zeros(1), ascii('1.10'), zeros(1), Uint8Array.of(1), uint32(effectId), zeros(3));

function group(id: number, entries: [string, number][]): Uint8Array {
  return concat(
    ascii('>>>\0'), Uint8Array.of(id), zeros(21),
    ...entries.map(([name, effectId]) => entry(name, effectId)),
    ascii('<<<\0'), Uint8Array.of(id), zeros(21),
  );
}

function index(...groups: Uint8Array[]): Uint8Array {
  const header = concat(
    ascii('>>>\0'), zeros(22), padTo(ascii('BLANK.ZD2'), 12), zeros(6), Uint8Array.of(1),
    zeros(7), ascii('<<<\0'), zeros(22),
  );
  return concat(header, ...groups);
}

const chunk = (tag: string, payload: Uint8Array) => concat(ascii(tag), uint32(payload.length), payload);

function zd2(effectId: number, name: string, groupName: string, params: object[] | string | null): Uint8Array {
  const head = concat(ascii('ZDLF'), zeros(92), uint32(effectId), padTo(ascii(name), 11), padTo(ascii(groupName), 11), zeros(6));
  const prme = Array.isArray(params) ? JSON.stringify({ Parameters: params }) : params;
  return concat(
    head,
    chunk('ICON', Uint8Array.of(1, 2)),
    chunk('TXE1', ascii('Warm drive.\0')),
    chunk('DATA', new Uint8Array(40).fill(0xff)),
    prme === null ? zeros(0) : chunk('PRME', ascii(`${prme}\0`)),
  );
}

const param = (name: string, explanation = ''): Param => ({ name, explanation, max: null, default: null, labels: null });

describe('parseEffectIndex', () => {
  it('maps effect ids to file names', () => {
    const data = index(
      group(1, [['COMP.ZD2', 0x01000010]]),
      group(3, [['DYNDRIVE.ZD2', 0x03000080], ['TS_DRIVE.ZD2', 0x03000030]]),
    );
    expect(parseEffectIndex(data)).toEqual(
      new Map([[0x01000010, 'COMP.ZD2'], [0x03000080, 'DYNDRIVE.ZD2'], [0x03000030, 'TS_DRIVE.ZD2']]),
    );
  });

  it('rejects an index without effects', () => {
    expect(() => parseEffectIndex(index())).toThrow(EffectFormatError);
  });
});

describe('parseEffectFile', () => {
  it('reads id, name, group, description and parameters', () => {
    const params = [{ name: 'Gain', explanation: 'Adjusts the gain.' }, { name: 'VOL' }];
    const info = parseEffectFile(zd2(0x03000080, 'DYN Drive', 'DRIVE', params), 'DYNDRIVE.ZD2');
    expect(info).toEqual({
      id: 0x03000080,
      file: 'DYNDRIVE.ZD2',
      name: 'DYN Drive',
      group: 'DRIVE',
      description: 'Warm drive.',
      params: [param('Gain', 'Adjusts the gain.'), param('VOL')],
    });
  });

  it('tolerates a trailing comma in the parameter list', () => {
    const data = zd2(0x04000111, 'KRAMPUS', 'PREAMP', '{"Parameters":[{"name":"Gain"},\r\n  ]\r\n}');
    expect(parseEffectFile(data).params).toEqual([param('Gain')]);
  });

  it('keeps the name when the parameter list is unreadable', () => {
    const info = parseEffectFile(zd2(0x04000111, 'KRAMPUS', 'PREAMP', '{"Parameters":[{name:Gain}]}'));
    expect([info.name, info.params]).toEqual(['KRAMPUS', []]);
  });

  it('reads an eleven-character name without terminator', () => {
    const info = parseEffectFile(zd2(0x09000010, 'HD Hall Rev', 'REVERB', null));
    expect([info.name, info.params]).toEqual(['HD Hall Rev', []]);
  });

  it('rejects data that is not a ZD2 file', () => {
    expect(() => parseEffectFile(zeros(200))).toThrow(EffectFormatError);
  });
});

it('displayParam uses the labels when known', () => {
  const mode: Param = { ...param('Mode'), max: 1, labels: ['COMBO', 'STACK'] };
  expect([displayParam(mode, 1), displayParam(param('Gain'), 64)]).toEqual(['STACK', '64']);
});
