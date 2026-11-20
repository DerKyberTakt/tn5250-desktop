import { describe, expect, it } from 'vitest';
import { snapshotCursorHidden } from '../../src/desktop/hiddenField';
import { MacroRecorder } from '../../src/shared/macros';
import type { ScreenSnapshot } from '../../src/shared/protocol';

// 24x80 screen with a user field (attr 0x20 at 100) and a password field (attr 0x27 at 200).
function snap(cursorAt: number): ScreenSnapshot {
  const attrs = new Array<number>(24 * 80).fill(0);
  attrs[100] = 0x20;
  attrs[200] = 0x27;
  return {
    rows: 24,
    cols: 80,
    text: ' '.repeat(24 * 80),
    fields: [
      { start: 101, length: 10, bypass: false },
      { start: 201, length: 10, bypass: false },
    ],
    attrs,
    cursor: { row: Math.floor(cursorAt / 80), col: cursorAt % 80 },
  };
}

describe('snapshotCursorHidden', () => {
  it('is true only in a non-display field', () => {
    expect(snapshotCursorHidden(snap(205))).toBe(true);
    expect(snapshotCursorHidden(snap(105))).toBe(false);
    expect(snapshotCursorHidden(snap(500))).toBe(false);
    expect(snapshotCursorHidden(undefined)).toBe(false);
  });

  it('feeds the recorder so a password never lands in a step', () => {
    const r = new MacroRecorder();
    r.text('kyle', snapshotCursorHidden(snap(105)));
    r.text('hunter2', snapshotCursorHidden(snap(205)));
    expect(JSON.stringify(r.steps)).not.toContain('hunter2');
    expect(r.steps).toEqual([{ type: 'text', text: 'kyle' }, { type: 'prompt', label: 'Password', secret: true }]);
  });
});
