import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_PX, startsDrag } from '../../src/webview/clickDrag';

describe('startsDrag', () => {
  const anchor = { row: 5, col: 10 };
  const down = { x: 100, y: 100 };

  it('a pointer that moved inside the pressed cell is still a click', () => {
    // The old code turned any mousemove into a one-cell selection, and the click then did
    // not move the cursor (GitHub issue: clicks needed 2 or 3 tries).
    expect(startsDrag(down, { x: 103, y: 102 }, anchor, anchor)).toBe(false);
    expect(startsDrag(down, { x: 140, y: 100 }, anchor, anchor)).toBe(false);
  });

  it('a press next to a cell edge that slips into the neighbour by a pixel is still a click', () => {
    expect(startsDrag(down, { x: 101, y: 100 }, anchor, { row: 5, col: 11 })).toBe(false);
    expect(startsDrag(down, { x: 100 + DRAG_THRESHOLD_PX - 1, y: 100 }, anchor, { row: 5, col: 11 })).toBe(false);
  });

  it('leaving the cell by the threshold or more is a drag', () => {
    expect(startsDrag(down, { x: 100 + DRAG_THRESHOLD_PX, y: 100 }, anchor, { row: 5, col: 11 })).toBe(true);
    expect(startsDrag(down, { x: 100, y: 130 }, anchor, { row: 6, col: 10 })).toBe(true);
  });
});
