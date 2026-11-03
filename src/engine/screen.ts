import { ATTR_NORMAL, isAttribute } from './attributes';
import type { CodePage } from './codepage';
import type { ScreenSnapshot } from '../shared/protocol';

/** Field Format Word bits (SF order). */
export const FFW_BYPASS = 0x2000;
export const FFW_DUP_ENABLE = 0x1000;
export const FFW_MDT = 0x0800;
export const FFW_SHIFT_MASK = 0x0700;
export const FFW_AUTO_ENTER = 0x0080;
export const FFW_FIELD_EXIT_REQUIRED = 0x0040;
export const FFW_MONOCASE = 0x0020;
export const FFW_MANDATORY_ENTER = 0x0008;
export const FFW_ADJUST_MASK = 0x0007;

export type FieldShift =
  | 'alphaShift'
  | 'alphaOnly'
  | 'numericShift'
  | 'numericOnly'
  | 'katakana'
  | 'digitsOnly'
  | 'inputOutput'
  | 'signedNumeric';

const SHIFTS: FieldShift[] = [
  'alphaShift',
  'alphaOnly',
  'numericShift',
  'numericOnly',
  'katakana',
  'digitsOnly',
  'inputOutput',
  'signedNumeric',
];

export type FieldAdjust = 'none' | 'rightZero' | 'rightBlank' | 'mandatoryFill';

/** An input field from the format table. Addresses are 0-based buffer offsets. */
export class Field {
  mdt: boolean;

  constructor(
    /** Buffer offset of the first data position (the attribute sits at start - 1). */
    readonly start: number,
    readonly length: number,
    readonly ffw: number,
    readonly fcws: readonly number[],
    readonly attr: number,
  ) {
    this.mdt = (ffw & FFW_MDT) !== 0;
  }

  get end(): number {
    return this.start + this.length; // exclusive
  }

  contains(addr: number): boolean {
    return addr >= this.start && addr < this.end;
  }

  get bypass(): boolean {
    return (this.ffw & FFW_BYPASS) !== 0;
  }

  get dupEnable(): boolean {
    return (this.ffw & FFW_DUP_ENABLE) !== 0;
  }

  get shift(): FieldShift {
    return SHIFTS[(this.ffw & FFW_SHIFT_MASK) >> 8] as FieldShift;
  }

  get autoEnter(): boolean {
    return (this.ffw & FFW_AUTO_ENTER) !== 0;
  }

  get fieldExitRequired(): boolean {
    return (this.ffw & FFW_FIELD_EXIT_REQUIRED) !== 0;
  }

  get monocase(): boolean {
    return (this.ffw & FFW_MONOCASE) !== 0;
  }

  get mandatoryEnter(): boolean {
    return (this.ffw & FFW_MANDATORY_ENTER) !== 0;
  }

  get adjust(): FieldAdjust {
    switch (this.ffw & FFW_ADJUST_MASK) {
      case 5:
        return 'rightZero';
      case 6:
        return 'rightBlank';
      case 7:
        return 'mandatoryFill';
      default:
        return 'none';
    }
  }

  get numeric(): boolean {
    const s = this.shift;
    return s === 'numericOnly' || s === 'digitsOnly' || s === 'signedNumeric';
  }
}

/**
 * The regeneration buffer: one EBCDIC byte per cell. Attribute bytes
 * (0x20..0x3F) live inline, exactly as the 5250 data stream places them.
 */
/**
 * A window the host created with the Create Window structured field (enhanced 5250).
 * The terminal draws the border and remembers what the window covers, so Remove GUI
 * Window can put it back; `row`/`col` is the top-left cell of the border rectangle.
 */
/** Title or footer text of a GUI window (Create Window minor structure 0x10). */
export interface GuiText {
  text: string;
  align: 'center' | 'left' | 'right';
}

export interface GuiWindow {
  row: number;
  col: number;
  /** Usable rows / columns inside the border. */
  depth: number;
  width: number;
  /** Rectangle rows (depth + 2) and columns (width + 6) actually on the screen. */
  rows: number;
  cols: number;
  /** Cells of the rectangle before the window was drawn, row-major. */
  saved: Uint8Array;
  /** Fields that touched the rectangle before the window was drawn. */
  savedFields: Field[];
  title?: GuiText;
  footer?: GuiText;
}

/**
 * A scroll bar the host defined with the Define Scroll Bar Field structured field
 * (enhanced 5250; DDS SFLEND(*SCRBAR)). It is an input field of its own: pointer use
 * sends a Roll AID and the next read returns a 4-byte scroll increment at its address.
 */
export interface GuiScrollBar {
  /** Buffer offset of the top-left cell (the leading attribute). */
  addr: number;
  horizontal: boolean;
  /** Move the text cursor onto the bar when the pointer scrolls it (flag bit 1). */
  moveCursor: boolean;
  mdt: boolean;
  /** Rows (or columns) of data the application can scroll through. */
  total: number;
  /** Rows (or columns) above (left of) the first one shown. */
  pos: number;
  /** Screen rows (vertical) or columns (horizontal) the bar occupies, arrows included. */
  size: number;
  /** Rows (or columns) to scroll, reported with the next read; 1 = arrow, more = slider drag. */
  increment: number;
}

export class Screen {
  rows = 24;
  cols = 80;
  buffer = new Uint8Array(24 * 80);
  fields: Field[] = [];
  cursor = 0;
  /** Open GUI windows, oldest first. */
  windows: GuiWindow[] = [];
  /** Scroll bars defined by the host, in screen order. */
  scrollBars: GuiScrollBar[] = [];
  /** 0-based row used for error messages (Write Error Code). */
  errorRow = 23;

  get size(): number {
    return this.rows * this.cols;
  }

  setSize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.buffer = new Uint8Array(rows * cols);
    this.fields = [];
    this.windows = [];
    this.scrollBars = [];
    this.cursor = 0;
    this.errorRow = rows - 1;
  }

  clear(): void {
    this.buffer.fill(0);
    this.fields = [];
    this.windows = [];
    this.scrollBars = [];
    this.cursor = 0;
  }

  /** A new format (SOH, Clear Format Table): the fields go, and with them the scroll bars, which are format table entries too. */
  clearFormatTable(): void {
    this.fields = [];
    this.scrollBars = [];
  }

  /** Adds or redefines a scroll bar at its address, keeping screen order. */
  addScrollBar(bar: GuiScrollBar): void {
    const idx = this.scrollBars.findIndex((b) => b.addr === bar.addr);
    if (idx >= 0) {
      this.scrollBars[idx] = bar;
      return;
    }
    const pos = this.scrollBars.findIndex((b) => b.addr > bar.addr);
    if (pos < 0) this.scrollBars.push(bar);
    else this.scrollBars.splice(pos, 0, bar);
  }

  scrollBarAt(addr: number): GuiScrollBar | undefined {
    return this.scrollBars.find((b) => b.addr === addr);
  }

  addr(row: number, col: number): number {
    return row * this.cols + col;
  }

  rowOf(addr: number): number {
    return Math.floor(addr / this.cols);
  }

  colOf(addr: number): number {
    return addr % this.cols;
  }

  /** Converts 1-based row/col operands from the data stream to a buffer offset. */
  addrFromStream(row: number, col: number): number {
    const r = Math.min(Math.max(row, 1), this.rows) - 1;
    const c = Math.min(Math.max(col, 1), this.cols) - 1;
    return this.addr(r, c);
  }

  /** The attribute in effect at an address: the nearest attribute byte at or before it. */
  attributeAt(addr: number): number {
    for (let i = addr; i >= 0; i--) {
      const b = this.buffer[i] as number;
      if (isAttribute(b)) return b;
    }
    return ATTR_NORMAL;
  }

  fieldAt(addr: number): Field | undefined {
    return this.fields.find((f) => f.contains(addr));
  }

  addField(field: Field): void {
    // Fields are kept in screen order; a redefinition at the same start replaces.
    const idx = this.fields.findIndex((f) => f.start === field.start);
    if (idx >= 0) {
      this.fields[idx] = field;
      return;
    }
    const pos = this.fields.findIndex((f) => f.start > field.start);
    if (pos < 0) this.fields.push(field);
    else this.fields.splice(pos, 0, field);
  }

  fieldBytes(field: Field): Uint8Array {
    return this.buffer.subarray(field.start, field.end);
  }

  /** Rolls rows top..bottom (0-based, inclusive) by n lines; positive n = up. */
  roll(n: number, top: number, bottom: number): void {
    if (n === 0 || top > bottom) return;
    const lines = bottom - top + 1;
    const count = Math.min(Math.abs(n), lines);
    const copy = this.buffer.slice(top * this.cols, (bottom + 1) * this.cols);
    const region = this.buffer.subarray(top * this.cols, (bottom + 1) * this.cols);
    region.fill(0);
    if (n > 0) {
      region.set(copy.subarray(count * this.cols), 0);
    } else {
      region.set(copy.subarray(0, (lines - count) * this.cols), count * this.cols);
    }
  }

  toSnapshot(codePage: CodePage): ScreenSnapshot {
    let text = '';
    const attrs = new Array<number>(this.size).fill(0);
    for (let i = 0; i < this.size; i++) {
      const b = this.buffer[i] as number;
      if (isAttribute(b)) {
        attrs[i] = b;
        text += ' ';
      } else if (b === 0) {
        text += '\u0000';
      } else {
        text += codePage.decode(b);
      }
    }
    return {
      rows: this.rows,
      cols: this.cols,
      text,
      fields: this.fields.map((f) => ({ start: f.start, length: f.length, bypass: f.bypass })),
      attrs,
      cursor: { row: this.rowOf(this.cursor), col: this.colOf(this.cursor) },
      gui: {
        windows: this.windows.map((w) => ({ row: w.row, col: w.col, rows: w.rows, cols: w.cols, title: w.title, footer: w.footer })),
        scrollBars: this.scrollBars.map((b) => ({
          addr: b.addr,
          row: this.rowOf(b.addr),
          col: this.colOf(b.addr),
          horizontal: b.horizontal,
          size: b.size,
          total: b.total,
          pos: b.pos,
        })),
      },
    };
  }

  /** Plain text of one row, for tests and copy. */
  rowText(row: number, codePage: CodePage): string {
    return codePage.decodeBytes(this.buffer, row * this.cols, (row + 1) * this.cols);
  }
}
