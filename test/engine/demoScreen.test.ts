import { describe, expect, it } from 'vitest';
import { buildDemoScreen } from '../../src/engine/demoScreen';

describe('buildDemoScreen', () => {
  it.each([
    [24, 80],
    [27, 132],
  ])('fills exactly %i x %i cells', (rows, cols) => {
    const s = buildDemoScreen(rows, cols);
    expect(s.rows).toBe(rows);
    expect(s.cols).toBe(cols);
    expect(s.text.length).toBe(rows * cols);
    expect(s.attrs.length).toBe(rows * cols);
    expect(s.text).toContain('TN5250 Terminal for IBM i');
    expect(s.attrs.filter((a) => a !== 0).every((a) => a >= 0x20 && a <= 0x3f)).toBe(true);
    expect(s.cursor.row).toBeLessThan(rows);
    expect(s.cursor.col).toBeLessThan(cols);
  });
});
