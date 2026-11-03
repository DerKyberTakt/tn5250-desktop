import { ATTR_NORMAL } from './attributes';
import type { CodePage } from './codepage';
import type { Screen } from './screen';

/**
 * Selection fields of the enhanced 5250 interface (Define Selection Field, D9 50): menu
 * bars, single and multiple choice fields and lists, pull-downs and push buttons. The
 * model keeps what the host sent, lays the choices out on the screen the way the 5494
 * does for a character display (attribute cells, indicator characters, text) and knows
 * the inbound format; the keyboard and the renderer work on it.
 */

export type SelectionKind = 'menuBar' | 'single' | 'multiple' | 'singleList' | 'multipleList' | 'singlePulldown' | 'multiplePulldown' | 'pushButtons' | 'pushButtonsPulldown';

export type ChoiceState = 'available' | 'selected' | 'unavailable';

export interface GuiChoice {
  text: string;
  state: ChoiceState;
  /** Menu bar: this choice starts a new row. */
  newRow: boolean;
  /** The selection cursor skips this choice. */
  noCursor: boolean;
  /** Cursor Up / Down / Left / Right on this choice sends Roll Down / Up / Left / Right. */
  top: boolean;
  last: boolean;
  left: boolean;
  right: boolean;
  /** Push button without a box. */
  noBox: boolean;
  /** 0-based offset of the mnemonic character in the text. */
  mnemonic?: number;
  /** AID sent instead of Enter when this choice is selected (auto-select fields). */
  aid?: number;
  /** Single or double digit shown before the text (numeric selection). */
  digits?: string;
  /** An empty choice: a gap the cursor skips. */
  empty: boolean;
  // Layout, filled by layoutSelection: 0-based cells.
  row: number;
  /** The leading cell of the choice (its indicator attribute, or the leading text attribute). */
  col: number;
  /** First text cell and the number of text cells (TextSize). */
  textCol: number;
  textLen: number;
  /** Cell of the indicator character (radio/check box), if the field has indicators. */
  indicatorCol?: number;
}

export interface GuiSelection {
  /** Buffer offset of the field's first cell (the SBA address of the structured field). */
  addr: number;
  kind: SelectionKind;
  /** How choices are marked: a radio/check indicator left of the text, push button boxes, digits, or by attribute only. */
  indicators: 'none' | 'left' | 'button' | 'numeric1' | 'numeric2';
  underlineMnemonics: boolean;
  rows: number;
  cols: number;
  textSize: number;
  padding: number;
  /** 0 none, 1 on select, 2 on select or deselect, 3 on select (not numeric). */
  autoEnter: number;
  autoSelect: boolean;
  mdt: boolean;
  /** The cursor keys may not leave the field. */
  keepCursor: boolean;
  /** Field Advance / Backspace act like Character Advance / Backspace inside the field. */
  charAdvance: boolean;
  /** AID sent when the pointer is used outside a pull-down (0 = none). */
  cancelAid: number;
  choices: GuiChoice[];
  /** Index of the choice the selection cursor is on, -1 when the cursor is elsewhere. */
  cursor: number;
  /** The scroll bar beside a list: address of the GuiScrollBar that reports with this field. */
  scrollBarAddr?: number;
  total?: number;
  pos?: number;
  /** Menu bar separator line, if the host drew one. */
  separator?: { row: number; col: number; length: number };
}

const KINDS: Record<number, SelectionKind> = {
  0x01: 'menuBar',
  0x11: 'single',
  0x12: 'multiple',
  0x21: 'singleList',
  0x22: 'multipleList',
  0x31: 'singlePulldown',
  0x32: 'multiplePulldown',
  0x41: 'pushButtons',
  0x51: 'pushButtonsPulldown',
};

export const isSingleChoice = (k: SelectionKind): boolean => k !== 'multiple' && k !== 'multipleList' && k !== 'multiplePulldown';
export const isPulldown = (k: SelectionKind): boolean => k === 'singlePulldown' || k === 'multiplePulldown' || k === 'pushButtonsPulldown';
export const isPushButtons = (k: SelectionKind): boolean => k === 'pushButtons' || k === 'pushButtonsPulldown';

/** Attributes the 5494 uses for a colour display (see Choice Presentation Display Attributes defaults). */
const ATTR_REVERSE = 0x21;
const ATTR_WHITE = 0x22;
const ATTR_WHITE_REVERSE = 0x23;
const ATTR_UNDERLINE = 0x24;
const ATTR_BLUE = 0x3a;
const ATTR_BLUE_REVERSE = 0x3b;

const EBCDIC_BLANK = 0x40;
const EBCDIC_PERIOD = 0x4b;
const EBCDIC_SLASH = 0x61;
const EBCDIC_LT = 0x4c;
const EBCDIC_GT = 0x6e;
const EBCDIC_DASH = 0x60;

/**
 * Parses a Define Selection Field major structure (bytes after class and type) with its
 * minor structures. Returns undefined when the structure is not usable.
 */
export function parseSelection(data: Uint8Array, addr: number, codePage: CodePage): GuiSelection | undefined {
  if (data.length < 16) return undefined;
  const flag1 = data[0] as number;
  const flag2 = data[1] as number;
  const kind = KINDS[data[3] as number];
  if (!kind) return undefined;
  const gui = data[4] as number;
  const indicatorBits = (gui >> 4) & 0x0f;
  const technique = gui & 0x07;
  let indicators: GuiSelection['indicators'] = 'none';
  if (indicatorBits === 0x0) indicators = 'left';
  else if (indicatorBits === 0x2 || indicatorBits === 0x3 || indicatorBits === 0x4 || indicatorBits === 0x5 || indicatorBits === 0x6) indicators = 'button';
  else if (indicatorBits === 0x8) indicators = technique === 0x5 ? 'numeric2' : 'numeric1';
  if (isPushButtons(kind) && indicators === 'left') indicators = 'button';
  if (kind === 'menuBar') indicators = 'none';
  const withScrollBar = (flag2 & 0x80) !== 0;
  const u32 = (i: number): number => (((data[i] as number) << 24) | ((data[i + 1] as number) << 16) | ((data[i + 2] as number) << 8) | (data[i + 3] as number)) >>> 0;
  let i = 16;
  let total: number | undefined;
  let pos: number | undefined;
  if (withScrollBar && data.length >= 24) {
    total = u32(16);
    pos = u32(20);
    i = 24;
  }
  const sel: GuiSelection = {
    addr,
    kind,
    indicators,
    underlineMnemonics: technique === 0x1,
    rows: Math.max(1, data[10] as number),
    cols: Math.max(1, data[11] as number),
    textSize: Math.max(1, data[9] as number),
    padding: data[12] as number,
    autoEnter: (flag1 >> 2) & 0x03,
    autoSelect: (flag1 & 0x02) !== 0,
    mdt: (flag1 & 0x01) !== 0,
    keepCursor: (flag2 & 0x04) !== 0,
    charAdvance: (flag2 & 0x08) !== 0,
    cancelAid: data[15] as number,
    choices: [],
    cursor: -1,
    total,
    pos,
  };
  // Choice text comes in device-class variants (flag byte 3: bit 0 GUI, bit 1 NWS with
  // underscores, bit 2 NWS without); use the best class any choice offers.
  const minors: Array<{ type: number; body: Uint8Array }> = [];
  while (i + 1 < data.length) {
    const len = data[i] as number;
    const type = data[i + 1] as number;
    if (len < 2) break;
    minors.push({ type, body: data.subarray(i + 2, i + len) });
    i += len;
  }
  const classes = minors.filter((m) => m.type === 0x10).map((m) => m.body[2] ?? 0);
  const want = classes.some((c) => (c & 0x80) !== 0) ? 0x80 : classes.some((c) => (c & 0x40) !== 0) ? 0x40 : 0x20;
  for (const m of minors) {
    if (m.type === 0x10) {
      const b = m.body;
      if (b.length < 3 || ((b[2] as number) & want) === 0) continue;
      const f1 = b[0] as number;
      const f2 = b[1] as number;
      let p = 3;
      const choice: GuiChoice = {
        text: '',
        state: (f1 >> 6) === 1 ? 'selected' : (f1 >> 6) === 2 ? 'unavailable' : 'available',
        newRow: (f1 & 0x20) !== 0,
        noCursor: (f2 & 0x80) !== 0,
        top: (f2 & 0x40) !== 0,
        last: (f2 & 0x20) !== 0,
        left: (f2 & 0x10) !== 0,
        right: (f2 & 0x08) !== 0,
        noBox: (f2 & 0x04) !== 0,
        empty: false,
        row: 0,
        col: 0,
        textCol: 0,
        textLen: 0,
      };
      if ((f1 & 0x08) !== 0) choice.mnemonic = b[p++];
      if ((f1 & 0x04) !== 0) choice.aid = b[p++];
      const digits = f1 & 0x03;
      if (digits === 1 || digits === 2) {
        choice.digits = codePage.decodeBytes(b, p, p + digits);
        p += digits;
      }
      choice.text = codePage.decodeBytes(b, p, b.length).split(String.fromCharCode(0)).join(' ');
      choice.empty = p >= b.length;
      if (choice.empty) choice.noCursor = true;
      sel.choices.push(choice);
    } else if (m.type === 0x09 && m.body.length >= 3) {
      sel.separator = { row: -1, col: Math.max(0, (m.body[1] as number) - 1), length: Math.max(1, (m.body[2] as number) - (m.body[1] as number) + 1) };
    }
  }
  if (sel.choices.length === 0) return undefined;
  if (sel.kind === 'menuBar') sel.cols = Math.max(sel.cols, sel.choices.length);
  return sel;
}

/** Cells a choice takes left of its text: the leading attribute and an indicator pair. */
function leadCells(sel: GuiSelection, colIndex: number): number {
  switch (sel.indicators) {
    case 'left':
    case 'numeric1':
      return 3;
    case 'numeric2':
      return colIndex === 0 ? 4 : 3;
    default:
      return 1;
  }
}

/** Places the choices on the screen starting at the field address, row-major. */
export function layoutSelection(sel: GuiSelection, screen: Screen): void {
  const baseRow = screen.rowOf(sel.addr);
  const baseCol = screen.colOf(sel.addr);
  if (sel.kind === 'menuBar') {
    let row = baseRow;
    let col = baseCol;
    for (const c of sel.choices) {
      if (c.newRow && c !== sel.choices[0]) {
        row += 1;
        col = baseCol;
      }
      const len = Math.max(1, Math.min(sel.textSize, c.text.length || 1));
      c.row = row;
      c.col = col;
      c.textCol = col + 1;
      c.textLen = len;
      col += len + 2 + sel.padding;
    }
    if (sel.separator) sel.separator.row = row + 1;
    return;
  }
  // Column starts: every column is lead cells + text + ending attribute, then padding.
  const starts: number[] = [];
  let x = baseCol;
  for (let ci = 0; ci < sel.cols; ci++) {
    starts.push(x);
    x += leadCells(sel, ci) + sel.textSize + 1 + sel.padding;
  }
  sel.choices.forEach((c, i) => {
    const ci = i % sel.cols;
    c.row = baseRow + Math.floor(i / sel.cols);
    c.col = starts[ci] as number;
    const lead = leadCells(sel, ci);
    c.textCol = c.col + lead;
    c.textLen = sel.textSize;
    if (sel.indicators === 'left') c.indicatorCol = c.col + 1;
  });
}

/** Right edge (exclusive) of the field: where a list's scroll bar attribute goes. */
export function selectionRightEdge(sel: GuiSelection): number {
  let edge = 0;
  for (const c of sel.choices) edge = Math.max(edge, c.textCol + c.textLen + 1);
  return edge;
}

/** Writes the choices (attributes, indicators, text) into the screen buffer. */
export function writeSelection(sel: GuiSelection, screen: Screen, codePage: CodePage): void {
  const put = (row: number, col: number, b: number): void => {
    if (row >= 0 && row < screen.rows && col >= 0 && col < screen.cols) screen.buffer[screen.addr(row, col)] = b;
  };
  sel.choices.forEach((c, i) => {
    if (sel.kind !== 'menuBar') {
      // Clear the whole choice area first (a redefinition may have fewer choices).
      for (let k = c.col; k < c.textCol + c.textLen + 1; k++) put(c.row, k, 0);
    }
    if (c.empty && sel.kind !== 'menuBar') {
      put(c.row, c.textCol - 1, ATTR_NORMAL);
      put(c.row, c.textCol + c.textLen, ATTR_NORMAL);
      return;
    }
    const onCursor = sel.cursor === i;
    if (sel.indicators === 'left' && c.indicatorCol !== undefined) {
      const multiple = !isSingleChoice(sel.kind);
      put(c.row, c.col, multiple && c.state !== 'unavailable' ? ATTR_UNDERLINE : ATTR_NORMAL);
      put(c.row, c.indicatorCol, c.state === 'selected' ? EBCDIC_SLASH : multiple ? EBCDIC_BLANK : EBCDIC_PERIOD);
    } else if (sel.indicators === 'numeric1' || sel.indicators === 'numeric2') {
      put(c.row, c.col, i === 0 ? ATTR_UNDERLINE : ATTR_NORMAL);
      const width = sel.indicators === 'numeric2' && i % sel.cols === 0 ? 2 : 1;
      for (let k = 0; k < width; k++) put(c.row, c.col + 1 + k, 0);
    }
    put(c.row, c.textCol - 1, leadingAttribute(sel, c, onCursor));
    let text = c.text;
    if (sel.indicators === 'numeric1' || sel.indicators === 'numeric2') text = `${c.digits ?? ' '}. ${text}`;
    if (sel.indicators === 'button') {
      const inner = text.length >= c.textLen ? text.slice(0, c.textLen) : text;
      text = c.noBox ? ` ${inner} ` : `<${inner.slice(0, Math.max(0, c.textLen - 2))}>`;
    }
    const bytes = codePage.encodeString(text.length > c.textLen ? text.slice(0, c.textLen) : sel.kind === 'menuBar' ? text : text.padEnd(c.textLen, ' '));
    for (let k = 0; k < c.textLen; k++) put(c.row, c.textCol + k, k < bytes.length ? (bytes[k] as number) : sel.kind === 'menuBar' ? EBCDIC_BLANK : EBCDIC_BLANK);
    put(c.row, c.textCol + c.textLen, ATTR_NORMAL);
  });
  if (sel.separator && sel.separator.row >= 0) {
    const { row, col, length } = sel.separator;
    put(row, col, ATTR_BLUE);
    for (let k = 1; k < length - 1; k++) put(row, col + k, EBCDIC_DASH);
    put(row, col + length - 1, ATTR_NORMAL);
  }
}

/** The attribute in front of a choice's text: selection cursor, selected, unavailable or plain. */
function leadingAttribute(sel: GuiSelection, c: GuiChoice, onCursor: boolean): number {
  const hasIndicators = sel.indicators !== 'none';
  if (onCursor) {
    if (c.state === 'unavailable') return ATTR_BLUE_REVERSE;
    if (c.state === 'selected' && !hasIndicators) return ATTR_WHITE_REVERSE;
    return ATTR_REVERSE;
  }
  if (c.state === 'unavailable') return ATTR_BLUE;
  if (c.state === 'selected' && !hasIndicators) return ATTR_WHITE;
  return ATTR_NORMAL;
}

/** Refreshes only the attribute and indicator cells after a state or cursor change. */
export function refreshSelection(sel: GuiSelection, screen: Screen): void {
  sel.choices.forEach((c, i) => {
    if (c.empty) return;
    const onCursor = sel.cursor === i;
    screen.buffer[screen.addr(c.row, c.textCol - 1)] = leadingAttribute(sel, c, onCursor);
    if (c.indicatorCol !== undefined) {
      const multiple = !isSingleChoice(sel.kind);
      screen.buffer[screen.addr(c.row, c.indicatorCol)] = c.state === 'selected' ? EBCDIC_SLASH : multiple ? EBCDIC_BLANK : EBCDIC_PERIOD;
    }
  });
}

/** The choice whose cells (indicator, text) contain the address, if any. */
export function choiceAt(sel: GuiSelection, screen: Screen, addr: number): number {
  const row = screen.rowOf(addr);
  const col = screen.colOf(addr);
  return sel.choices.findIndex((c) => !c.empty && c.row === row && col >= c.col && col <= c.textCol + c.textLen);
}

/** Index of the first choice the selection cursor may rest on (-1 if none). */
export function firstCursorChoice(sel: GuiSelection, fromEnd = false): number {
  const n = sel.choices.length;
  for (let k = 0; k < n; k++) {
    const i = fromEnd ? n - 1 - k : k;
    if (!sel.choices[i]!.noCursor) return i;
  }
  return -1;
}

/** The next cursor-accepting choice in sequence order (dir +1 / -1), or -1 at the end. */
export function stepChoice(sel: GuiSelection, from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < sel.choices.length; i += dir) {
    if (!sel.choices[i]!.noCursor) return i;
  }
  return -1;
}

/** The cursor-accepting choice in the same column one row up (-1) or down (+1), or -1. */
export function stepRow(sel: GuiSelection, from: number, dir: 1 | -1): number {
  const c = sel.choices[from];
  if (!c) return -1;
  if (sel.kind === 'menuBar') {
    let i = from;
    while ((i = stepChoiceRow(sel, i, dir)) >= 0) {
      if (!sel.choices[i]!.noCursor) return i;
    }
    return -1;
  }
  const colIndex = from % sel.cols;
  for (let i = from + dir * sel.cols; i >= 0 && i < sel.choices.length; i += dir * sel.cols) {
    if (i % sel.cols === colIndex && !sel.choices[i]!.noCursor) return i;
  }
  return -1;
}

function stepChoiceRow(sel: GuiSelection, from: number, dir: 1 | -1): number {
  const row = sel.choices[from]!.row;
  const col = sel.choices[from]!.col;
  let best = -1;
  let bestDist = Infinity;
  sel.choices.forEach((c, i) => {
    if (c.row !== row + dir) return;
    const d = Math.abs(c.col - col);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/**
 * Applies a selection to choice `i`: single-choice fields deselect the previous choice.
 * Returns false when the choice cannot be selected (unavailable / empty).
 */
export function selectChoice(sel: GuiSelection, i: number): boolean {
  const c = sel.choices[i];
  if (!c || c.empty || c.state === 'unavailable') return false;
  if (isSingleChoice(sel.kind)) {
    for (const o of sel.choices) if (o !== c && o.state === 'selected') o.state = 'available';
  }
  c.state = 'selected';
  sel.mdt = true;
  return true;
}

export function deselectChoice(sel: GuiSelection, i: number): boolean {
  const c = sel.choices[i];
  if (!c || c.state !== 'selected') return false;
  c.state = 'available';
  sel.mdt = true;
  return true;
}

/** The inbound bytes of the field: choice number (single) or one byte per choice (multiple); the scroll increment is added by the caller. */
export function selectionBytes(sel: GuiSelection): number[] {
  if (isSingleChoice(sel.kind)) {
    const idx = sel.choices.findIndex((c) => c.state === 'selected');
    if (idx < 0) return [0x00, 0x00];
    const n = idx + 0x20;
    return [(n >> 8) & 0xff, n & 0xff];
  }
  const slots = sel.kind === 'menuBar' ? sel.cols : sel.rows * sel.cols;
  const out: number[] = [];
  for (let i = 0; i < slots; i++) out.push(sel.choices[i]?.state === 'selected' ? 0xf1 : 0x00);
  return out;
}

/** Whether a typed character is the mnemonic of a choice; returns its index or -1. */
export function mnemonicChoice(sel: GuiSelection, ch: string): number {
  const want = ch.toUpperCase();
  return sel.choices.findIndex((c) => !c.empty && c.state !== 'unavailable' && c.mnemonic !== undefined && c.text.charAt(c.mnemonic).toUpperCase() === want && want !== '');
}

export { EBCDIC_LT, EBCDIC_GT };
