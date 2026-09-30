import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs TypeScript tests', () => {
    const bytes = new Uint8Array([0xf0, 0x52, 0xf7]);
    expect(bytes[0]).toBe(0xf0);
    expect(bytes.at(-1)).toBe(0xf7);
  });
});
