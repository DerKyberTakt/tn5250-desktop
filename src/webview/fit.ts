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
  measure(px: number): number;
}

export interface FitResult {
  px: number;
  cellW: number;
  cellH: number;
  /** Canvas size in CSS px, padding included. */
  cssW: number;
  cssH: number;
}

export const LINE_HEIGHT = 1.2;
export const MIN_FONT_PX = 6;

export function fitFont(input: FitInput): FitResult {
  const { rows, cols, pad } = input;
  const availW = input.boxW - pad * 2;
  const availH = input.boxH - pad * 2;

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
    return { px: size, cellW, cellH, cssW: Math.ceil(cols * cellW) + pad * 2, cssH: rows * cellH + pad * 2 };
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
