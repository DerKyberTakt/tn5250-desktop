import type { ScreenSnapshot } from '../shared/protocol';
import { ATTR_NORMAL } from './attributes';

/**
 * Builds the screen shown while no session is connected. It doubles as a
 * rendering self-test: every colour and decoration appears once.
 */
export function buildDemoScreen(rows: number, cols: number): ScreenSnapshot {
  const text: string[] = Array.from({ length: rows * cols }, () => ' ');
  const attrs: number[] = new Array<number>(rows * cols).fill(0);

  const put = (row: number, col: number, s: string, attr?: number): void => {
    let c = col;
    if (attr !== undefined) {
      attrs[row * cols + c] = attr;
      c += 1;
    }
    for (const ch of s) {
      if (c >= cols) break;
      text[row * cols + c] = ch;
      c += 1;
    }
  };

  const center = (s: string): number => Math.max(0, Math.floor((cols - s.length) / 2));

  const title = 'TN5250 Terminal for IBM i';
  put(1, center(title) - 1, title, 0x22);
  const sub = `${rows} x ${cols}   not connected`;
  put(3, center(sub) - 1, sub, ATTR_NORMAL);

  const samples: Array<[string, number]> = [
    ['green 20', 0x20],
    ['white 22', 0x22],
    ['red 28', 0x28],
    ['turquoise 30', 0x30],
    ['yellow 32', 0x32],
    ['pink 38', 0x38],
    ['blue 3A', 0x3a],
    ['green reverse 21', 0x21],
    ['green underline 24', 0x24],
    ['white underline 26', 0x26],
    ['red blink 2A', 0x2a],
    ['red reverse 29', 0x29],
    ['turquoise underline 34', 0x34],
    ['yellow reverse 33', 0x33],
    ['blue underline 3E', 0x3e],
    ['nondisplay 27', 0x27],
  ];
  let row = 6;
  let col = 2;
  const colWidth = Math.floor((cols - 4) / 2);
  for (const [label, attr] of samples) {
    put(row, col, label, attr);
    put(row, col + label.length + 2, ' ', ATTR_NORMAL);
    if (col + colWidth * 2 <= cols - 2) {
      col += colWidth;
    } else {
      col = 2;
      row += 1;
    }
  }

  const hint = 'Command palette: TN5250: New Session';
  put(rows - 3, center(hint) - 1, hint, 0x30);

  // Column ruler on the last row: a digit every 10 columns.
  const ruler = Array.from({ length: cols }, (_, i) =>
    (i + 1) % 10 === 0 ? String(((i + 1) / 10) % 10) : '.',
  ).join('');
  put(rows - 1, 0, ruler.slice(0, cols - 1), 0x3a);

  return {
    rows,
    cols,
    text: text.join(''),
    fields: [],
    attrs,
    cursor: { row: 3, col: center(sub) },
  };
}
