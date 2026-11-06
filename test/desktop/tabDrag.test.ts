import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD, detachOrigin, dragStarted, insertionIndex, nearBar, reorder, windowAt } from '../../src/desktop/tabDrag';

describe('tab drag helpers', () => {
  it('a press becomes a drag after the threshold', () => {
    expect(dragStarted({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(false);
    expect(dragStarted({ x: 10, y: 10 }, { x: 10 + DRAG_THRESHOLD, y: 10 })).toBe(true);
  });

  it('inserts before the first tab whose middle is right of the pointer', () => {
    const others = [
      { left: 0, right: 100 },
      { left: 102, right: 200 },
      { left: 202, right: 300 },
    ];
    expect(insertionIndex(others, 20)).toBe(0);
    expect(insertionIndex(others, 60)).toBe(1);
    expect(insertionIndex(others, 151)).toBe(1);
    expect(insertionIndex(others, 152)).toBe(2);
    expect(insertionIndex(others, 400)).toBe(3);
    expect(insertionIndex([], 400)).toBe(0);
  });

  it('reorders by moving one item to an index among the others', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c', 'd'], 1, 1)).toEqual(['a', 'b', 'c', 'd']);
    expect(reorder(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
    expect(reorder(['a'], 5, 0)).toEqual(['a']);
  });

  it('finds the other window under a screen point', () => {
    const windows = [
      { name: 'main', x: 0, y: 0, width: 800, height: 600 },
      { name: 'win-2', x: 700, y: 100, width: 400, height: 300 },
    ];
    expect(windowAt(windows, 750, 150, 'main')?.name).toBe('win-2');
    expect(windowAt(windows, 750, 150, 'win-2')?.name).toBe('main');
    expect(windowAt(windows, 10, 10, 'main')).toBeUndefined();
    expect(windowAt(windows, 1100, 400, 'main')).toBeUndefined();
    expect(windowAt(windows, 1099, 399, 'main')?.name).toBe('win-2');
  });

  it('places a detached window so the pointer lands on its tab, never off screen', () => {
    expect(detachOrigin(500, 300)).toEqual({ x: 440, y: 236 });
    expect(detachOrigin(10, 10)).toEqual({ x: 0, y: 0 });
  });

  it('the tab bar keeps a dragged tab within reach above and below', () => {
    const bar = { top: 40, bottom: 70 };
    expect(nearBar(bar, 55)).toBe(true);
    expect(nearBar(bar, 5)).toBe(true);
    expect(nearBar(bar, 109)).toBe(true);
    expect(nearBar(bar, 111)).toBe(false);
  });
});
