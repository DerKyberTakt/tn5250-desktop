import { describe, expect, it } from 'vitest';
import { dragUnits, scrollBarGeometry, scrollBarHit } from '../../src/webview/gui';

const vertical = scrollBarGeometry({ horizontal: false, x: 760, y: 80, cellW: 10, cellH: 20, size: 10, total: 120, pos: 30, page: 10 });

describe('scroll bar geometry', () => {
  it('centres a vertical bar in its three cells, arrows at both ends, thumb by position', () => {
    expect(vertical.box).toEqual({ x: 769, y: 80, w: 12, h: 200 });
    expect(vertical.back).toEqual({ x: 769, y: 80, w: 12, h: 18 });
    expect(vertical.forward).toEqual({ x: 769, y: 262, w: 12, h: 18 });
    expect(vertical.track).toEqual({ x: 769, y: 98, w: 12, h: 164 });
    // 10 of 120 rows shown: the thumb is 1/12 of the track, at least 14 px; 30 rows down of 110 scrollable.
    expect(vertical.thumb.h).toBeCloseTo(14, 5);
    expect(vertical.thumb.y).toBeCloseTo(98 + ((164 - 14) * 30) / 110, 5);
  });

  it('a horizontal bar lies in one row and the thumb grows with the page size', () => {
    const g = scrollBarGeometry({ horizontal: true, x: 100, y: 300, cellW: 10, cellH: 20, size: 20, total: 40, pos: 0, page: 20 });
    expect(g.box).toEqual({ x: 100, y: 304, w: 200, h: 12 });
    expect(g.track).toEqual({ x: 110, y: 304, w: 180, h: 12 });
    expect(g.thumb.w).toBeCloseTo(90, 5);
    expect(g.thumb.x).toBe(110);
  });

  it('a bar that cannot scroll fills the track with the thumb', () => {
    const g = scrollBarGeometry({ horizontal: false, x: 0, y: 0, cellW: 10, cellH: 20, size: 8, total: 5, pos: 0, page: 8 });
    expect(g.thumb.h).toBe(g.track.h);
    expect(g.pxPerUnit).toBe(0);
  });

  it('hit testing tells arrows, thumb and the two halves of the track apart', () => {
    expect(scrollBarHit(vertical, 775, 85)).toEqual({ part: 'back' });
    expect(scrollBarHit(vertical, 775, 270)).toEqual({ part: 'forward' });
    expect(scrollBarHit(vertical, 775, vertical.thumb.y + 3)).toEqual({ part: 'thumb' });
    expect(scrollBarHit(vertical, 775, 100)).toEqual({ part: 'track', forward: false });
    expect(scrollBarHit(vertical, 775, 250)).toEqual({ part: 'track', forward: true });
    expect(scrollBarHit(vertical, 700, 100)).toBeUndefined();
    expect(scrollBarHit(vertical, 775, 300)).toBeUndefined();
  });

  it('converts a thumb drag to rows, clamped to the ends', () => {
    expect(dragUnits(vertical, vertical.pxPerUnit * 7.4, 120, 30, 10)).toBe(7);
    expect(dragUnits(vertical, -vertical.pxPerUnit * 50, 120, 30, 10)).toBe(-30);
    expect(dragUnits(vertical, vertical.pxPerUnit * 500, 120, 30, 10)).toBe(80);
    expect(dragUnits(vertical, 0.1, 120, 30, 10)).toBe(0);
  });
});
