import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { Field, Screen } from '../../src/engine/screen';

const cp = CodePage.get(37);

function fillRow(s: Screen, row: number, text: string): void {
  s.buffer.set(cp.encodeString(text), row * s.cols);
}

describe('Screen', () => {
  it('rolls a region up and down, blanking vacated rows', () => {
    const s = new Screen();
    fillRow(s, 5, 'five');
    fillRow(s, 6, 'six');
    fillRow(s, 7, 'seven');
    s.roll(1, 5, 7);
    expect(s.rowText(5, cp).trimEnd()).toBe('six');
    expect(s.rowText(6, cp).trimEnd()).toBe('seven');
    expect(s.rowText(7, cp).trim()).toBe('');
    s.roll(-2, 5, 7);
    expect(s.rowText(5, cp).trim()).toBe('');
    expect(s.rowText(6, cp).trim()).toBe('');
    expect(s.rowText(7, cp).trimEnd()).toBe('six');
  });

  it('finds the attribute in effect for an address', () => {
    const s = new Screen();
    expect(s.attributeAt(100)).toBe(0x20);
    s.buffer[50] = 0x22;
    s.buffer[200] = 0x28;
    expect(s.attributeAt(49)).toBe(0x20);
    expect(s.attributeAt(50)).toBe(0x22);
    expect(s.attributeAt(199)).toBe(0x22);
    expect(s.attributeAt(200)).toBe(0x28);
  });

  it('keeps fields in screen order and replaces redefinitions', () => {
    const s = new Screen();
    s.addField(new Field(300, 10, 0x4000, [], 0x20));
    s.addField(new Field(100, 5, 0x4000, [], 0x20));
    s.addField(new Field(300, 12, 0x4800, [], 0x24));
    expect(s.fields.map((f) => [f.start, f.length])).toEqual([
      [100, 5],
      [300, 12],
    ]);
    expect(s.fields[1]?.mdt).toBe(true);
    expect(s.fieldAt(305)?.start).toBe(300);
    expect(s.fieldAt(312)).toBeUndefined();
  });

  it('decodes field format words', () => {
    const f = new Field(0, 8, 0x4000 | 0x2000 | 0x0700 | 0x0080 | 0x0005, [], 0x20);
    expect(f.bypass).toBe(true);
    expect(f.shift).toBe('signedNumeric');
    expect(f.autoEnter).toBe(true);
    expect(f.adjust).toBe('rightZero');
    expect(f.numeric).toBe(true);
    const g = new Field(0, 8, 0x4000 | 0x0300 | 0x0006, [], 0x20);
    expect(g.shift).toBe('numericOnly');
    expect(g.adjust).toBe('rightBlank');
    expect(g.bypass).toBe(false);
  });

  it('produces a snapshot with attribute positions blanked', () => {
    const s = new Screen();
    s.buffer[0] = 0x22;
    s.buffer.set(cp.encodeString('Hi'), 1);
    s.cursor = s.addr(2, 3);
    s.addField(new Field(10, 4, 0x4000, [], 0x24));
    const snap = s.toSnapshot(cp);
    expect(snap.text.slice(0, 3)).toBe(' Hi');
    expect(snap.text.charAt(3)).toBe('\u0000'); // null cell, never a space
    expect(snap.attrs[0]).toBe(0x22);
    expect(snap.attrs[1]).toBe(0);
    expect(snap.fields).toEqual([{ start: 10, length: 4, bypass: false }]);
    expect(snap.cursor).toEqual({ row: 2, col: 3 });
  });
});
