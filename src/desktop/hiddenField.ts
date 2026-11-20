import type { KeyEventInfo, ScreenSnapshot } from '../shared/protocol';

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

/** The session-log line for a key while the key overlay is on; nothing about the key when it goes into a password field. */
export function keyLogLine(m: KeyEventInfo, screen: ScreenSnapshot | undefined): string {
  if (snapshotCursorHidden(screen)) return 'key (not logged: cursor in a non-display field)';
  const mods = [m.ctrl && 'Ctrl', m.shift && 'Shift', m.alt && 'Alt', m.meta && 'Meta'].filter(Boolean).join('+');
  return `key ${mods ? mods + '+' : ''}${m.key} (${m.code})`;
}
