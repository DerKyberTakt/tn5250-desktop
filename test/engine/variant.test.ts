import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { VARIANT_BYTES, variantChars } from '../../src/engine/variant';

const cp37 = CodePage.get(37);
const cp273 = CodePage.get(273);

describe('variant characters (issue #5: ! typed under code page 37 reaches a 273 host as Ü)', () => {
  it('knows the bytes that differ between code pages', () => {
    expect(VARIANT_BYTES.has(0x5a)).toBe(true); // ! in 37, Ü in 273, ] in 500
    expect(VARIANT_BYTES.has(0x7c)).toBe(true); // @ in 37, Ö in 273
    expect(VARIANT_BYTES.has(0x4f)).toBe(true); // | in 37, ! in 273
    expect(VARIANT_BYTES.has(0x7b)).toBe(true); // # in 37, Æ in 1142
    expect(VARIANT_BYTES.has(0x81)).toBe(false); // a
    expect(VARIANT_BYTES.has(0xf1)).toBe(false); // 1
    expect(VARIANT_BYTES.has(0x4b)).toBe(false); // .
    expect(VARIANT_BYTES.has(0x40)).toBe(false); // blank
  });

  it('lists the variant characters of a password as typed, once each, in order', () => {
    expect(variantChars(cp37.encodeString('pa!s@w!rd'), cp37)).toEqual(['!', '@']);
    expect(variantChars(cp37.encodeString('Passw0rd.'), cp37)).toEqual([]);
    expect(variantChars(cp37.encodeString('a[b]{c}|d\\e^f~g'), cp37)).toEqual(['[', ']', '{', '}', '|', '\\', '^', '~']);
  });

  it('decodes with the session code page: ! under 273 is a variant too', () => {
    expect(variantChars(cp273.encodeString('ge!heim'), cp273)).toEqual(['!']);
    expect(cp273.encodeString('!')[0]).toBe(0x4f);
    expect(cp273.decode(0x5a)).toBe('Ü');
  });

  it('skips nulls and blanks (an untyped rest of the field) and caps the list', () => {
    const bytes = Uint8Array.from([0x00, 0x00, 0x5a, 0x40, 0x00]);
    expect(variantChars(bytes, cp37)).toEqual(['!']);
    expect(variantChars(cp37.encodeString('!@#$[]{}|\\^~'), cp37, 3)).toEqual(['!', '@', '#']);
  });
});
