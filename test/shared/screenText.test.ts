import { describe, expect, it } from 'vitest';
import { expandTabs, fieldRanges, hotspotAt, markedFieldRanges, keyLabelsIn, urlAt, urlsIn, wordAt } from '../../src/shared/screenText';
import { SETTINGS_DEFAULTS, buildTitle, diffSettings, resolveSettings } from '../../src/shared/settings';

describe('fieldRanges', () => {
  it('splits wrapping fields into per-row runs', () => {
    const r = fieldRanges({ rows: 3, cols: 10, fields: [{ start: 7, length: 6, bypass: false }, { start: 20, length: 3, bypass: true }] });
    expect(r).toEqual([
      { row: 0, col: 7, length: 3, fieldIndex: 0, bypass: false },
      { row: 1, col: 0, length: 3, fieldIndex: 0, bypass: false },
      { row: 2, col: 0, length: 3, fieldIndex: 1, bypass: true },
    ]);
  });
});

describe('markedFieldRanges', () => {
  const attrs = (cells: Record<number, number>): number[] => {
    const a = new Array<number>(40).fill(0);
    for (const [i, v] of Object.entries(cells)) a[Number(i)] = v;
    return a;
  };

  it('ends the box where a plain attribute inside the field ends the underline', () => {
    // Underlined field 1..30, plain attribute at cell 5 (data length 4).
    const r = markedFieldRanges({ rows: 2, cols: 20, fields: [{ start: 1, length: 30, bypass: false }], attrs: attrs({ 0: 0x24, 5: 0x20 }) });
    expect(r).toEqual([{ row: 0, col: 1, length: 4, fieldIndex: 0, bypass: false }]);
  });

  it('keeps the whole field when nothing inside changes the attribute', () => {
    const r = markedFieldRanges({ rows: 2, cols: 20, fields: [{ start: 1, length: 6, bypass: false }], attrs: attrs({ 0: 0x24, 7: 0x20 }) });
    expect(r).toEqual([{ row: 0, col: 1, length: 6, fieldIndex: 0, bypass: false }]);
  });

  it('keeps unmarked fields whole (nondisplay password, plain)', () => {
    const r = markedFieldRanges({
      rows: 2,
      cols: 20,
      fields: [
        { start: 1, length: 10, bypass: false },
        { start: 22, length: 5, bypass: false },
      ],
      attrs: attrs({ 0: 0x27, 21: 0x20 }),
    });
    expect(r.map((x) => [x.col, x.length])).toEqual([
      [1, 10],
      [2, 5],
    ]);
  });

  it('follows a reverse-image field and continues across a colour change', () => {
    const r = markedFieldRanges({ rows: 1, cols: 40, fields: [{ start: 1, length: 12, bypass: false }], attrs: attrs({ 0: 0x21, 6: 0x2c, 10: 0x20 }) });
    expect(r.map((x) => [x.col, x.length])).toEqual([[1, 9]]);
  });
});

describe('hotspots and urls', () => {
  const all = { pf: true, fp: true, f: true, number: true };
  it('classifies function keys and menu numbers', () => {
    expect(hotspotAt('F3=Exit   F12=Cancel', 1, all)).toEqual({ kind: 'key', action: 'pf3', start: 0, length: 2 });
    expect(hotspotAt('F3=Exit   F12=Cancel', 12, all)).toEqual({ kind: 'key', action: 'pf12', start: 10, length: 3 });
    expect(hotspotAt('PF24 Help', 2, all)?.kind).toBe('key');
    expect(hotspotAt(' 15. Item Allocation', 2, all)).toEqual({ kind: 'option', text: '15', start: 1, length: 3 });
    expect(hotspotAt('F3=Exit', 1, { ...all, f: false })).toBeUndefined();
    expect(hotspotAt('F99=Nope', 1, all)).toBeUndefined();
    expect(hotspotAt('hello', 2, all)).toBeUndefined();
  });

  it('finds URLs and strips trailing punctuation', () => {
    const line = 'See https://pub400.com/news, and http://x.y/z.';
    expect(urlsIn(line).map((u) => u.url)).toEqual(['https://pub400.com/news', 'http://x.y/z']);
    expect(urlAt(line, 10)).toBe('https://pub400.com/news');
    expect(urlAt(line, 0)).toBeUndefined();
  });

  it('lists function-key labels for 3-D buttons', () => {
    expect(keyLabelsIn(' F3=Exit   F5=Operator  PF12=Cancel').map((k) => [k.start, k.action])).toEqual([
      [1, 'pf3'],
      [11, 'pf5'],
      [24, 'pf12'],
    ]);
    expect(wordAt('ab cd', 3)).toEqual({ text: 'cd', start: 3 });
  });
});

describe('expandTabs', () => {
  it('replaces, advances or pads tabs', () => {
    expect(expandTabs('a\tb', { tabMode: 'spaces', tabSpaces: 2, tabColumns: 4 })).toEqual([{ text: 'a  b' }]);
    expect(expandTabs('a\tb', { tabMode: 'nextField', tabSpaces: 1, tabColumns: 4 })).toEqual([{ text: 'a' }, { action: 'tab' }, { text: 'b' }]);
    expect(expandTabs('ab\tc', { tabMode: 'tabStop', tabSpaces: 1, tabColumns: 4 })).toEqual([{ text: 'ab  c' }]);
  });
});

describe('titles and new settings', () => {
  it('builds ACS-style window titles', () => {
    const s = { ...SETTINGS_DEFAULTS, name: 'Prod', host: 'h', deviceName: 'OD1NA0', titleParts: ['sessionId', 'name', 'deviceName', 'dimensions'] as const };
    expect(buildTitle({ ...s, titleParts: [...s.titleParts] }, 'A')).toBe('A - Prod - OD1NA0 - [24x80]'.slice(0, 24) + '…');
    expect(buildTitle({ ...SETTINGS_DEFAULTS, host: 'h', titleMaxLength: 0 }, 'B')).toBe('B - h');
  });

  it('round-trips array settings through diff and resolve', () => {
    const d = SETTINGS_DEFAULTS;
    const v = resolveSettings(d, { host: 'x', titleParts: ['host'], uiMode: 'enhanced' });
    const diff = diffSettings(d, v);
    expect(diff.titleParts).toEqual(['host']);
    expect(diff.uiMode).toBe('enhanced');
    expect(diff.enhancedPadding).toBeUndefined();
  });
});
