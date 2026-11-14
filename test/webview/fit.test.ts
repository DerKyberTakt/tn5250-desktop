import { describe, expect, it } from 'vitest';
import { fitFont, type FitInput, shrinkScale } from '../../src/webview/fit';

/** A monospace font 0.6 em wide, like Consolas. */
const measure = (px: number): number => px * 0.6;

const base: FitInput = { boxW: 1000, boxH: 600, pad: 0, rows: 24, cols: 80, autoFit: true, fontSize: 14, zoom: 1, crisp: false, measure };

describe('fill the window', () => {
  it('stretches the grid onto the box: no space left over, text scaled sideways', () => {
    // A wide box: 27x132 would leave the bottom third empty with the font's own proportions.
    const m = fitFont({ ...base, fill: true, rows: 27, cols: 132, boxW: 1200, boxH: 500 });
    expect(m.cssH).toBeLessThanOrEqual(500);
    expect(m.cssH).toBeGreaterThan(500 - 27);
    expect(m.cssW).toBeLessThanOrEqual(1200);
    expect(m.cssW).toBeGreaterThan(1200 - 132);
    expect(m.scaleX).not.toBe(1);
    expect(132 * m.cellW * m.scaleX).toBeCloseTo(1200, 0);
  });

  it('keeps the padding and the font floor', () => {
    const m = fitFont({ ...base, fill: true, pad: 8, boxW: 500, boxH: 300 });
    expect(m.cssH).toBeLessThanOrEqual(300);
    expect(m.cssH).toBeGreaterThan(300 - 24);
    expect(m.cssW).toBeLessThanOrEqual(500);
    // A box too small for the smallest font: the font floor wins and the grid overflows, as without fill.
    expect(fitFont({ ...base, fill: true, pad: 8, boxW: 300, boxH: 100 }).px).toBeGreaterThanOrEqual(6);
  });

  it('is off when auto-fit is off or the screen is zoomed', () => {
    expect(fitFont({ ...base, fill: true, autoFit: false }).scaleX).toBe(1);
    expect(fitFont({ ...base, fill: true, zoom: 1.1 }).scaleX).toBe(1);
    expect(fitFont(base).scaleX).toBe(1);
  });
});

describe('auto-fit font size', () => {
  it('fills the box without overshooting it', () => {
    const m = fitFont(base);
    expect(m.cssW).toBeLessThanOrEqual(base.boxW);
    expect(m.cssH).toBeLessThanOrEqual(base.boxH);
    expect(m.px).toBeGreaterThan(15);
  });

  it('is stable: the size it picks for a box fits the same box again (no scrollbar loop)', () => {
    // Boxes around the sizes where rounding the line height overshoots by a pixel.
    for (let h = 560; h <= 620; h++) {
      for (const pad of [0, 4, 24]) {
        const first = fitFont({ ...base, boxH: h, boxW: 900, pad });
        expect(first.cssH).toBeLessThanOrEqual(h);
        expect(first.cssW).toBeLessThanOrEqual(900);
        const again = fitFont({ ...base, boxH: h, boxW: 900, pad });
        expect(again).toEqual(first);
      }
    }
  });

  it('keeps the padding inside the box in enhanced mode', () => {
    const m = fitFont({ ...base, pad: 24, boxW: 640, boxH: 480 });
    expect(m.cssW).toBeLessThanOrEqual(640);
    expect(m.cssH).toBeLessThanOrEqual(480);
  });

  it('respects the fixed font size and zoom when auto-fit is off', () => {
    const m = fitFont({ ...base, autoFit: false, fontSize: 14, zoom: 2 });
    expect(m.px).toBe(28);
    expect(m.cssW).toBeGreaterThan(base.boxW);
  });

  it('zooming in may overflow the box, zooming out never does', () => {
    const zoomed = fitFont({ ...base, zoom: 1.5 });
    expect(zoomed.cssW).toBeGreaterThan(base.boxW);
    const small = fitFont({ ...base, zoom: 0.5 });
    expect(small.cssW).toBeLessThan(base.boxW / 1.5);
  });
});

describe('shrinkScale', () => {
  it('is 1 while the drawing fits, else the factor that brings the larger side into the box', () => {
    expect(shrinkScale(800, 480, 1000, 600)).toBe(1);
    expect(shrinkScale(800, 480, 400, 600)).toBe(0.5);
    expect(shrinkScale(800, 480, 1000, 120)).toBe(0.25);
    expect(shrinkScale(800, 480, 400, 120)).toBe(0.25);
    expect(shrinkScale(0, 480, 400, 120)).toBe(1);
  });
});
