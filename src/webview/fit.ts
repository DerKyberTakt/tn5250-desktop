/**
 * Picks the font size for the character grid. Pure, so the auto-fit rules can be tested
 * without a canvas: `measure(px)` returns the width of one character at that size.
 */
export interface FitInput {
  /** The box the canvas has to fit in (CSS px), scrollbars included. */
  boxW: number;
  boxH: number;
  /** Padding the canvas draws around the grid (enhanced mode). */
  pad: number;
  rows: number;
  cols: number;
  autoFit: boolean;
  /** Font size when autoFit is off. */
  fontSize: number;
  zoom: number;
  /** Whole-pixel cell widths (crisp text rendering). */
  crisp: boolean;
  /** Auto-fit at zoom 1 stretches the grid to fill the box, the text scaled sideways, as ACS does. */
  fill?: boolean;
  measure(px: number): number;
}

export interface FitResult {
  px: number;
  cellW: number;
  cellH: number;
  /** Canvas size in CSS px, padding included. */
  cssW: number;
  cssH: number;
  /** Sideways scale of the whole drawing (1 unless `fill` stretched the grid to the box). */
  scaleX: number;
}

export const LINE_HEIGHT = 1.2;
export const MIN_FONT_PX = 6;

/**
 * The factor that brings a drawing of cssW x cssH into a box of boxW x boxH (1 when it fits
 * already): the whole screen stays in view instead of getting scroll bars.
 */
export function shrinkScale(cssW: number, cssH: number, boxW: number, boxH: number): number {
  if (cssW <= 0 || cssH <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, boxW / cssW, boxH / cssH);
}

export function fitFont(input: FitInput): FitResult {
  const { rows, cols, pad } = input;
  const availW = input.boxW - pad * 2;
  const availH = input.boxH - pad * 2;

  if (input.autoFit && input.fill && input.zoom === 1 && availW > 0 && availH > 0) {
    // Fill the box: rows share the height, the font follows the row height, and the columns
    // are stretched (or squeezed) sideways onto the width. Nothing is left over.
    const cellH = Math.max(Math.round(MIN_FONT_PX * LINE_HEIGHT), Math.floor(availH / rows));
    const px = Math.max(MIN_FONT_PX, Math.floor(cellH / LINE_HEIGHT));
    let cellW = input.measure(px);
    if (input.crisp) cellW = Math.max(1, Math.floor(cellW));
    const scaleX = availW / cols / cellW;
    return { px, cellW, cellH, cssW: Math.floor(cols * cellW * scaleX) + pad * 2, cssH: rows * cellH + pad * 2, scaleX };
  }

  let px: number;
  if (input.autoFit) {
    px = availH / rows / LINE_HEIGHT;
    const cw = input.measure(px);
    if (cols * cw > availW) px = px * (availW / (cols * cw));
  } else {
    px = input.fontSize;
  }
  px = Math.max(MIN_FONT_PX, Math.floor(px * input.zoom));

  const measure = (size: number): FitResult => {
    let cellW = input.measure(size);
    if (input.crisp) cellW = Math.max(1, Math.floor(cellW));
    const cellH = Math.round(size * LINE_HEIGHT);
    return { px: size, cellW, cellH, cssW: Math.ceil(cols * cellW) + pad * 2, cssH: rows * cellH + pad * 2, scaleX: 1 };
  };
  let m = measure(px);
  // Auto-fit must really fit: rounding the line height can overshoot by a pixel or two, which
  // would bring up a scrollbar, narrow the box, shrink the screen, drop the scrollbar and so on.
  // Step the font down until the canvas is inside the box.
  if (input.autoFit && input.zoom <= 1) {
    while (m.px > MIN_FONT_PX && (m.cssW > input.boxW || m.cssH > input.boxH)) m = measure(m.px - 1);
  }
  return m;
}
