import { describe, expect, it } from 'vitest';
import { CodePage, UNPRINTABLE } from '../../src/engine/codepage';

describe('CodePage 037', () => {
  const cp = CodePage.get(37);

  it('decodes common EBCDIC bytes', () => {
    expect(cp.decode(0xc1)).toBe('A');
    expect(cp.decode(0x81)).toBe('a');
    expect(cp.decode(0xf0)).toBe('0');
    expect(cp.decode(0x40)).toBe(' ');
    expect(cp.decode(0x4b)).toBe('.');
    expect(cp.decode(0x5b)).toBe('$');
    expect(cp.decode(0x7c)).toBe('@');
  });

  it('decodes nulls and the attribute range as blanks', () => {
    expect(cp.decode(0x00)).toBe(' ');
    expect(cp.decode(0x20)).toBe(' ');
    expect(cp.decode(0x3f)).toBe(' ');
  });

  it('shows control bytes written as data as a box, like ACS (report data with bad conversions)', () => {
    expect(cp.decode(0x01)).toBe(UNPRINTABLE);
    expect(cp.decode(0x1f)).toBe(UNPRINTABLE);
    expect(cp.decode(0xff)).toBe(UNPRINTABLE);
    expect(CodePage.get(273).decode(0x15)).toBe(UNPRINTABLE);
    expect(cp.decodeBytes(Uint8Array.from([0xc2, 0x81, 0x1a, 0xa2]))).toBe(`Ba${UNPRINTABLE}s`);
    // Printable non-ASCII stays itself.
    expect(cp.decode(0x51)).toBe('\u00e9');
    expect(cp.decode(0x41)).toBe('\u00a0');
  });

  it('encodes and round-trips printable ASCII', () => {
    expect(cp.encode('A')).toBe(0xc1);
    expect(cp.encode('0')).toBe(0xf0);
    expect(cp.encode(' ')).toBe(0x40);
    for (let c = 0x20; c < 0x7f; c++) {
      const ch = String.fromCharCode(c);
      expect(cp.decode(cp.encode(ch))).toBe(ch);
    }
  });

  it('substitutes unmapped characters', () => {
    expect(cp.encode('中')).toBe(0x6f);
  });

  it('lists supported code pages', () => {
    expect(CodePage.supported()).toContain(37);
    expect(CodePage.supported()).toContain(500);
    expect(() => CodePage.get(12345)).toThrow(RangeError);
  });
});
