/**
 * Where the watermark goes, as pure arithmetic so the rules can be tested: a fixed place
 * (centre or a corner, `padding` from the edges) shifted by the offsets; a custom place as a
 * percentage of the free space, which the offsets leave alone (the sliders are the whole
 * story there); or a brick-pattern tile whose origin the offsets shift.
 */
export interface WatermarkPlace {
  position: string;
  /** Custom position, 0..100 % of the free space. */
  x: number;
  y: number;
  /** Distance from the edges for a corner position. */
  padding: number;
  offsetX: number;
  offsetY: number;
}

/** Top-left of one mark of mw x mh on a screen of w x h. */
export function placeWatermark(o: WatermarkPlace, w: number, h: number, mw: number, mh: number): [number, number] {
  const p = o.position;
  if (p === 'custom') {
    const pct = (v: number): number => Math.max(0, Math.min(100, v)) / 100;
    return [(w - mw) * pct(o.x), (h - mh) * pct(o.y)];
  }
  let x = (w - mw) / 2;
  let y = (h - mh) / 2;
  if (p.startsWith('top')) y = o.padding;
  if (p.startsWith('bottom')) y = h - mh - o.padding;
  if (p.endsWith('Left')) x = o.padding;
  if (p.endsWith('Right')) x = w - mw - o.padding;
  return [x + o.offsetX, y + o.offsetY];
}

/** The tile pattern: the distance between marks and where the first (off-screen) one starts. */
export function tileWatermark(o: { gap: number; offsetX: number; offsetY: number }, mw: number, mh: number): { stepX: number; stepY: number; x0: number; y0: number } {
  const gap = Math.max(8, o.gap * 2);
  const stepX = mw + gap;
  const stepY = mh + gap;
  const mod = (a: number, b: number): number => ((a % b) + b) % b;
  return { stepX, stepY, x0: mod(o.offsetX, stepX) - stepX, y0: mod(o.offsetY, stepY) - stepY };
}
