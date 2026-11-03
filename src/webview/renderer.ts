import { ATTR_NORMAL, decodeAttribute, isAttribute, type Color } from '../engine/attributes';
import type { ScreenSnapshot, SnapshotScrollBar, SnapshotWindow } from '../shared/protocol';
import { decoratedFieldCells, detectSubfiles, fieldRanges, keyLabelsIn, markedFieldRanges, rowText, urlsIn, type FieldRange, type SubfileArea } from '../shared/screenText';
import type { ColumnSeparators, CursorStyle, WatermarkPosition } from '../shared/settings';
import { highlightScreen, Tok } from '../shared/sourceHighlight';
import { fitFont } from './fit';
import { scrollBarGeometry, scrollBarHit, type Rect, type ScrollBarGeometry, type ScrollHit } from './gui';

/** Width of the gutter right of the text where the synthetic subfile scroll bar lives. */
const GUTTER = 18;

/** A scroll bar on the screen: one the host defined, or the synthetic one beside a subfile. */
export type ScrollBarRef = { kind: 'host'; bar: SnapshotScrollBar } | { kind: 'subfile'; area: SubfileArea; index: number };

export interface ScrollBarTarget {
  ref: ScrollBarRef;
  hit: ScrollHit;
  geometry: ScrollBarGeometry;
}

function refKey(ref: ScrollBarRef): string {
  return ref.kind === 'host' ? `h${ref.bar.addr}` : `s${ref.index}`;
}

/** Cells whose characters the enhanced renderer replaces by widgets: radio/check indicators and push button brackets. */
function selectionWidgetCells(s: ScreenSnapshot): Uint8Array<ArrayBuffer> {
  const mask = new Uint8Array(s.rows * s.cols);
  for (const sel of s.gui?.selections ?? []) {
    for (const c of sel.choices) {
      if (c.empty) continue;
      if (c.indicatorCol !== undefined && (sel.style === 'radio' || sel.style === 'check')) mask[c.row * s.cols + c.indicatorCol] = 1;
      if (sel.style === 'button' && !c.noBox) {
        // The '<' and '>' the host would show on a character display.
        const first = c.row * s.cols + c.col;
        const text = s.text.slice(first, first + c.length);
        const open = text.indexOf('<');
        const close = text.lastIndexOf('>');
        if (open >= 0) mask[first + open] = 1;
        if (close > open) mask[first + close] = 1;
      }
    }
    if (sel.separator) mask.fill(1, sel.separator.row * s.cols + sel.separator.col, sel.separator.row * s.cols + sel.separator.col + sel.separator.length);
  }
  return mask;
}

/** Cells of every GUI window border: the top and bottom rows and the three columns at each side. */
function windowBorderCells(s: ScreenSnapshot): Uint8Array<ArrayBuffer> {
  const mask = new Uint8Array(s.rows * s.cols);
  for (const w of s.gui?.windows ?? []) {
    for (let r = 0; r < w.rows; r++) {
      const base = (w.row + r) * s.cols + w.col;
      if (r === 0 || r === w.rows - 1) mask.fill(1, base, base + w.cols);
      else {
        mask.fill(1, base, base + Math.min(3, w.cols));
        mask.fill(1, base + Math.max(0, w.cols - 3), base + w.cols);
      }
    }
  }
  return mask;
}

/** Enhanced mode draws no box around input fields longer than this (characters). */
const BOX_MAX_FIELD_LENGTH = 60;

/** SEU syntax colours, taken from the 5250 palette so they follow the colour settings. */
const SYNTAX_COLORS: Record<number, Color> = {
  [Tok.Comment]: 'blue',
  [Tok.Keyword]: 'turquoise',
  [Tok.Builtin]: 'pink',
  [Tok.String]: 'yellow',
  [Tok.Number]: 'white',
  [Tok.Special]: 'pink',
  [Tok.Variable]: 'white',
  [Tok.Indicator]: 'red',
  [Tok.Name]: 'white',
  [Tok.Marker]: 'blue',
  [Tok.Spec]: 'white',
};

export interface Theme {
  background: string;
  colors: Record<Color, string>;
  cursor: string;
  activeField: string;
  ruleLine: string;
  /** Empty = the field colour. */
  columnSeparator: string;
  blinkMapped: string;
  enhanced: {
    gradientStart: string;
    gradientEnd: string;
    gradientAngle: number;
    fieldBorder: string;
    fieldFill: string;
    activeField: string;
    cornerRadius: number;
    textGlow: boolean;
    glowStrength: number;
    glowColor: string;
    selectionStart: string;
    selectionEnd: string;
    selectionText: string;
    selectionOpacity: number;
    scanlines: boolean;
    padding: number;
  };
}

export const DEFAULT_THEME: Theme = {
  background: '#000000',
  colors: {
    green: '#00d060',
    white: '#f0f0f0',
    red: '#ff5050',
    turquoise: '#20d0d0',
    yellow: '#f0e040',
    pink: '#ff70ff',
    blue: '#6a9cff',
  },
  cursor: '#f0f0f0',
  activeField: '#1e2a3a',
  ruleLine: '#9a9a9a',
  columnSeparator: '',
  blinkMapped: '#ff9040',
  enhanced: {
    gradientStart: '#0b1020',
    gradientEnd: '#1a1f3a',
    gradientAngle: 135,
    fieldBorder: '#4a6fa5',
    fieldFill: '#4a6fa520',
    activeField: '#7aa2ff',
    cornerRadius: 4,
    textGlow: true,
    glowStrength: 3,
    glowColor: '#00d060',
    selectionStart: '#4a6fa5',
    selectionEnd: '#7aa2ff',
    selectionText: 'auto',
    selectionOpacity: 0.75,
    scanlines: false,
    padding: 24,
  },
};

export interface RendererOptions {
  uiMode: 'classic' | 'enhanced';
  fontFamily: string;
  autoFit: boolean;
  /** Font size in CSS pixels when autoFit is off. */
  fontSize: number;
  fontStyle: 'plain' | 'bold';
  textRendering: 'smooth' | 'crisp';
  /** 1 = the size that fits the viewport; larger zooms in, smaller zooms out. */
  zoom: number;
  columnSeparators: ColumnSeparators;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  blinkText: 'blink' | 'hostColor' | 'mapped';
  ruleLine: boolean;
  ruleLineStyle: 'crosshair' | 'horizontal' | 'vertical';
  ruleLineFollowsCursor: boolean;
  highlightActiveField: boolean;
  watermarkType: 'text' | 'image';
  watermarkText: string;
  watermarkOpacity: number;
  watermarkPosition: WatermarkPosition;
  watermarkPadding: number;
  watermarkX: number;
  watermarkY: number;
  watermarkOffsetX: number;
  watermarkOffsetY: number;
  underlineUrls: boolean;
  keyButtons: boolean;
  /** Draw a scroll bar beside every subfile (More... / Bottom), not only host-defined ones. */
  subfileScrollBar: boolean;
  demoMode: boolean;
  demoLabel: string;
  demoColor: string;
}

const NULL = '\u0000';
const FALLBACK_FONT = 'Consolas, "Courier New", monospace';

/** Draws a ScreenSnapshot on a canvas as a fixed character grid. */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private screen: ScreenSnapshot | undefined;
  /** 1 where the cell belongs to a field (decorations apply even to null cells). */
  private fieldMask = new Uint8Array(0);
  /** Enhanced mode: cells under a field box or line, where the host underline is not drawn again. */
  private boxedMask = new Uint8Array(0);
  private ranges: FieldRange[] = [];
  /** Field runs as the host marks them (underline/reverse); enhanced boxes follow these. */
  private boxRanges: FieldRange[] = [];
  /** Per-cell SEU token kinds (undefined when the screen is not SEU). */
  private syntax: Uint8Array | undefined;
  private options: RendererOptions = {
    uiMode: 'classic',
    fontFamily: '',
    autoFit: true,
    fontSize: 14,
    fontStyle: 'plain',
    textRendering: 'smooth',
    zoom: 1,
    columnSeparators: 'dot',
    cursorStyle: 'block',
    cursorBlink: true,
    blinkText: 'blink',
    ruleLine: false,
    ruleLineStyle: 'crosshair',
    ruleLineFollowsCursor: true,
    highlightActiveField: false,
    watermarkType: 'text',
    watermarkText: '',
    watermarkOpacity: 0.15,
    watermarkPosition: 'center',
    watermarkPadding: 10,
    watermarkX: 50,
    watermarkY: 50,
    watermarkOffsetX: 0,
    watermarkOffsetY: 0,
    underlineUrls: true,
    keyButtons: false,
    subfileScrollBar: false,
    demoMode: false,
    demoLabel: 'DEMO',
    demoColor: '#ff9f1c',
  };
  private theme: Theme = DEFAULT_THEME;
  private viewportW = 0;
  private viewportH = 0;
  private fontPx = 16;
  private cellW = 10;
  private cellH = 19;
  private pad = 0;
  private blinkOn = true;
  private watermarkImage: HTMLImageElement | undefined;
  private ruleCell: { row: number; col: number } | undefined;
  /** Subfiles found for the synthetic scroll bar (only when the option is on). */
  private subfiles: SubfileArea[] = [];
  /** 1 where a cell is part of a GUI window border (enhanced mode draws a frame instead of the characters). */
  private windowBorderMask = new Uint8Array(0);
  /** 1 where a selection field's indicator or push button bracket sits (enhanced mode draws widgets there). */
  private selectionMask = new Uint8Array(0);
  /** The scroll bar part under the mouse, for hover feedback. */
  private scrollHover: ScrollBarTarget | undefined;
  /** While the thumb of a host bar is dragged: the position it is shown at. */
  private thumbPreview: { addr: number; pos: number } | undefined;
  /** Extra canvas width right of the text (synthetic scroll bar). */
  private gutter = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    this.ctx = ctx;
    window.setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.draw();
    }, 500);
  }

  get cursor(): { row: number; col: number } | undefined {
    return this.screen?.cursor;
  }

  get size(): { rows: number; cols: number } | undefined {
    return this.screen ? { rows: this.screen.rows, cols: this.screen.cols } : undefined;
  }

  get zoom(): number {
    return this.options.zoom;
  }

  setScreen(screen: ScreenSnapshot): void {
    const resized = !this.screen || this.screen.rows !== screen.rows || this.screen.cols !== screen.cols;
    this.screen = screen;
    const mask = new Uint8Array(screen.rows * screen.cols);
    for (const f of screen.fields) mask.fill(1, f.start, Math.min(mask.length, f.start + f.length));
    this.fieldMask = mask;
    this.boxedMask = decoratedFieldCells(screen);
    this.ranges = fieldRanges(screen);
    this.boxRanges = markedFieldRanges(screen);
    this.syntax = highlightScreen(screen);
    this.subfiles = this.options.subfileScrollBar && !screen.gui?.scrollBars.length ? detectSubfiles(screen) : [];
    this.windowBorderMask = windowBorderCells(screen);
    this.selectionMask = selectionWidgetCells(screen);
    this.thumbPreview = undefined;
    if (resized) this.layout();
    this.draw();
  }

  /** The scroll bars on the screen: the host's, or the synthetic subfile ones. */
  private scrollBars(): ScrollBarRef[] {
    const host = this.screen?.gui?.scrollBars ?? [];
    if (host.length > 0) return host.map((bar) => ({ kind: 'host', bar }));
    return this.subfiles.map((area, index) => ({ kind: 'subfile', area, index }));
  }

  private geometryFor(ref: ScrollBarRef): ScrollBarGeometry {
    if (ref.kind === 'host') {
      const b = ref.bar;
      const preview = this.thumbPreview?.addr === b.addr ? this.thumbPreview.pos : undefined;
      return scrollBarGeometry({
        horizontal: b.horizontal,
        x: this.x(b.col),
        y: this.y(b.row),
        cellW: this.cellW,
        cellH: this.cellH,
        size: b.size,
        total: b.total,
        pos: preview ?? b.pos,
        page: b.horizontal ? b.size - 2 : b.size,
      });
    }
    // Synthetic: in the gutter right of the text, as tall as the subfile block plus its marker row.
    const a = ref.area;
    const size = a.bottom - a.top + 1;
    return scrollBarGeometry({
      horizontal: false,
      x: this.x(this.screen?.cols ?? 80) + 2,
      y: this.y(a.top),
      cellW: GUTTER - 4,
      cellH: this.cellH,
      size,
      // Position is unknown for a synthetic bar: the thumb sits at the top while there is more, at the bottom on the last page.
      total: 3,
      pos: a.end === 'bottom' ? 2 : 0,
      page: 1,
      spanCells: 1,
    });
  }

  /** The scroll bar part at a point in canvas CSS pixels, if any. */
  scrollBarAt(x: number, y: number): ScrollBarTarget | undefined {
    const px = x - this.pad;
    const py = y - this.pad;
    for (const ref of this.scrollBars()) {
      const geometry = this.geometryFor(ref);
      const hit = scrollBarHit(geometry, px, py);
      if (hit) return { ref, hit, geometry };
    }
    return undefined;
  }

  /** Hover feedback for scroll bars; pass undefined when the mouse left them. */
  setScrollHover(target: ScrollBarTarget | undefined): void {
    const before = this.scrollHover;
    if (before === target) return;
    const same = before && target && before.ref.kind === target.ref.kind && before.hit.part === target.hit.part && refKey(before.ref) === refKey(target.ref);
    this.scrollHover = target;
    if (!same) this.draw();
  }

  /** Shows the thumb of a host bar at another position while it is dragged. */
  setThumbPreview(addr: number, pos: number): void {
    this.thumbPreview = { addr, pos };
    this.draw();
  }

  clearThumbPreview(): void {
    if (!this.thumbPreview) return;
    this.thumbPreview = undefined;
    this.draw();
  }

  setCursor(row: number, col: number): void {
    if (!this.screen) return;
    this.screen = { ...this.screen, cursor: { row, col } };
    this.draw();
  }

  setRuleCell(row: number, col: number): void {
    this.ruleCell = { row, col };
    this.draw();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.draw();
  }

  setOptions(options: Partial<RendererOptions>): void {
    this.options = { ...this.options, ...options };
    this.layout();
    this.draw();
  }

  setWatermarkImage(dataUrl: string): void {
    if (!dataUrl) {
      this.watermarkImage = undefined;
      this.draw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.watermarkImage = img;
      this.draw();
    };
    img.src = dataUrl;
  }

  resize(viewportW: number, viewportH: number): void {
    this.viewportW = viewportW;
    this.viewportH = viewportH;
    this.layout();
    this.draw();
  }

  /** Converts a point in canvas CSS pixels to a cell, clamped to the screen. */
  cellAt(x: number, y: number): { row: number; col: number } | undefined {
    if (!this.screen) return undefined;
    const col = Math.min(this.screen.cols - 1, Math.max(0, Math.floor((x - this.pad) / this.cellW)));
    const row = Math.min(this.screen.rows - 1, Math.max(0, Math.floor((y - this.pad) / this.cellH)));
    return { row, col };
  }

  rowText(row: number): string {
    return this.screen ? rowText(this.screen, row) : '';
  }

  /** Plain text of the screen (nulls as spaces), for copying. */
  textRows(): string[] {
    const s = this.screen;
    if (!s) return [];
    return Array.from({ length: s.rows }, (_, r) => rowText(s, r));
  }

  // ---- layout --------------------------------------------------------------

  private fontFamily(): string {
    if (this.options.fontFamily.trim()) return this.options.fontFamily;
    const editorFont = getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family').trim();
    return editorFont || FALLBACK_FONT;
  }

  private font(px = this.fontPx): string {
    return `${this.options.fontStyle === 'bold' ? 'bold ' : ''}${px}px ${this.fontFamily()}`;
  }

  private measureCharWidth(px: number): number {
    this.ctx.font = this.font(px);
    return this.ctx.measureText('M').width;
  }

  private layout(): void {
    if (!this.screen || this.viewportW <= 0 || this.viewportH <= 0) return;
    const { rows, cols } = this.screen;
    this.pad = this.options.uiMode === 'enhanced' ? this.theme.enhanced.padding : 0;
    this.gutter = this.options.subfileScrollBar ? GUTTER : 0;
    const m = fitFont({
      boxW: this.viewportW - this.gutter,
      boxH: this.viewportH,
      pad: this.pad,
      rows,
      cols,
      autoFit: this.options.autoFit,
      fontSize: this.options.fontSize,
      zoom: this.options.zoom,
      crisp: this.options.textRendering === 'crisp',
      measure: (px) => this.measureCharWidth(px),
    });

    this.fontPx = m.px;
    this.cellW = m.cellW;
    this.cellH = m.cellH;
    const cssW = m.cssW + this.gutter;
    const cssH = m.cssH;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, this.pad, this.pad);
    // Only a zoomed-in screen may scroll. A fitted one never shows scrollbars, so they can
    // never narrow the box and start the resize loop again.
    this.canvas.parentElement?.classList.toggle('overflow', cssW > this.viewportW || cssH > this.viewportH);
  }

  private x(col: number): number {
    const v = col * this.cellW;
    return this.options.textRendering === 'crisp' ? Math.round(v) : v;
  }

  private y(row: number): number {
    return row * this.cellH;
  }

  private attributeAt(idx: number) {
    const s = this.screen;
    if (s) {
      for (let i = idx; i >= 0; i--) {
        const a = s.attrs[i] ?? 0;
        if (isAttribute(a)) return decodeAttribute(a);
      }
    }
    return decodeAttribute(ATTR_NORMAL);
  }

  // ---- drawing -------------------------------------------------------------

  draw(): void {
    const s = this.screen;
    if (!s) return;
    const ctx = this.ctx;
    const { rows, cols } = s;
    const enhanced = this.options.uiMode === 'enhanced';
    const w = cols * this.cellW;
    const h = rows * this.cellH;

    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    this.drawBackground(w + this.pad * 2 + this.gutter, h + this.pad * 2, enhanced);
    ctx.restore();
    if (enhanced) this.drawWindowFrames();
    this.drawSelections(enhanced);

    ctx.font = this.font();
    ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = this.options.textRendering !== 'crisp';

    const activeIndex = s.fields.findIndex((f) => {
      const idx = s.cursor.row * cols + s.cursor.col;
      return !f.bypass && idx >= f.start && idx < f.start + f.length;
    });
    if (enhanced) this.drawFieldBoxes(activeIndex);
    else if (this.options.highlightActiveField && activeIndex >= 0) {
      ctx.fillStyle = this.theme.activeField;
      for (const r of this.ranges) {
        if (r.fieldIndex === activeIndex) ctx.fillRect(this.x(r.col), this.y(r.row), r.length * this.cellW + 0.5, this.cellH);
      }
    }
    if (this.options.keyButtons) this.drawKeyButtons(enhanced);
    const selectedMask = enhanced ? this.drawSelectionBox() : undefined;
    const selectionFg = this.selectionTextColor();

    let current = decodeAttribute(ATTR_NORMAL);
    const total = rows * cols;
    const glow = enhanced && this.theme.enhanced.textGlow && this.theme.enhanced.glowStrength > 0;
    for (let i = 0; i < total; i++) {
      const attrByte = s.attrs[i] ?? 0;
      if (isAttribute(attrByte)) {
        current = decodeAttribute(attrByte);
        continue; // the attribute position itself displays as a blank
      }
      const ch = s.text.charAt(i);
      // A null cell outside any field shows nothing: no underline, no reverse.
      const decorated = ch !== NULL || this.fieldMask[i] === 1;
      if (!decorated || current.nondisplay) continue;
      // Enhanced mode draws window borders as frames and selection indicators as widgets;
      // the characters the host sent for them stay hidden.
      if (enhanced && (this.windowBorderMask[i] === 1 || this.selectionMask[i] === 1)) continue;

      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = this.x(col);
      const y = this.y(row);
      let fg = this.theme.colors[current.color];
      if (current.blink && this.options.blinkText === 'mapped') fg = this.theme.blinkMapped;
      // SEU: colour plain (green) source text by syntax; the host's own colours stay.
      const kind = this.syntax?.[i];
      if (kind && current.color === 'green' && !current.reverse) fg = this.theme.colors[SYNTAX_COLORS[kind] ?? 'green'];

      if (current.reverse) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y, this.cellW + 0.5, this.cellH);
      }
      // Enhanced mode replaces the underline of input fields with boxes; everything else
      // the host underlines (headings, protected fields) keeps its underline.
      if (current.underline && (!enhanced || this.boxedMask[i] !== 1)) {
        ctx.fillStyle = current.reverse ? this.theme.background : fg;
        ctx.fillRect(x, y + this.cellH - 2, this.cellW + 0.5, 1);
      }
      if (current.columnSeparators && this.options.columnSeparators !== 'none' && (!enhanced || this.boxedMask[i] !== 1)) {
        ctx.fillStyle = this.theme.columnSeparator || fg;
        if (this.options.columnSeparators === 'line') ctx.fillRect(x, y, 1, this.cellH);
        else ctx.fillRect(x, y + this.cellH - 2, 1, 1);
      }
      const hidden = current.blink && this.options.blinkText === 'blink' && !this.blinkOn;
      if (ch !== NULL && ch !== ' ' && !hidden) {
        const onBox = selectedMask?.[i] === 1;
        ctx.fillStyle = current.reverse ? this.theme.background : onBox ? selectionFg : fg;
        if (glow && !onBox) {
          ctx.shadowColor = this.theme.enhanced.glowColor || fg;
          ctx.shadowBlur = this.theme.enhanced.glowStrength;
          ctx.fillText(ch, x, y + this.cellH / 2);
          ctx.shadowBlur = 0;
        }
        ctx.fillText(ch, x, y + this.cellH / 2);
      }
    }

    if (this.options.underlineUrls) this.drawUrlUnderlines();
    this.drawWatermark(w, h);
    if (this.options.demoMode) this.drawDemo(w, h);

    // Selection rectangle (Classic mode; Enhanced draws its box under the text).
    if (this.selection && !enhanced) {
      const r = this.selection;
      ctx.fillStyle = 'rgba(120, 160, 255, 0.35)';
      ctx.fillRect(this.x(r.col1), this.y(r.row1), (r.col2 - r.col1 + 1) * this.cellW, (r.row2 - r.row1 + 1) * this.cellH);
    }

    this.drawGui(enhanced);

    // Cursor. Never reveal nondisplay data under a block cursor.
    const { row, col } = s.cursor;
    if (!s.cursorHidden && row >= 0 && row < rows && col >= 0 && col < cols && (this.blinkOn || !this.options.cursorBlink)) {
      const x = this.x(col);
      const y = this.y(row);
      ctx.fillStyle = this.theme.cursor;
      if (this.options.cursorStyle === 'underline') {
        ctx.fillRect(x, y + this.cellH - 3, this.cellW + 0.5, 2);
      } else {
        ctx.fillRect(x, y, this.cellW + 0.5, this.cellH);
        const idx = row * cols + col;
        const ch = s.text.charAt(idx);
        if (ch !== ' ' && ch !== NULL && !this.attributeAt(idx).nondisplay) {
          ctx.fillStyle = this.theme.background;
          ctx.fillText(ch, x, y + this.cellH / 2);
        }
      }
    }

    // The rule line goes on top so it is always visible.
    this.drawRuleLine(w, h);
  }

  /** Scroll bars: the host's (Define Scroll Bar Field) or the synthetic subfile ones. */
  private drawGui(enhanced: boolean): void {
    for (const ref of this.scrollBars()) {
      const hover = this.scrollHover && refKey(this.scrollHover.ref) === refKey(ref) ? this.scrollHover.hit.part : undefined;
      this.drawScrollBar(this.geometryFor(ref), enhanced, hover, this.thumbPreview !== undefined && ref.kind === 'host' && this.thumbPreview.addr === ref.bar.addr);
    }
  }

  /**
   * Selection fields: radio buttons and check boxes in the indicator cells, push buttons as
   * rounded frames around their text, the selection cursor as a highlighted box, mnemonic
   * letters underlined and the menu bar separator as a line. Drawn under the text; the
   * Classic style keeps the host's characters and only adds the widgets.
   */
  private drawSelections(enhanced: boolean): void {
    const s = this.screen;
    if (!s?.gui?.selections.length) return;
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    const accent = enhanced ? e.activeField : this.theme.colors.white;
    const border = enhanced ? e.fieldBorder : this.theme.colors.blue;
    const fill = enhanced ? e.fieldFill : 'rgba(255,255,255,0.10)';
    const radius = enhanced ? e.cornerRadius : 2;
    for (const sel of s.gui.selections) {
      sel.choices.forEach((c, i) => {
        if (c.empty) return;
        const onCursor = sel.cursor === i;
        const x = this.x(c.col);
        const y = this.y(c.row);
        const w = c.length * this.cellW;
        const h = this.cellH;
        ctx.save();
        if (c.state === 'unavailable') ctx.globalAlpha = 0.55;
        if (sel.style === 'button') {
          if (!c.noBox) {
            this.roundRect(x - 2, y + 1, w + 4, h - 2, radius);
            ctx.fillStyle = c.state === 'selected' ? accent : fill;
            ctx.fill();
            ctx.lineWidth = onCursor ? 1.5 : 1;
            ctx.strokeStyle = onCursor ? accent : border;
            if (onCursor && enhanced) {
              ctx.shadowColor = accent;
              ctx.shadowBlur = 8;
            }
            ctx.stroke();
          }
        } else if ((sel.style === 'radio' || sel.style === 'check') && c.indicatorCol !== undefined && enhanced) {
          const cx = this.x(c.indicatorCol) + this.cellW / 2;
          const cy = y + h / 2;
          const r = Math.max(3, Math.min(this.cellW, h) * 0.38);
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = onCursor ? accent : border;
          ctx.fillStyle = fill;
          if (sel.style === 'radio') {
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (c.state === 'selected') {
              ctx.beginPath();
              ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
              ctx.fillStyle = accent;
              ctx.fill();
            }
          } else {
            this.roundRect(cx - r, cy - r, 2 * r, 2 * r, 2);
            ctx.fill();
            ctx.stroke();
            if (c.state === 'selected') {
              ctx.beginPath();
              ctx.moveTo(cx - r * 0.55, cy);
              ctx.lineTo(cx - r * 0.1, cy + r * 0.5);
              ctx.lineTo(cx + r * 0.6, cy - r * 0.5);
              ctx.lineWidth = 2;
              ctx.strokeStyle = accent;
              ctx.stroke();
            }
          }
        }
        // The selection cursor: a highlighted box around the text (the host reverses the attribute in Classic).
        if (onCursor && enhanced && sel.style !== 'button') {
          this.roundRect(x - 2, y + 1, w + 4, h - 2, radius);
          ctx.fillStyle = e.fieldFill;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = accent;
          ctx.shadowColor = accent;
          ctx.shadowBlur = 6;
          ctx.stroke();
        }
        if (c.mnemonic !== undefined && c.mnemonic < c.length) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = onCursor ? accent : border;
          ctx.fillRect(this.x(c.col + c.mnemonic), y + h - 2, this.cellW, 1);
        }
        ctx.restore();
      });
      if (sel.separator && enhanced) {
        ctx.save();
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        const y = this.y(sel.separator.row) + this.cellH / 2;
        ctx.beginPath();
        ctx.moveTo(this.x(sel.separator.col), y);
        ctx.lineTo(this.x(sel.separator.col + sel.separator.length), y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawScrollBar(g: ScrollBarGeometry, enhanced: boolean, hover: ScrollHit['part'] | undefined, dragging: boolean): void {
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    const accent = enhanced ? e.activeField : this.theme.colors.blue;
    const border = enhanced ? e.fieldBorder : this.theme.colors.blue;
    const radius = Math.min(6, g.box.w / 2, g.box.h / 2);
    ctx.save();
    // Track.
    this.roundRect(g.box.x, g.box.y, g.box.w, g.box.h, radius);
    ctx.fillStyle = enhanced ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = border;
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Arrows.
    const arrow = (r: Rect, dir: 'up' | 'down' | 'left' | 'right', lit: boolean): void => {
      if (lit) {
        this.roundRect(r.x, r.y, r.w, r.h, radius);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fill();
      }
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const s = Math.max(2.5, Math.min(r.w, r.h) * 0.28);
      ctx.beginPath();
      if (dir === 'up') {
        ctx.moveTo(cx - s, cy + s / 2);
        ctx.lineTo(cx, cy - s / 2);
        ctx.lineTo(cx + s, cy + s / 2);
      } else if (dir === 'down') {
        ctx.moveTo(cx - s, cy - s / 2);
        ctx.lineTo(cx, cy + s / 2);
        ctx.lineTo(cx + s, cy - s / 2);
      } else if (dir === 'left') {
        ctx.moveTo(cx + s / 2, cy - s);
        ctx.lineTo(cx - s / 2, cy);
        ctx.lineTo(cx + s / 2, cy + s);
      } else {
        ctx.moveTo(cx - s / 2, cy - s);
        ctx.lineTo(cx + s / 2, cy);
        ctx.lineTo(cx - s / 2, cy + s);
      }
      ctx.closePath();
      ctx.fillStyle = lit ? '#ffffff' : accent;
      ctx.fill();
    };
    arrow(g.back, g.horizontal ? 'left' : 'up', hover === 'back');
    arrow(g.forward, g.horizontal ? 'right' : 'down', hover === 'forward');
    // Thumb.
    const inset = 2;
    const t: Rect = { x: g.thumb.x + inset, y: g.thumb.y + inset, w: Math.max(2, g.thumb.w - 2 * inset), h: Math.max(2, g.thumb.h - 2 * inset) };
    this.roundRect(t.x, t.y, t.w, t.h, Math.max(1, radius - inset));
    const lit = hover === 'thumb' || dragging;
    ctx.fillStyle = lit ? '#ffffff' : accent;
    if (enhanced && lit) {
      ctx.shadowColor = accent;
      ctx.shadowBlur = 8;
    }
    ctx.fill();
    ctx.restore();
  }

  /**
   * Enhanced mode: a GUI window is a rounded frame with a soft shadow and its title on the
   * top edge, in place of the border characters the host sent for a character display.
   */
  private drawWindowFrames(): void {
    const s = this.screen;
    if (!s?.gui) return;
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    for (const w of s.gui.windows) {
      // The frame runs through the middle of the border cells: the corner characters sit
      // in column 1 of the rectangle (column 0 is the attribute), the text starts at column 3.
      const x = this.x(w.col + 1) + this.cellW / 2;
      const y = this.y(w.row) + this.cellH / 2;
      const width = (w.cols - 3) * this.cellW;
      const height = (w.rows - 1) * this.cellH;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 6;
      this.roundRect(x, y, width, height, e.cornerRadius + 2);
      ctx.fillStyle = e.gradientEnd;
      ctx.fill();
      ctx.restore();
      ctx.save();
      this.roundRect(x, y, width, height, e.cornerRadius + 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = e.fieldBorder;
      ctx.stroke();
      ctx.restore();
      this.drawWindowText(w.title, y, x, width);
      this.drawWindowText(w.footer, y + height, x, width);
    }
  }

  private drawWindowText(t: SnapshotWindow['title'], lineY: number, x: number, width: number): void {
    if (!t?.text) return;
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    ctx.save();
    ctx.font = this.font();
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(t.text).width;
    const padX = this.cellW * 0.6;
    const boxW = Math.min(width - this.cellW, textW + padX * 2);
    const bx = t.align === 'left' ? x + this.cellW : t.align === 'right' ? x + width - this.cellW - boxW : x + (width - boxW) / 2;
    this.roundRect(bx, lineY - this.cellH / 2 + 1, boxW, this.cellH - 2, e.cornerRadius);
    ctx.fillStyle = e.fieldBorder;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(t.text, bx + padX, lineY, boxW - padX * 2);
    ctx.restore();
  }

  private drawBackground(w: number, h: number, enhanced: boolean): void {
    const ctx = this.ctx;
    if (!enhanced) {
      ctx.fillStyle = this.theme.background;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const e = this.theme.enhanced;
    const a = ((e.gradientAngle % 360) * Math.PI) / 180;
    const cx = w / 2;
    const cy = h / 2;
    const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const g = ctx.createLinearGradient(cx - (Math.sin(a) * len) / 2, cy + (Math.cos(a) * len) / 2, cx + (Math.sin(a) * len) / 2, cy - (Math.cos(a) * len) / 2);
    g.addColorStop(0, e.gradientStart);
    g.addColorStop(1, e.gradientEnd);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (e.scanlines) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /**
   * Enhanced mode: input fields are rounded boxes; the active one glows. Fields
   * longer than BOX_MAX_FIELD_LENGTH (command lines, QSH, long comments) are
   * underlined instead, and SEU source lines stay plain.
   */
  private drawFieldBoxes(activeIndex: number): void {
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    const fields = this.screen?.fields ?? [];
    for (const r of this.boxRanges) {
      if (r.bypass) continue;
      const active = r.fieldIndex === activeIndex;
      if ((fields[r.fieldIndex]?.length ?? 0) > BOX_MAX_FIELD_LENGTH) {
        // Long fields (command lines, QSH, comments) get an underline instead of a box.
        // SEU source lines stay plain: a line under every source row is just noise.
        if (!this.syntax) this.drawFieldLine(r, active);
        continue;
      }
      const x = this.x(r.col) - 2;
      const y = this.y(r.row) + 1;
      const w = r.length * this.cellW + 4;
      const h = this.cellH - 2;
      this.roundRect(x, y, w, h, e.cornerRadius);
      ctx.fillStyle = e.fieldFill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = active ? e.activeField : e.fieldBorder;
      if (active) {
        ctx.shadowColor = e.activeField;
        ctx.shadowBlur = 8;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  /** Enhanced mode: the underline drawn under long input fields; brighter (with glow) when active. */
  private drawFieldLine(r: FieldRange, active: boolean): void {
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    const x = this.x(r.col);
    const y = this.y(r.row) + this.cellH - 2;
    const w = r.length * this.cellW;
    ctx.save();
    ctx.globalAlpha = active ? 1 : 0.6;
    ctx.fillStyle = active ? e.activeField : e.fieldBorder;
    if (active) {
      ctx.shadowColor = e.activeField;
      ctx.shadowBlur = 6;
    }
    ctx.fillRect(x, y, w, active ? 1.5 : 1);
    ctx.restore();
  }

  /** Contrasting text colour for the enhanced selection box. */
  private selectionTextColor(): string {
    const e = this.theme.enhanced;
    if (e.selectionText && e.selectionText !== 'auto') return e.selectionText;
    const lum = (hex: string): number => {
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
      if (!m) return 0;
      const [r, g, b] = [parseInt(m[1] as string, 16), parseInt(m[2] as string, 16), parseInt(m[3] as string, 16)];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return (lum(e.selectionStart || e.fieldBorder) + lum(e.selectionEnd || e.activeField)) / 2 > 150 ? '#101010' : '#ffffff';
  }

  /**
   * Enhanced mode: the mouse selection is a gradient-filled, outlined box and
   * the text on it is drawn in a contrasting colour. Returns the mask of cells
   * inside the selection.
   */
  private drawSelectionBox(): Uint8Array | undefined {
    const s = this.screen;
    const r = this.selection;
    if (!s || !r) return undefined;
    const ctx = this.ctx;
    const e = this.theme.enhanced;
    const x = this.x(r.col1) - 2;
    const y = this.y(r.row1) + 1;
    const w = (r.col2 - r.col1 + 1) * this.cellW + 4;
    const h = (r.row2 - r.row1 + 1) * this.cellH - 2;
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, e.selectionStart || e.fieldBorder);
    g.addColorStop(1, e.selectionEnd || e.activeField);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, e.selectionOpacity));
    this.roundRect(x, y, w, h, e.cornerRadius);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = e.activeField;
    ctx.shadowColor = e.activeField;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
    const mask = new Uint8Array(s.rows * s.cols);
    for (let row = r.row1; row <= r.row2; row++) mask.fill(1, row * s.cols + r.col1, row * s.cols + r.col2 + 1);
    return mask;
  }

  /** Function-key labels drawn as buttons (ACS "3-D buttons"). */
  private drawKeyButtons(enhanced: boolean): void {
    const s = this.screen;
    if (!s) return;
    const ctx = this.ctx;
    for (let row = 0; row < s.rows; row++) {
      const line = rowText(s, row);
      for (const k of keyLabelsIn(line)) {
        const x = this.x(k.start) - 2;
        const y = this.y(row) + 1;
        const w = k.length * this.cellW + 4;
        const h = this.cellH - 2;
        this.roundRect(x, y, w, h, enhanced ? this.theme.enhanced.cornerRadius : 2);
        ctx.fillStyle = enhanced ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.strokeStyle = enhanced ? this.theme.enhanced.fieldBorder : 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private drawUrlUnderlines(): void {
    const s = this.screen;
    if (!s) return;
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.colors.blue;
    for (let row = 0; row < s.rows; row++) {
      for (const u of urlsIn(rowText(s, row))) {
        ctx.fillRect(this.x(u.start), this.y(row) + this.cellH - 2, (u.end - u.start) * this.cellW, 1);
      }
    }
  }

  private drawRuleLine(w: number, h: number): void {
    const s = this.screen;
    if (!s || !this.options.ruleLine) return;
    const cell = this.options.ruleLineFollowsCursor ? s.cursor : (this.ruleCell ?? s.cursor);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = this.theme.ruleLine;
    const style = this.options.ruleLineStyle;
    if (style !== 'vertical') ctx.fillRect(0, Math.round(this.y(cell.row) + this.cellH - 1), w, 1);
    if (style !== 'horizontal') ctx.fillRect(Math.round(this.x(cell.col)), 0, 1, h);
    ctx.restore();
  }

  /** Demo sessions: a tilted label across the screen and a coloured frame. */
  private drawDemo(w: number, h: number): void {
    const ctx = this.ctx;
    const label = (this.options.demoLabel || 'DEMO').toUpperCase();
    ctx.save();
    ctx.strokeStyle = this.options.demoColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = this.options.demoColor;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.atan2(h, w));
    ctx.font = `bold ${Math.floor(Math.min(w, h) / Math.max(3, label.length) * 1.6)}px ${this.fontFamily()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  private drawWatermark(w: number, h: number): void {
    const ctx = this.ctx;
    const o = this.options;
    const pad = o.watermarkPadding;
    const p = o.watermarkPosition;
    const tile = p === 'tile';
    const place = (mw: number, mh: number): [number, number] => {
      let x = (w - mw) / 2;
      let y = (h - mh) / 2;
      if (p === 'custom') {
        const pct = (v: number): number => Math.max(0, Math.min(100, v)) / 100;
        x = (w - mw) * pct(o.watermarkX);
        y = (h - mh) * pct(o.watermarkY);
      }
      if (p.startsWith('top')) y = pad;
      if (p.startsWith('bottom')) y = h - mh - pad;
      if (p.endsWith('Left')) x = pad;
      if (p.endsWith('Right')) x = w - mw - pad;
      return [x + o.watermarkOffsetX, y + o.watermarkOffsetY];
    };
    /** Draws one mark, or (tile) repeats it over the whole screen in a brick pattern shifted by the offsets. */
    const stamp = (mw: number, mh: number, draw: (x: number, y: number) => void): void => {
      if (!tile) {
        const [x, y] = place(mw, mh);
        draw(x, y);
        return;
      }
      const gap = Math.max(8, pad * 2);
      const stepX = mw + gap;
      const stepY = mh + gap;
      const mod = (a: number, b: number): number => ((a % b) + b) % b;
      const x0 = mod(o.watermarkOffsetX, stepX) - stepX;
      const y0 = mod(o.watermarkOffsetY, stepY) - stepY;
      for (let row = 0, y = y0; y < h; row++, y += stepY) {
        const shift = row % 2 ? stepX / 2 : 0;
        for (let x = x0 - shift; x < w; x += stepX) draw(x, y);
      }
    };
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, o.watermarkOpacity));
    if (o.watermarkType === 'image' && this.watermarkImage) {
      const img = this.watermarkImage;
      // A tiled image is drawn smaller so several fit on the screen.
      const share = tile ? 0.25 : 0.5;
      const scale = Math.min(1, (w * share) / img.width, (h * share) / img.height);
      const mw = img.width * scale;
      const mh = img.height * scale;
      stamp(mw, mh, (x, y) => ctx.drawImage(img, x, y, mw, mh));
    } else if (o.watermarkType === 'text' && o.watermarkText.trim()) {
      const text = o.watermarkText.trim();
      ctx.fillStyle = this.theme.colors.white;
      const size = tile ? 2 : 4;
      ctx.font = `bold ${Math.max(tile ? 12 : 16, Math.floor(this.cellH * size))}px ${this.fontFamily()}`;
      ctx.textBaseline = 'top';
      const mh = this.cellH * size;
      const mw = ctx.measureText(text).width;
      stamp(mw, mh, (x, y) => ctx.fillText(text, x, y));
    }
    ctx.restore();
  }

  // ---- selection -----------------------------------------------------------

  private selection: { row1: number; col1: number; row2: number; col2: number } | undefined;
  private anchor: { row: number; col: number } | undefined;

  startSelection(row: number, col: number): void {
    this.anchor = { row, col };
    this.selection = undefined;
    this.draw();
  }

  extendSelection(row: number, col: number): void {
    if (!this.anchor) return;
    this.selection = {
      row1: Math.min(this.anchor.row, row),
      col1: Math.min(this.anchor.col, col),
      row2: Math.max(this.anchor.row, row),
      col2: Math.max(this.anchor.col, col),
    };
    this.draw();
  }

  /** Selects cells col1..col2 (inclusive) on a row, e.g. a double-clicked word. */
  selectRange(row: number, col1: number, col2: number): void {
    this.anchor = undefined;
    this.selection = { row1: row, col1, row2: row, col2 };
    this.draw();
  }

  endSelection(): void {
    this.anchor = undefined;
  }

  clearSelection(): void {
    this.anchor = undefined;
    if (this.selection) {
      this.selection = undefined;
      this.draw();
    }
  }

  get hasSelection(): boolean {
    return this.selection !== undefined;
  }

  /** Text inside the selection rectangle (whole screen when nothing is selected), nondisplay cells masked. */
  selectedText(trimTrailing = true): string {
    const s = this.screen;
    if (!s) return '';
    const r = this.selection ?? { row1: 0, col1: 0, row2: s.rows - 1, col2: s.cols - 1 };
    const lines: string[] = [];
    for (let row = r.row1; row <= r.row2; row++) {
      let line = '';
      for (let col = r.col1; col <= r.col2; col++) {
        const idx = row * s.cols + col;
        const ch = s.text.charAt(idx);
        line += ch === NULL || this.attributeAt(idx).nondisplay ? ' ' : ch;
      }
      lines.push(trimTrailing ? line.trimEnd() : line);
    }
    return lines.join('\n');
  }
}
