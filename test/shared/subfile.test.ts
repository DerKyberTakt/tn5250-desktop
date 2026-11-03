import { describe, expect, it } from 'vitest';
import { detectSubfiles } from '../../src/shared/screenText';
import type { ScreenSnapshot } from '../../src/shared/protocol';

/** A 24x80 screen from row strings; '~' before a word underlines the rest of the row (an attribute cell). */
function screen(rows: Record<number, string>): Pick<ScreenSnapshot, 'rows' | 'cols' | 'text' | 'attrs'> {
  const cols = 80;
  let text = '';
  const attrs = new Array<number>(24 * cols).fill(0);
  for (let r = 0; r < 24; r++) {
    let line = rows[r] ?? '';
    const u = line.indexOf('~');
    if (u >= 0) {
      attrs[r * cols + u] = 0x24; // underline
      line = line.slice(0, u) + ' ' + line.slice(u + 1);
    }
    text += line.padEnd(cols, ' ').slice(0, cols);
  }
  return { rows: 24, cols, text, attrs };
}

describe('subfile detection for the synthetic scroll bar', () => {
  it('finds a subfile under an underlined heading ended by More...', () => {
    const s = screen({
      2: 'Work with Items',
      4: 'Type options, press Enter.',
      6: '~Opt  Item     Description',
      7: '     107618   CHICKEN NUGGET',
      8: '     107619   CHICKEN NUGGET SAFARI',
      9: '     107944   CHICKEN NUGGET ULTIMATE',
      10: '                                                                         More...',
      12: 'F3=Exit   F12=Cancel',
    });
    expect(detectSubfiles(s)).toEqual([{ top: 7, bottom: 10, end: 'more', col: 73 }]);
  });

  it('Bottom marks the last page; a blank row bounds the block when there is no heading', () => {
    const s = screen({
      5: '     1   first',
      6: '     2   second',
      7: '                                                                          Bottom',
      9: 'F3=Exit',
    });
    expect(detectSubfiles(s)).toEqual([{ top: 5, bottom: 7, end: 'bottom', col: 74 }]);
  });

  it('a plus sign counts, text in the middle of a row does not, and nothing above the marker means no subfile', () => {
    expect(detectSubfiles(screen({ 3: '   a', 4: '   b', 5: '                                                                               +' }))).toEqual([
      { top: 3, bottom: 5, end: 'more', col: 79 },
    ]);
    expect(detectSubfiles(screen({ 3: '   a', 4: '   b', 5: '   More... of this later' }))).toEqual([]);
    expect(detectSubfiles(screen({ 5: '                                                                         More...' }))).toEqual([]);
  });
});
