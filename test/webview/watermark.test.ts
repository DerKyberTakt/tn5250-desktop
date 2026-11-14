import { describe, expect, it } from 'vitest';
import { placeWatermark, tileWatermark } from '../../src/webview/watermark';

const base = { x: 50, y: 50, padding: 10, offsetX: 0, offsetY: 0 };

describe('placeWatermark', () => {
  it('centres by default and the offsets move it from there', () => {
    expect(placeWatermark({ ...base, position: 'center' }, 800, 600, 200, 100)).toEqual([300, 250]);
    expect(placeWatermark({ ...base, position: 'center', offsetX: -40, offsetY: 20 }, 800, 600, 200, 100)).toEqual([260, 270]);
  });

  it('a corner sits padding from the edges, offsets added', () => {
    expect(placeWatermark({ ...base, position: 'topLeft' }, 800, 600, 200, 100)).toEqual([10, 10]);
    expect(placeWatermark({ ...base, position: 'bottomRight' }, 800, 600, 200, 100)).toEqual([590, 490]);
    expect(placeWatermark({ ...base, position: 'topRight', offsetX: -5, offsetY: 5 }, 800, 600, 200, 100)).toEqual([585, 15]);
  });

  it('a custom position is a percentage of the free space and ignores the offsets', () => {
    expect(placeWatermark({ ...base, position: 'custom', x: 0, y: 100 }, 800, 600, 200, 100)).toEqual([0, 500]);
    expect(placeWatermark({ ...base, position: 'custom', x: 25, y: 50, offsetX: 300, offsetY: 300 }, 800, 600, 200, 100)).toEqual([150, 250]);
    expect(placeWatermark({ ...base, position: 'custom', x: 150, y: -5 }, 800, 600, 200, 100)).toEqual([600, 0]);
  });
});

describe('tileWatermark', () => {
  it('spaces marks by the gap (at least 8 px) and starts one step off screen, shifted by the offsets', () => {
    expect(tileWatermark({ gap: 10, offsetX: 0, offsetY: 0 }, 200, 100)).toEqual({ stepX: 220, stepY: 120, x0: -220, y0: -120 });
    expect(tileWatermark({ gap: 0, offsetX: 30, offsetY: -10 }, 200, 100)).toEqual({ stepX: 208, stepY: 108, x0: -178, y0: -10 });
  });
});
