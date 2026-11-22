/**
 * Telling a click from a drag on the screen. A click moves the cursor; a drag selects.
 * The hand moves a little while it clicks (a pixel or two, more on a touchpad), so a press
 * only becomes a drag once the pointer has left the cell it was pressed in AND travelled
 * a few pixels from where it was pressed.
 */

/** Pixels the pointer must travel from the press before the press can become a drag. */
export const DRAG_THRESHOLD_PX = 4;

export interface Point {
  x: number;
  y: number;
}

export interface Cell {
  row: number;
  col: number;
}

/** True when a press at `down` on cell `anchor`, now at `now` over `cell`, has become a drag. */
export function startsDrag(down: Point, now: Point, anchor: Cell, cell: Cell): boolean {
  if (cell.row === anchor.row && cell.col === anchor.col) return false;
  return Math.hypot(now.x - down.x, now.y - down.y) >= DRAG_THRESHOLD_PX;
}
