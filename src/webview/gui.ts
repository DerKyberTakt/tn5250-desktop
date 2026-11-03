/**
 * Geometry and hit testing of the GUI constructs the terminal draws over the character
 * grid: host scroll bars (Define Scroll Bar Field) and the synthetic subfile scroll bar.
 * Pure functions, so they are testable without a canvas.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a scroll bar is drawn: the arrows, the track and the thumb, in CSS px. */
export interface ScrollBarGeometry {
  horizontal: boolean;
  /** The whole widget. */
  box: Rect;
  back: Rect;
  forward: Rect;
  track: Rect;
  thumb: Rect;
  /** Track pixels per scrollable row (or column); 0 when nothing scrolls. */
  pxPerUnit: number;
}

export interface ScrollBarInput {
  horizontal: boolean;
  /** Top-left of the cells the bar occupies, and the cell size. */
  x: number;
  y: number;
  cellW: number;
  cellH: number;
  /** Rows (vertical) or columns (horizontal) the bar occupies, arrows included. */
  size: number;
  /** Rows or columns the application can scroll through, and how many are before the first shown. */
  total: number;
  pos: number;
  /** Rows or columns on one page (what the thumb represents); defaults to the bar's size. */
  page?: number;
  /** Cells across the bar: 3 for a vertical host bar (attribute, bar, attribute), 1 otherwise. */
  spanCells?: number;
}

/** Thickness of the drawn bar; it sits in the middle of the cells it owns. */
export const BAR_THICKNESS = 12;
const MIN_THUMB = 14;

export function scrollBarGeometry(input: ScrollBarInput): ScrollBarGeometry {
  const { horizontal, cellW, cellH } = input;
  const span = input.spanCells ?? (horizontal ? 1 : 3);
  const thickness = Math.min(BAR_THICKNESS, Math.max(6, horizontal ? cellH - 2 : span * cellW - 2));
  let box: Rect;
  if (horizontal) {
    box = { x: input.x, y: input.y + (cellH - thickness) / 2, w: input.size * cellW, h: thickness };
  } else {
    box = { x: input.x + (span * cellW - thickness) / 2, y: input.y, w: thickness, h: input.size * cellH };
  }
  const arrow = horizontal ? Math.min(cellW, 18) : Math.min(cellH, 18);
  const back: Rect = horizontal ? { x: box.x, y: box.y, w: arrow, h: box.h } : { x: box.x, y: box.y, w: box.w, h: arrow };
  const forward: Rect = horizontal
    ? { x: box.x + box.w - arrow, y: box.y, w: arrow, h: box.h }
    : { x: box.x, y: box.y + box.h - arrow, w: box.w, h: arrow };
  const track: Rect = horizontal
    ? { x: back.x + back.w, y: box.y, w: Math.max(0, box.w - 2 * arrow), h: box.h }
    : { x: box.x, y: back.y + back.h, w: box.w, h: Math.max(0, box.h - 2 * arrow) };
  const length = horizontal ? track.w : track.h;
  const total = Math.max(1, input.total);
  const page = Math.max(1, Math.min(total, input.page ?? input.size));
  const pos = Math.max(0, Math.min(total - page, input.pos));
  let thumbLen = Math.max(MIN_THUMB, (length * page) / total);
  thumbLen = Math.min(thumbLen, length);
  const travel = length - thumbLen;
  const pxPerUnit = total > page ? travel / (total - page) : 0;
  const offset = pxPerUnit * pos;
  const thumb: Rect = horizontal
    ? { x: track.x + offset, y: track.y, w: thumbLen, h: track.h }
    : { x: track.x, y: track.y + offset, w: track.w, h: thumbLen };
  return { horizontal, box, back, forward, track, thumb, pxPerUnit };
}

export type ScrollHit = { part: 'back' | 'forward' | 'thumb' } | { part: 'track'; forward: boolean };

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Which part of a scroll bar a point is on, if any. */
export function scrollBarHit(g: ScrollBarGeometry, x: number, y: number): ScrollHit | undefined {
  if (!inRect(g.box, x, y)) return undefined;
  if (inRect(g.back, x, y)) return { part: 'back' };
  if (inRect(g.forward, x, y)) return { part: 'forward' };
  if (inRect(g.thumb, x, y)) return { part: 'thumb' };
  const before = g.horizontal ? x < g.thumb.x : y < g.thumb.y;
  return { part: 'track', forward: !before };
}

/** Rows (or columns) a thumb drag of `deltaPx` pixels stands for, clamped to what can still scroll. */
export function dragUnits(g: ScrollBarGeometry, deltaPx: number, total: number, pos: number, page: number): number {
  if (g.pxPerUnit <= 0) return 0;
  const units = Math.round(deltaPx / g.pxPerUnit);
  const maxForward = Math.max(0, total - page - pos);
  return Math.max(-pos, Math.min(maxForward, units));
}
