import { describe, expect, it } from 'vitest';
import { CodePage, UNPRINTABLE } from '../../src/engine/codepage';

describe('CodePage 870 and 1153 (Latin-2, issue #16)', () => {
  it('decodes and encodes the Czech letters on 870', () => {
    const cp = CodePage.get(870);
    for (const ch of 'ěščřžůťĚŠČŘŽŮŤáéíóúýÁÉÍÓÚÝ') {
      expect(cp.decode(cp.encode(ch))).toBe(ch);
    }
    // IBM 870 positions (the Latin-2 letters sit where 037 has accented Latin-1 ones).
    expect(cp.decode(0x54)).toBe('ů');
    expect(cp.decode(0x52)).toBe('ę');
    expect(cp.decode(0x57)).toBe('ľ');
    expect(cp.decode(0xdf)).toBe('ě');
    expect(cp.decode(0x9c)).toBe('š');
    expect(cp.decode(0x47)).toBe('č');
    expect(cp.decode(0x9f)).toBe('¤');
    expect(cp.decode(0xc1)).toBe('A');
    expect(cp.decode(0x5b)).toBe('$');
  });

  it('1153 is 870 with the euro sign at X9F', () => {
    const a = CodePage.get(870);
    const b = CodePage.get(1153);
    expect(b.decode(0x9f)).toBe('€');
    expect(b.encode('€')).toBe(0x9f);
    for (let i = 0x40; i < 0x100; i++) {
      if (i !== 0x9f) expect(b.decode(i)).toBe(a.decode(i));
    }
  });

  it('offers the national pages the NEW-ENVIRON table names', () => {
    const have = CodePage.supported();
    for (const c of [277, 278, 280, 284, 285, 297, 870, 871, 875, 1025, 1026, 1153]) expect(have).toContain(c);
    expect(CodePage.get(285).decode(0x5b)).toBe('£');
    expect(CodePage.get(1025).decode(0xc1)).toBe('A');
    expect(CodePage.get(875).decode(0x81)).toBe('a');
  });
});

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
