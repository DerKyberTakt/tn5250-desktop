import { describe, expect, it } from 'vitest';
import { inferTextWindows } from '../../src/shared/textWindows';
import type { ScreenSnapshot } from '../../src/shared/protocol';

type Shot = Pick<ScreenSnapshot, 'rows' | 'cols' | 'text' | 'attrs' | 'gui'>;

/** A screen from row strings; '@' is an attribute cell (blank on screen). */
function screen(rows: number, cols: number, lines: Record<number, string>, gui?: Shot['gui']): Shot {
  let text = '';
  const attrs = new Array<number>(rows * cols).fill(0);
  for (let r = 0; r < rows; r++) {
    const line = (lines[r] ?? '').padEnd(cols, ' ').slice(0, cols);
    for (let c = 0; c < cols; c++) {
      if (line[c] === '@') attrs[r * cols + c] = 0x3b;
    }
    text += line.replace(/@/g, ' ');
  }
  const shot: Shot = { rows, cols, text, attrs };
  if (gui) shot.gui = gui;
  return shot;
}

describe('windows drawn with border characters', () => {
  it('finds a DDS default border (dots and colons) and reports the GUI window rectangle', () => {
    const s = screen(24, 80, {
      5: '          @..............@',
      6: '          @:@ Confirm  @:@',
      7: '          @:@ Y=Yes    @:@',
      8: '          @:@          @:@',
      9: '          @..............@',
    });
    expect(inferTextWindows(s)).toEqual([{ row: 5, col: 10, rows: 5, cols: 16 }]);
  });

  it('finds a window flush with the right edge of a 27x132 screen, underscores and bars, no trailing attribute', () => {
    const lines: Record<number, string> = { 0: '@' + '_'.repeat(131) };
    for (let r = 1; r <= 25; r++) lines[r] = '@|@' + ' '.repeat(127) + '@|';
    lines[26] = '@|' + '_'.repeat(129) + '|';
    const s = screen(27, 132, lines);
    expect(inferTextWindows(s)).toEqual([{ row: 0, col: 0, rows: 27, cols: 133 }]);
  });

  it('lifts a title out of the top border and a footer out of the bottom one', () => {
    const s = screen(24, 80, {
      3: '  @.......... Item Detail ..........@',
      4: '  @:@' + ' '.repeat(29) + '@:@',
      5: '  @:@' + ' '.repeat(29) + '@:@',
      6: '  @.' + '.'.repeat(21) + 'F12=Cancel' + '.@',
    });
    expect(inferTextWindows(s)).toEqual([
      { row: 3, col: 2, rows: 4, cols: 35, title: { text: 'Item Detail', align: 'center' }, footer: { text: 'F12=Cancel', align: 'right' } },
    ]);
  });

  it('finds a window inside another window', () => {
    const lines: Record<number, string> = { 2: '@' + '_'.repeat(70) + '@' };
    for (let r = 3; r <= 14; r++) lines[r] = '@|@' + ' '.repeat(66) + '@|@';
    lines[15] = '@|' + '_'.repeat(68) + '|@';
    lines[6] = '@|@   @..........@' + ' '.repeat(51) + '@|@';
    lines[7] = '@|@   @:@ Hi   @:@' + ' '.repeat(51) + '@|@';
    lines[8] = '@|@   @..........@' + ' '.repeat(51) + '@|@';
    const s = screen(24, 80, lines);
    expect(inferTextWindows(s).map((w) => [w.row, w.col, w.rows, w.cols])).toEqual([
      [2, 0, 14, 72],
      [6, 6, 3, 12],
    ]);
  });

  it('ignores rules without sides, text rows, and the windows the host already created', () => {
    const s = screen(24, 80, {
      1: '@Work with Items',
      2: '@---------------------@',
      3: '@Opt  Item            @',
      4: '@---------------------@',
      10: '  @..............@',
      11: '  @:@ Confirm  @:@',
      12: '  @..............@',
    }, { windows: [{ row: 10, col: 2, rows: 3, cols: 16 }], scrollBars: [], selections: [] });
    expect(inferTextWindows(s)).toEqual([]);
  });
});
