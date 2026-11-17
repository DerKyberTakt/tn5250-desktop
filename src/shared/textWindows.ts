import type { ScreenSnapshot, SnapshotWindow } from './protocol';

/**
 * Windows the host drew with border characters instead of a Create Window structured
 * field. IBM i sends a DDS WINDOW as plain text when its WDWBORDER names characters or a
 * display attribute (vendor screens often do); the layout is still the one of a GUI window
 * on a character display: an attribute, the left border character, an attribute, the
 * content, an attribute, the right border character, between a top row and a bottom row of
 * one repeated character. The enhanced renderer frames these like the host's own windows.
 */

type Shot = Pick<ScreenSnapshot, 'rows' | 'cols' | 'text' | 'attrs' | 'gui'>;

const NULL = '\u0000';

interface Edge {
  /** The repeated border character of the row. */
  ch: string;
  /** Text written over the border, as a window title or footer is. */
  text?: SnapshotWindow['title'];
}

/** The top or bottom row between its corner characters: the border character and any text over it. */
function edge(text: string, from: number, to: number): Edge | undefined {
  const counts = new Map<string, number>();
  for (let i = from; i <= to; i++) {
    const c = text[i] ?? NULL;
    if (c === NULL || c === ' ') continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let ch = '';
  let best = 0;
  for (const [c, n] of counts) if (n > best) [ch, best] = [c, n];
  const len = to - from + 1;
  if (!ch || /[\p{L}\p{N}]/u.test(ch) || best * 2 < len) return undefined;
  let first = -1;
  let last = -1;
  for (let i = from; i <= to; i++) {
    const c = text[i] ?? NULL;
    if (c === ch || c === NULL || c === ' ') continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return { ch };
  const label = text.slice(first, last + 1).trim();
  const align = first - from <= 1 ? 'left' : to - last <= 1 ? 'right' : 'center';
  return { ch, text: label ? { text: label, align } : undefined };
}

export function inferTextWindows(s: Shot): SnapshotWindow[] {
  const { rows, cols, text, attrs } = s;
  const known = new Set((s.gui?.windows ?? []).map((w) => w.row * cols + w.col));
  const out: SnapshotWindow[] = [];
  const isAttr = (i: number): boolean => (attrs[i] ?? 0) !== 0;
  const isChar = (i: number): boolean => {
    const c = text[i];
    return c !== undefined && c !== NULL && c !== ' ' && !isAttr(i);
  };
  for (let r0 = 0; r0 + 2 < rows; r0++) {
    const base = r0 * cols;
    for (let c0 = 0; c0 + 5 < cols; c0++) {
      if (known.has(base + c0)) continue;
      // The top row: an attribute, the corner, then border characters up to the next attribute or the edge.
      if (!isAttr(base + c0) || !isChar(base + c0 + 1) || !isChar(base + c0 + 2)) continue;
      let rc = c0 + 2;
      while (rc + 1 < cols && !isAttr(base + rc + 1)) rc++;
      if (rc < c0 + 5) continue;
      const top = edge(text, base + c0 + 2, base + rc - 1);
      if (!top) continue;
      const attr = attrs[base + c0];
      let left = '';
      let right = '';
      let r1 = -1;
      let bottom: Edge | undefined;
      for (let r = r0 + 1; r < rows; r++) {
        const b = r * cols;
        if (attrs[b + c0] !== attr || !isChar(b + c0 + 1)) break;
        if (isAttr(b + c0 + 2)) {
          // A side row: the left and right border characters with their attributes.
          if (attrs[b + rc - 1] !== attr || !isChar(b + rc)) break;
          const l = text[b + c0 + 1] ?? '';
          const rt = text[b + rc] ?? '';
          if (!left) [left, right] = [l, rt];
          else if (l !== left || rt !== right) break;
          continue;
        }
        if (!right || !isChar(b + rc)) break;
        bottom = edge(text, b + c0 + 2, b + rc - 1);
        if (bottom) r1 = r;
        break;
      }
      if (r1 < 0) continue;
      const win: SnapshotWindow = { row: r0, col: c0, rows: r1 - r0 + 1, cols: rc - c0 + 2 };
      if (top.text) win.title = top.text;
      if (bottom?.text) win.footer = bottom.text;
      out.push(win);
    }
  }
  return out;
}
