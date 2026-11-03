import { describe, expect, it } from 'vitest';
import { fitFont, type FitInput } from '../../src/webview/fit';

/** A monospace font 0.6 em wide, like Consolas. */
const measure = (px: number): number => px * 0.6;

const base: FitInput = { boxW: 1000, boxH: 600, pad: 0, rows: 24, cols: 80, autoFit: true, fontSize: 14, zoom: 1, crisp: false, measure };

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
