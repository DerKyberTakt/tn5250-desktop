import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';

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

  it('decodes nulls and controls as blanks', () => {
    expect(cp.decode(0x00)).toBe(' ');
    expect(cp.decode(0x1f)).toBe(' ');
    expect(cp.decode(0x3f)).toBe(' ');
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
