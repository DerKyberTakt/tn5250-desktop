import { describe, expect, it } from 'vitest';
import { decodeAttribute, isAttribute } from '../../src/engine/attributes';

type Expected = Partial<ReturnType<typeof decodeAttribute>>;

describe('decodeAttribute', () => {
  const cases: Array<[number, string, Expected]> = [
    [0x20, 'green', { color: 'green', reverse: false, underline: false, blink: false, columnSeparators: false, nondisplay: false }],
    [0x21, 'green reverse', { color: 'green', reverse: true }],
    [0x22, 'white', { color: 'white' }],
    [0x23, 'white reverse', { color: 'white', reverse: true }],
    [0x24, 'green underline', { color: 'green', underline: true }],
    [0x25, 'green underline reverse', { color: 'green', underline: true, reverse: true }],
    [0x26, 'white underline', { color: 'white', underline: true }],
    [0x27, 'nondisplay', { nondisplay: true }],
    [0x28, 'red', { color: 'red', blink: false }],
    [0x29, 'red reverse', { color: 'red', reverse: true }],
    [0x2a, 'red blink', { color: 'red', blink: true }],
    [0x2b, 'red reverse blink', { color: 'red', reverse: true, blink: true }],
    [0x2c, 'red underline', { color: 'red', underline: true }],
    [0x2d, 'red underline reverse', { color: 'red', underline: true, reverse: true }],
    [0x2e, 'red underline blink', { color: 'red', underline: true, blink: true }],
    [0x2f, 'nondisplay', { nondisplay: true }],
    [0x30, 'turquoise column separators', { color: 'turquoise', columnSeparators: true }],
    [0x31, 'turquoise reverse', { color: 'turquoise', reverse: true, columnSeparators: true }],
    [0x32, 'yellow', { color: 'yellow', columnSeparators: true }],
    [0x33, 'yellow reverse', { color: 'yellow', reverse: true }],
    [0x34, 'turquoise underline', { color: 'turquoise', underline: true }],
    [0x35, 'turquoise underline reverse', { color: 'turquoise', underline: true, reverse: true }],
    [0x36, 'yellow underline', { color: 'yellow', underline: true }],
    [0x37, 'nondisplay', { nondisplay: true }],
    [0x38, 'pink', { color: 'pink' }],
    [0x39, 'pink reverse', { color: 'pink', reverse: true }],
    [0x3a, 'blue', { color: 'blue' }],
    [0x3b, 'blue reverse', { color: 'blue', reverse: true }],
    [0x3c, 'pink underline', { color: 'pink', underline: true }],
    [0x3d, 'pink underline reverse', { color: 'pink', underline: true, reverse: true }],
    [0x3e, 'blue underline', { color: 'blue', underline: true }],
    [0x3f, 'nondisplay', { nondisplay: true }],
  ];

  it.each(cases)('0x%s decodes as %s', (attr, _label, expected) => {
    expect(decodeAttribute(attr)).toMatchObject(expected);
  });

  it('rejects bytes outside 0x20..0x3F', () => {
    expect(() => decodeAttribute(0x1f)).toThrow(RangeError);
    expect(() => decodeAttribute(0x40)).toThrow(RangeError);
  });

  it('isAttribute covers exactly 0x20..0x3F', () => {
    expect(isAttribute(0x1f)).toBe(false);
    expect(isAttribute(0x20)).toBe(true);
    expect(isAttribute(0x3f)).toBe(true);
    expect(isAttribute(0x40)).toBe(false);
  });
});
