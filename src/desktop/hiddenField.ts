import type { ScreenSnapshot } from '../shared/protocol';

/**
 * Whether the cursor of a screen snapshot is in a non-display (password) field. The
 * session engine runs in the broker window, so the tab decides from the last snapshot it
 * was shown, which is what the user saw when the key was pressed. The field is the entry
 * field that holds the cursor; its attribute is the one at the cell before it. Same
 * rule as cursorInHiddenField in the shared code: (attr & 7) === 7.
 */
export function snapshotCursorHidden(s: ScreenSnapshot | undefined): boolean {
  if (!s) return false;
  const size = s.rows * s.cols;
  const at = s.cursor.row * s.cols + s.cursor.col;
  const f = s.fields.find((x) => at >= x.start && at < x.start + x.length);
  if (!f || size <= 0) return false;
  for (let n = 0; n < size; n++) {
    const a = s.attrs[(((f.start - 1 - n) % size) + size) % size] ?? 0;
    if (a >= 0x20 && a <= 0x3f) return (a & 0x07) === 0x07;
  }
  return false;
}
