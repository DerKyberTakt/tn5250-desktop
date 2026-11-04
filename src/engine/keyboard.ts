import type { CodePage } from './codepage';
import { AID_ROLL_DOWN, AID_ROLL_LEFT, AID_ROLL_RIGHT, AID_ROLL_UP, type DataStreamProcessor } from './datastream';
import { FLAG_ATN, FLAG_SRQ, FLAG_TRQ, OP_NOOP, OP_PUT_GET } from './gds';
import type { Field, Screen } from './screen';
import { deselectChoice, firstCursorChoice, isSingleChoice, mnemonicChoice, refreshSelection, selectChoice, stepChoice, stepRow, type GuiSelection } from './selection';
import { AID_TWO_EVENT, type TerminalState } from './state';

/** A place Tab / Field Advance stops at: an entry field or a selection field. */
interface Stop {
  start: number;
  field?: Field;
  sel?: GuiSelection;
}
import type { KeyAction } from '../shared/keymap';

/** Attention identifiers sent with a read response. */
export const AID: Partial<Record<KeyAction, number>> = {
  enter: 0xf1,
  clear: 0xbd,
  help: 0xf3,
  pageUp: 0xf4,
  pageDown: 0xf5,
  print: 0xf6,
  recordBackspace: 0xf8,
  pf1: 0x31,
  pf2: 0x32,
  pf3: 0x33,
  pf4: 0x34,
  pf5: 0x35,
  pf6: 0x36,
  pf7: 0x37,
  pf8: 0x38,
  pf9: 0x39,
  pf10: 0x3a,
  pf11: 0x3b,
  pf12: 0x3c,
  pf13: 0xb1,
  pf14: 0xb2,
  pf15: 0xb3,
  pf16: 0xb4,
  pf17: 0xb5,
  pf18: 0xb6,
  pf19: 0xb7,
  pf20: 0xb8,
  pf21: 0xb9,
  pf22: 0xba,
  pf23: 0xbb,
  pf24: 0xbc,
};
const AID_AUTO_ENTER = 0x3f;

/** F-key number of an AID (1-24), 0 for other AIDs. */
function pfNumber(aid: number): number {
  if (aid >= 0x31 && aid <= 0x3c) return aid - 0x30;
  if (aid >= 0xb1 && aid <= 0xbc) return aid - 0xb0 + 12;
  return 0;
}

/** Operator error codes, as shown by 5250 displays. */
export const OPERATOR_ERRORS: Record<string, string> = {
  '0004': 'Entry of data not allowed in this input/output field',
  '0005': 'Cursor in protected area of display',
  '0007': 'Mandatory enter field requires data',
  '0008': 'Field requires alphabetic characters',
  '0009': 'Field requires numeric characters',
  '0010': 'Only digits allowed in this field',
  '0011': 'Key not valid in signed numeric field',
  '0012': 'No room to insert data',
  '0014': 'Mandatory fill field must be filled',
  '0016': 'Field minus not valid in this field',
  '0019': 'Dup or Field Mark not allowed in this field',
  '0020': 'Field exit required to leave this field',
  '0026': 'Field minus requires a numeric last digit',
};

/** Keys the host accepts while the keyboard is locked: they interrupt whatever the host is doing. */
const OUT_OF_BAND_ACTIONS = new Set<KeyAction>(['attn', 'sysreq', 'testRequest']);

const MOVEMENT_ACTIONS = new Set<KeyAction>([
  'tab',
  'backtab',
  'left',
  'right',
  'up',
  'down',
  'home',
  'newline',
  'endOfField',
  'fastUp',
  'fastDown',
  'fastLeft',
  'fastRight',
  'wordLeft',
  'wordRight',
  'beginningOfField',
]);

/** Cells a fast cursor key moves per press (ACS "fast cursor"). */
const FAST_STEP = 3;

const EBCDIC_NULL = 0x00;
const EBCDIC_BLANK = 0x40;
const EBCDIC_ZERO = 0xf0;
const EBCDIC_MINUS = 0x60;
const EBCDIC_DUP = 0x1c;
const EBCDIC_FIELD_MARK = 0x1e;

export interface KeyboardOutput {
  send(opcode: number, flags1: number, data: Uint8Array): void;
}

/** Local keyboard semantics: typing, field editing and AID keys. */
export class Keyboard {
  /** State at the moment the current key arrived (see press). */
  private pastEnd = false;
  private autoAdvanced = false;

  constructor(
    private readonly screen: Screen,
    private readonly state: TerminalState,
    private readonly processor: DataStreamProcessor,
    private readonly codePage: CodePage,
    private readonly out: KeyboardOutput,
  ) {}

  /** Types characters as if pressed one by one. */
  type(text: string): void {
    for (const ch of text) this.typeChar(ch);
  }

  /** Leaves the operator error state (X II), as Reset does, without touching insert mode. */
  clearError(): void {
    if (this.state.inputInhibited === 'error') {
      const insert = this.state.insert;
      this.reset();
      this.state.insert = insert;
    }
  }

  press(action: KeyAction): void {
    if (action === 'reset') {
      this.reset();
      return;
    }
    // Moving the cursor is a natural way out of an operator error.
    if (this.state.inputInhibited === 'error' && MOVEMENT_ACTIONS.has(action)) this.clearError();
    // Attention, System Request and Test Request go to the host out of band: they are the
    // way to interrupt a running job, so a locked keyboard (X SYSTEM) must not swallow them.
    if (this.state.inputInhibited === 'system' && OUT_OF_BAND_ACTIONS.has(action)) {
      this.outOfBand(action);
      return;
    }
    if (this.state.inputInhibited !== 'none') return;
    // A keystroke cancels a programmable two-event mouse sequence that was started.
    this.state.pendingMouse = undefined;
    // Inside a selection field most keys mean something else (choice navigation, select).
    if (this.selectionKey(action)) return;
    // Every key ends the past-the-end / just-auto-advanced states; the handlers below
    // still see what they were when the key arrived.
    this.pastEnd = this.state.cursorPastEnd;
    this.autoAdvanced = this.state.autoAdvanced;
    this.state.cursorPastEnd = false;
    this.state.autoAdvanced = false;
    switch (action) {
      case 'fieldExit':
      case 'fieldPlus':
      case 'fieldMinus':
        this.fieldExit(action);
        break;
      case 'endOfField':
        this.endOfField();
        break;
      case 'tab':
        this.moveToField(this.nextField(this.screen.cursor));
        break;
      case 'backtab':
        this.backtab();
        break;
      case 'left':
        this.moveCursor(-1);
        break;
      case 'right':
        this.moveCursor(1);
        break;
      case 'up':
        this.moveCursor(-this.screen.cols);
        break;
      case 'down':
        this.moveCursor(this.screen.cols);
        break;
      case 'fastLeft':
        this.moveCursor(-FAST_STEP);
        break;
      case 'fastRight':
        this.moveCursor(FAST_STEP);
        break;
      case 'fastUp':
        this.moveCursor(-FAST_STEP * this.screen.cols);
        break;
      case 'fastDown':
        this.moveCursor(FAST_STEP * this.screen.cols);
        break;
      case 'wordLeft':
        this.wordStart(-1);
        break;
      case 'wordRight':
        this.wordStart(1);
        break;
      case 'beginningOfField':
        this.beginningOfField();
        break;
      case 'home':
        this.moveToField(this.firstField());
        break;
      case 'newline':
        this.newline();
        break;
      case 'backspace':
        this.backspace();
        break;
      case 'delete':
        this.deleteChar();
        break;
      case 'deleteWord':
        this.deleteWord();
        break;
      case 'eraseField':
        this.eraseField();
        break;
      case 'insert':
        this.state.insert = !this.state.insert;
        break;
      case 'eraseEof':
        this.eraseEof();
        break;
      case 'eraseInput':
        this.eraseInput();
        break;
      case 'dup':
        this.dup();
        break;
      case 'fieldMark':
        this.fieldMark();
        break;
      case 'attn':
      case 'sysreq':
      case 'testRequest':
        this.outOfBand(action);
        break;
      case 'printScreen':
      case 'copy':
      case 'paste':
      case 'rule':
        break; // handled by the UI
      default: {
        const aid = AID[action];
        if (aid !== undefined) this.sendAid(aid);
        break;
      }
    }
  }

  // ---- helpers -----------------------------------------------------------

  /** Sends a flag-only record for Attention, System Request or Test Request. */
  private outOfBand(action: KeyAction): void {
    const flag = action === 'attn' ? FLAG_ATN : action === 'sysreq' ? FLAG_SRQ : FLAG_TRQ;
    this.out.send(OP_NOOP, flag, new Uint8Array(0));
  }

  private error(code: string): void {
    this.state.inputInhibited = 'error';
    this.state.errorMessage = `${code} ${OPERATOR_ERRORS[code] ?? ''}`.trim();
  }

  private reset(): void {
    if (this.state.inputInhibited === 'error') {
      this.state.inputInhibited = 'none';
      this.state.errorMessage = '';
      const s = this.screen;
      if (this.state.savedErrorRow) {
        s.buffer.set(this.state.savedErrorRow, s.errorRow * s.cols);
        this.state.savedErrorRow = undefined;
      }
      if (this.state.savedCursor !== undefined) {
        s.cursor = this.state.savedCursor;
        this.state.savedCursor = undefined;
      }
    }
    this.state.insert = false;
  }

  private inputFields(): Field[] {
    return this.screen.fields.filter((f) => !f.bypass);
  }

  private currentField(): Field | undefined {
    const f = this.screen.fieldAt(this.screen.cursor);
    return f && !f.bypass ? f : undefined;
  }

  /**
   * Where Tab / Field Advance may stop: entry fields and selection fields the cursor may
   * reach (all of them, or those inside a window that restricts the cursor), in screen
   * order. A selection field counts at its first cursor-accepting choice.
   */
  private stops(): Stop[] {
    const s = this.screen;
    // A continued entry field set is one stop, at its first segment.
    const out: Stop[] = this.inputFields()
      .filter((f) => !f.continued || s.segmentsOf(f)[0] === f)
      .map((f) => ({ start: f.start, field: f }));
    for (const sel of s.selections) {
      const first = firstCursorChoice(sel);
      if (first < 0) continue;
      const c = sel.choices[first]!;
      out.push({ start: s.addr(c.row, c.textCol), sel });
    }
    return out.filter((st) => s.cursorAllowed(st.start)).sort((a, b) => a.start - b.start);
  }

  private stopContains(st: Stop, addr: number): boolean {
    if (st.field) return st.field.contains(addr);
    return st.sel !== undefined && this.screen.selectionAt(addr)?.sel === st.sel;
  }

  private firstField(): Stop | undefined {
    return this.stops()[0];
  }

  /**
   * Every field the host numbers for cursor progression: entry fields in screen order,
   * bypass ones included, a continued set and a selection field counting once.
   */
  private numberedStops(): Stop[] {
    const s = this.screen;
    const out: Stop[] = s.fields.filter((f) => !f.continued || s.segmentsOf(f)[0] === f).map((f) => ({ start: f.start, field: f }));
    for (const sel of s.selections) {
      const first = firstCursorChoice(sel);
      if (first < 0) continue;
      const c = sel.choices[first]!;
      out.push({ start: s.addr(c.row, c.textCol), sel });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** The stop a cursor progression FCW on the field the cursor leaves points at, if any. */
  private progressionTarget(from: number): Stop | undefined {
    const f = this.screen.fieldAt(from);
    if (!f || f.bypass) return undefined;
    const n = this.screen.segmentsOf(f)[0]?.cursorProgression;
    if (!n) return undefined;
    const target = this.numberedStops()[n - 1];
    return target && (target.sel || !target.field?.bypass) ? target : undefined;
  }

  private nextField(from: number): Stop | undefined {
    const progression = this.progressionTarget(from);
    if (progression) return progression;
    const stops = this.stops();
    const here = stops.find((st) => this.stopContains(st, from));
    const after = stops.find((st) => st.start > from && st !== here && !this.stopContains(st, from));
    return after ?? stops[0];
  }

  private prevField(from: number): Stop | undefined {
    const stops = this.stops();
    // Backward out of a field that is the target of a cursor progression: back to its source.
    const here = this.numberedStops().findIndex((st) => this.stopContains(st, from));
    if (here >= 0) {
      const source = this.screen.fields.find((f) => !f.bypass && this.screen.segmentsOf(f)[0] === f && f.cursorProgression === here + 1);
      if (source) return { start: source.start, field: source };
    }
    const before = [...stops].reverse().find((st) => st.start < from && !this.stopContains(st, from));
    return before ?? stops[stops.length - 1];
  }

  /** Moves to a stop: the first cell of an entry field, or the first (or last) choice of a selection field. */
  private moveToField(st: Stop | undefined, fromEnd = false): void {
    if (!st) return;
    this.leaveSelection();
    if (st.sel) {
      const idx = firstCursorChoice(st.sel, fromEnd && st.sel.charAdvance);
      this.enterSelection(st.sel, idx);
      return;
    }
    this.screen.cursor = st.start;
  }

  /**
   * Moves the cursor by `delta` cells, wrapping around the screen; inside a window that
   * restricts the cursor it wraps within the window's usable area instead.
   */
  private moveCursor(delta: number): void {
    const s = this.screen;
    const b = s.cursorBounds();
    if (!b) {
      const size = s.size;
      s.cursor = (((s.cursor + delta) % size) + size) % size;
      return;
    }
    const w = b.right - b.left + 1;
    const h = b.bottom - b.top + 1;
    let row = Math.min(Math.max(s.rowOf(s.cursor), b.top), b.bottom) - b.top;
    let col = Math.min(Math.max(s.colOf(s.cursor), b.left), b.right) - b.left;
    if (Math.abs(delta) >= s.cols && delta % s.cols === 0) {
      row = (((row + delta / s.cols) % h) + h) % h;
    } else {
      const flat = row * w + col + delta;
      const n = w * h;
      const p = ((flat % n) + n) % n;
      row = Math.floor(p / w);
      col = p % w;
    }
    s.cursor = s.addr(b.top + row, b.left + col);
  }

  /** A cell that separates words: null, blank or a field attribute. */
  private isBlankCell(pos: number): boolean {
    const b = this.screen.buffer[pos] ?? EBCDIC_NULL;
    return b === EBCDIC_NULL || b === EBCDIC_BLANK || (b >= 0x20 && b <= 0x3f);
  }

  /** Tab Word / Backtab Word: the start of the next (or previous) word anywhere on the screen, wrapping. */
  private wordStart(dir: 1 | -1): void {
    const s = this.screen;
    const n = s.size;
    let p = s.cursor;
    for (let i = 0; i < n; i++) {
      p = (p + dir + n) % n;
      if (!this.isBlankCell(p) && this.isBlankCell((p - 1 + n) % n)) {
        s.cursor = p;
        return;
      }
    }
  }

  private beginningOfField(): void {
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    this.screen.cursor = edit.cells[0]!;
  }

  private backtab(): void {
    const f = this.currentField();
    if (f && this.screen.cursor > f.start) {
      this.screen.cursor = f.start;
      return;
    }
    this.moveToField(this.prevField(this.screen.cursor), true);
  }

  private newline(): void {
    const s = this.screen;
    this.leaveSelection();
    const row = (s.rowOf(s.cursor) + 1) % s.rows;
    s.cursor = s.addr(row, 0);
    if (!this.currentField()) {
      const next = this.stops().find((st) => st.start >= s.cursor) ?? this.firstField();
      this.moveToField(next);
    }
  }

  // ---- editing across a field or a continued entry field set ------------------

  /**
   * The field under the cursor as the operator edits it: a continued entry field set is
   * one field whose cells run through its segments; a plain field is a set of one.
   */
  private editSet(): { f: Field; set: Field[]; cells: number[]; idx: number } | undefined {
    const f = this.currentField();
    if (!f) return undefined;
    const set = this.screen.segmentsOf(f);
    const cells = this.screen.cellsOf(set);
    return { f: set[0]!, set, cells, idx: cells.indexOf(this.screen.cursor) };
  }

  private setMdt(set: Field[]): void {
    for (const g of set) g.mdt = true;
  }

  /** Moves the cell contents right by one from `from` (the last cell is lost). */
  private shiftRight(cells: number[], from: number): void {
    const b = this.screen.buffer;
    for (let i = cells.length - 1; i > from; i--) b[cells[i]!] = b[cells[i - 1]!] as number;
  }

  /** Moves the cell contents left by one from `from`; the last cell becomes null. */
  private shiftLeft(cells: number[], from: number): void {
    const b = this.screen.buffer;
    for (let i = from; i < cells.length - 1; i++) b[cells[i]!] = b[cells[i + 1]!] as number;
    if (cells.length > 0) b[cells[cells.length - 1]!] = EBCDIC_NULL;
  }

  private fillCells(cells: number[], from: number, byte: number): void {
    for (let i = Math.max(0, from); i < cells.length; i++) this.screen.buffer[cells[i]!] = byte;
  }

  /**
   * Word wrap: lays the words of the set out again so none is split between two lines
   * or segments (padding the end of a line with nulls); when they do not fit that way,
   * the text is written straight through. The cursor keeps its place in the text.
   */
  private reflow(set: Field[], cells: number[]): void {
    if (!set[0]!.wordWrap) return;
    const s = this.screen;
    const b = s.buffer;
    // Lines: segments, and within a segment one line per screen row.
    const lines: number[][] = [];
    for (const g of set) {
      let line: number[] = [];
      let row = -1;
      for (let a = g.start; a < g.end; a++) {
        const r = s.rowOf(a);
        if (r !== row && line.length > 0) {
          lines.push(line);
          line = [];
        }
        row = r;
        line.push(a);
      }
      if (line.length > 0) lines.push(line);
    }
    const idx = cells.indexOf(s.cursor);
    let logical = 0;
    for (let i = 0; i < idx && i < cells.length; i++) if (b[cells[i]!] !== EBCDIC_NULL) logical++;
    const bytes = cells.map((a) => b[a] as number).filter((x) => x !== EBCDIC_NULL);
    // Split into words (runs of non-blank) keeping single blanks between them.
    const words: number[][] = [];
    let cur: number[] = [];
    for (const x of bytes) {
      if (x === EBCDIC_BLANK) {
        if (cur.length > 0) words.push(cur);
        words.push([EBCDIC_BLANK]);
        cur = [];
      } else cur.push(x);
    }
    if (cur.length > 0) words.push(cur);
    const placed: number[] = [];
    let li = 0;
    let pos = 0;
    let fits = true;
    for (const w of words) {
      const line = lines[li];
      if (!line) {
        fits = false;
        break;
      }
      if (w[0] === EBCDIC_BLANK) {
        if (pos < line.length) {
          placed.push(EBCDIC_BLANK);
          pos++;
        } else {
          li++;
          pos = 0;
        }
        continue;
      }
      if (w.length > line.length - pos && w.length <= line.length) {
        // Pad the rest of this line with nulls and start the word on the next.
        while (pos < line.length) {
          placed.push(EBCDIC_NULL);
          pos++;
        }
        li++;
        pos = 0;
        if (!lines[li]) {
          fits = false;
          break;
        }
      }
      for (const x of w) {
        const l = lines[li];
        if (!l) {
          fits = false;
          break;
        }
        placed.push(x);
        pos++;
        if (pos >= l.length) {
          li++;
          pos = 0;
        }
      }
      if (!fits) break;
    }
    const out = fits ? placed : bytes;
    if (out.length > cells.length) return; // more than the field can hold: leave it as it is
    cells.forEach((a, i) => (b[a] = i < out.length ? (out[i] as number) : EBCDIC_NULL));
    // Cursor: the cell of the same logical character.
    let seen = 0;
    for (let i = 0; i < cells.length; i++) {
      if (seen === logical && b[cells[i]!] !== EBCDIC_NULL) {
        s.cursor = cells[i]!;
        return;
      }
      if (b[cells[i]!] !== EBCDIC_NULL) seen++;
      else if (seen === logical) {
        s.cursor = cells[i]!;
        return;
      }
    }
  }

  private typeChar(ch: string): void {
    if (this.state.inputInhibited !== 'none') return;
    if (this.selectionType(ch)) return;
    const s = this.screen;
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    const { f, set, cells, idx } = edit;
    // An I/O field (DDS data type I) takes data from a feature device only, never the keyboard.
    if (f.shift === 'inputOutput') {
      this.error('0004');
      return;
    }
    // The field is full and the cursor sits past its last position: the operator must
    // leave the field first (Field Exit, Tab, an arrow key).
    if (this.state.cursorPastEnd) {
      this.error('0020');
      return;
    }
    if (!this.validChar(f, ch)) return;
    const text = f.monocase ? ch.toUpperCase() : ch;
    const byte = this.codePage.encode(text);
    const cursor = s.cursor;
    this.state.autoAdvanced = false;
    if (this.state.insert) {
      const last = s.buffer[cells[cells.length - 1]!];
      if (last !== EBCDIC_NULL && last !== EBCDIC_BLANK) {
        this.error('0012');
        return;
      }
      this.shiftRight(cells, idx);
    }
    s.buffer[cursor] = byte;
    this.setMdt(set);
    if (idx + 1 < cells.length) {
      s.cursor = cells[idx + 1]!;
      this.reflow(set, cells);
      return;
    }
    this.reflow(set, cells);
    if (f.autoEnter) {
      this.sendAid(AID_AUTO_ENTER);
      return;
    }
    if (f.fieldExitRequired) {
      // Shown on the last cell, logically past it: Field Exit keeps this character.
      this.state.cursorPastEnd = true;
      return;
    }
    const next = this.nextField(cells[cells.length - 1]!);
    if (next) this.state.autoAdvanced = true;
    this.moveToField(next);
  }

  /** End of Field: the cursor goes just after the last typed character of the field (set). */
  private endOfField(): void {
    const s = this.screen;
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    const { cells } = edit;
    let end = cells.length;
    while (end > 0 && (s.buffer[cells[end - 1]!] === EBCDIC_NULL || s.buffer[cells[end - 1]!] === EBCDIC_BLANK)) end -= 1;
    if (end >= cells.length) {
      // Full: the last cell, past the end (a Field Exit now keeps the text).
      s.cursor = cells[cells.length - 1]!;
      this.state.cursorPastEnd = true;
    } else {
      s.cursor = cells[end]!;
    }
  }

  private validChar(f: Field, ch: string): boolean {
    const digit = ch >= '0' && ch <= '9';
    switch (f.shift) {
      case 'alphaOnly':
        if (!/^[\p{L} ,.-]$/u.test(ch)) {
          this.error('0008');
          return false;
        }
        return true;
      case 'numericOnly':
        if (!digit && !' +-.,'.includes(ch)) {
          this.error('0009');
          return false;
        }
        return true;
      case 'digitsOnly':
        if (!digit) {
          this.error('0010');
          return false;
        }
        return true;
      case 'signedNumeric':
        if (!digit) {
          this.error('0011');
          return false;
        }
        return true;
      default:
        return true;
    }
  }

  private fieldExit(kind: 'fieldExit' | 'fieldPlus' | 'fieldMinus'): void {
    const s = this.screen;
    const f = this.currentField();
    if (!f) {
      this.error('0005');
      return;
    }
    if (kind === 'fieldMinus' && !f.numeric) {
      this.error('0016');
      return;
    }
    // Pasted text that exactly filled the previous field already moved here by itself;
    // the paste's own Field Exit must not wipe this field.
    if (kind === 'fieldExit' && this.autoAdvanced && s.cursor === f.start) return;
    // A continued entry field set: nulled from the cursor to the end of the last segment,
    // then on to the field after the set (Field Minus is not valid there).
    if (f.continued) {
      if (kind === 'fieldMinus') {
        this.error('0016');
        return;
      }
      const edit = this.editSet();
      if (!edit) return;
      this.fillCells(edit.cells, this.pastEnd ? edit.idx + 1 : edit.idx, EBCDIC_NULL);
      this.setMdt(edit.set);
      this.reflow(edit.set, edit.cells);
      if (edit.f.autoEnter) {
        this.sendAid(AID_AUTO_ENTER);
        return;
      }
      this.moveToField(this.nextField(edit.cells[edit.cells.length - 1]!));
      return;
    }
    // Past the end of a full field the character under the cursor is kept.
    s.buffer.fill(EBCDIC_NULL, this.pastEnd ? s.cursor + 1 : s.cursor, f.end);
    const bytes = s.fieldBytes(f);
    const content = Array.from(bytes).filter((b) => b !== EBCDIC_NULL);

    if (f.shift === 'signedNumeric') {
      // Digits right-adjusted in positions 1..n-1; the last position holds the sign.
      const digits = content.filter((b) => b !== EBCDIC_BLANK);
      const fill = f.adjust === 'rightZero' ? EBCDIC_ZERO : EBCDIC_BLANK;
      bytes.fill(fill, 0, bytes.length - 1);
      bytes.set(digits.slice(-(bytes.length - 1)), Math.max(0, bytes.length - 1 - digits.length));
      bytes[bytes.length - 1] = kind === 'fieldMinus' ? EBCDIC_MINUS : EBCDIC_BLANK;
    } else if (f.adjust === 'rightZero' || f.adjust === 'rightBlank') {
      const fill = f.adjust === 'rightZero' ? EBCDIC_ZERO : EBCDIC_BLANK;
      const trimmed = content.filter((b) => b !== EBCDIC_BLANK);
      bytes.fill(fill);
      bytes.set(trimmed.slice(-bytes.length), Math.max(0, bytes.length - trimmed.length));
      if (kind === 'fieldMinus') this.negateLastDigit(bytes);
    } else if (f.adjust === 'mandatoryFill' && content.length > 0 && content.length < bytes.length) {
      this.error('0014');
      return;
    } else if (kind === 'fieldMinus') {
      this.negateLastDigit(bytes);
    }
    f.mdt = true;
    if (this.state.inputInhibited === 'error') return;
    this.reflow([f], s.cellsOf([f]));
    if (f.autoEnter) {
      this.sendAid(AID_AUTO_ENTER);
      return;
    }
    this.moveToField(this.nextField(f.end - 1));
  }

  /** Field minus on a numeric field: the last digit's zone becomes D (negative). */
  private negateLastDigit(bytes: Uint8Array): void {
    let i = bytes.length - 1;
    while (i >= 0 && (bytes[i] === EBCDIC_NULL || bytes[i] === EBCDIC_BLANK)) i -= 1;
    const b = bytes[i];
    if (i < 0 || b === undefined || b < EBCDIC_ZERO || b > 0xf9) {
      this.error('0026');
      return;
    }
    bytes[i] = 0xd0 | (b & 0x0f);
  }

  private backspace(): void {
    const s = this.screen;
    const edit = this.editSet();
    if (!edit) return;
    const { set, cells, idx } = edit;
    // Past the end of a full field the cursor is after the last character: Backspace
    // removes that character (PC style, like everywhere else in the field).
    if (this.pastEnd) {
      s.buffer[cells[cells.length - 1]!] = EBCDIC_NULL;
      this.setMdt(set);
      return;
    }
    if (idx > 0) {
      s.cursor = cells[idx - 1]!;
      this.shiftLeft(cells, idx - 1);
      this.setMdt(set);
      this.reflow(set, cells);
    }
    // At the start of a field, or outside any field, Backspace does nothing.
  }

  private deleteChar(): void {
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    this.shiftLeft(edit.cells, edit.idx);
    this.setMdt(edit.set);
    this.reflow(edit.set, edit.cells);
  }

  /** Delete Word: the word under the cursor and the blanks after it; the rest of the field shifts left. */
  private deleteWord(): void {
    const s = this.screen;
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    const { set, cells, idx } = edit;
    const blank = (i: number): boolean => s.buffer[cells[i]!] === EBCDIC_NULL || s.buffer[cells[i]!] === EBCDIC_BLANK;
    let end = idx;
    while (end < cells.length && !blank(end)) end += 1;
    while (end < cells.length && blank(end)) end += 1;
    if (end === idx) return;
    for (let k = 0; k < end - idx; k++) this.shiftLeft(cells, idx);
    this.setMdt(set);
    this.reflow(set, cells);
  }

  /** Erase Field: the whole current field (set), cursor back to its start. */
  private eraseField(): void {
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    this.fillCells(edit.cells, 0, EBCDIC_NULL);
    this.setMdt(edit.set);
    this.screen.cursor = edit.cells[0]!;
  }

  private eraseEof(): void {
    const edit = this.editSet();
    if (!edit) {
      this.error('0005');
      return;
    }
    this.fillCells(edit.cells, this.pastEnd ? edit.idx + 1 : edit.idx, EBCDIC_NULL);
    this.setMdt(edit.set);
    this.reflow(edit.set, edit.cells);
  }

  private eraseInput(): void {
    for (const f of this.inputFields()) {
      this.screen.buffer.fill(EBCDIC_NULL, f.start, f.end);
      f.mdt = false;
    }
    this.moveToField(this.firstField());
  }

  private dup(): void {
    const edit = this.editSet();
    if (!edit || !edit.f.dupEnable) {
      this.error('0019');
      return;
    }
    this.fillCells(edit.cells, this.pastEnd ? edit.idx + 1 : edit.idx, EBCDIC_DUP);
    this.setMdt(edit.set);
    this.moveToField(this.nextField(edit.cells[edit.cells.length - 1]!));
  }

  private fieldMark(): void {
    const f = this.currentField();
    if (!f) {
      this.error('0019');
      return;
    }
    this.screen.buffer[this.screen.cursor] = EBCDIC_FIELD_MARK;
    f.mdt = true;
    if (this.screen.cursor + 1 < f.end) this.screen.cursor += 1;
  }

  /**
   * Pointer use of a host scroll bar (enhanced 5250): the bar's MDT goes on with the
   * increment to report (1 = an arrow, more = a slider drag, 0 = a page), the cursor moves
   * onto the bar when the host asked for that, and a Roll AID goes to the host: Roll Up /
   * Roll Right toward the end, Roll Down / Roll Left back.
   */
  scrollBar(addr: number, forward: boolean, increment: number): void {
    const bar = this.screen.scrollBarAt(addr);
    if (!bar || this.state.inputInhibited !== 'none') return;
    bar.mdt = true;
    bar.increment = Math.max(0, Math.floor(increment));
    // The cursor goes onto the bar when the host asked for it, unless the selection cursor
    // is already in the list the bar belongs to (the host then knows which list to scroll).
    const inOwner = bar.owner !== undefined && this.screen.selectionAt(this.screen.cursor)?.sel.addr === bar.owner;
    if (bar.moveCursor && !inOwner) this.screen.cursor = bar.addr + (bar.horizontal ? 1 : this.screen.cols);
    const aid = bar.horizontal ? (forward ? AID_ROLL_RIGHT : AID_ROLL_LEFT) : forward ? AID_ROLL_UP : AID_ROLL_DOWN;
    this.sendAid(aid);
  }

  // ---- selection fields --------------------------------------------------

  /** The selection field whose choice the cursor is on, with the choice index. */
  private activeSelection(): { sel: GuiSelection; choice: number } | undefined {
    const hit = this.screen.selectionAt(this.screen.cursor);
    if (!hit) return undefined;
    if (hit.sel.cursor < 0) hit.sel.cursor = hit.choice;
    return { sel: hit.sel, choice: hit.sel.cursor };
  }

  /** Puts the selection cursor on a choice: the text cursor goes to its first text cell. */
  private enterSelection(sel: GuiSelection, idx: number): void {
    if (idx < 0) return;
    const c = sel.choices[idx]!;
    sel.cursor = idx;
    this.screen.cursor = this.screen.addr(c.row, c.textCol);
    refreshSelection(sel, this.screen);
  }

  /** Clears the selection cursor of the field the cursor is leaving, if any. */
  private leaveSelection(): void {
    for (const sel of this.screen.selections) {
      if (sel.cursor >= 0) {
        sel.cursor = -1;
        refreshSelection(sel, this.screen);
      }
    }
  }

  /**
   * Selects (or toggles, in a multiple choice field) the choice, refreshes the field and
   * runs auto-enter: the choice's own AID, or Enter, goes to the host at once.
   */
  private applyChoice(sel: GuiSelection, idx: number, toggle: boolean): void {
    const c = sel.choices[idx];
    if (!c || c.empty) return;
    if (c.state === 'unavailable') {
      this.error('0004');
      return;
    }
    let deselected = false;
    if (toggle && c.state === 'selected' && !isSingleChoice(sel.kind)) {
      deselectChoice(sel, idx);
      deselected = true;
    } else if (toggle && c.state === 'selected' && isSingleChoice(sel.kind)) {
      // Space on an already selected single choice deselects it.
      deselectChoice(sel, idx);
      deselected = true;
    } else {
      selectChoice(sel, idx);
    }
    refreshSelection(sel, this.screen);
    const numeric = sel.indicators === 'numeric1' || sel.indicators === 'numeric2';
    const autoEnter = sel.autoEnter === 1 || sel.autoEnter === 3 ? !deselected && !(sel.autoEnter === 3 && numeric) : sel.autoEnter === 2;
    if (autoEnter && !(numeric && sel.indicators === 'numeric2')) {
      const aid = !deselected && c.aid !== undefined && sel.autoSelect ? c.aid : AID.enter!;
      this.sendAid(aid);
    }
  }

  /** A pointer click on a choice: the selection cursor moves there and the choice is selected (as Space does). */
  clickChoice(sel: GuiSelection, idx: number): void {
    if (this.state.inputInhibited !== 'none' || sel.choices[idx]?.noCursor) return;
    this.leaveSelection();
    this.enterSelection(sel, idx);
    this.applyChoice(sel, idx, !isSingleChoice(sel.kind));
  }

  /** Keys that mean something inside a selection field; true when handled. */
  private selectionKey(action: KeyAction): boolean {
    const active = this.activeSelection();
    if (!active) return false;
    const { sel, choice } = active;
    const s = this.screen;
    const roll = (aid: number): void => {
      this.sendAid(aid);
    };
    const go = (idx: number): boolean => {
      if (idx < 0) return false;
      this.enterSelection(sel, idx);
      return true;
    };
    const c = sel.choices[choice]!;
    switch (action) {
      case 'left':
      case 'fastLeft':
        if (c.left) {
          roll(AID_ROLL_LEFT);
          return true;
        }
        if (go(stepChoice(sel, choice, -1))) return true;
        if (sel.keepCursor) return true;
        this.leaveSelection();
        s.cursor = s.addr(c.row, c.col);
        return false;
      case 'right':
      case 'fastRight':
        if (c.right) {
          roll(AID_ROLL_RIGHT);
          return true;
        }
        if (go(stepChoice(sel, choice, 1))) return true;
        if (sel.keepCursor) return true;
        this.leaveSelection();
        s.cursor = s.addr(c.row, c.textCol + c.textLen);
        return false;
      case 'up':
      case 'fastUp':
        if (c.top) {
          roll(AID_ROLL_DOWN);
          return true;
        }
        if (go(stepRow(sel, choice, -1))) return true;
        if (sel.keepCursor) return true;
        this.leaveSelection();
        return false;
      case 'down':
      case 'fastDown':
        if (c.last) {
          roll(AID_ROLL_UP);
          return true;
        }
        if (go(stepRow(sel, choice, 1))) return true;
        if (sel.keepCursor) return true;
        this.leaveSelection();
        return false;
      case 'tab':
      case 'fieldExit':
      case 'fieldPlus':
      case 'fieldMinus':
        if (sel.charAdvance && action === 'tab' && go(stepChoice(sel, choice, 1))) return true;
        this.moveToField(this.nextField(s.addr(sel.choices[0]!.row, sel.choices[0]!.col)));
        return true;
      case 'backtab':
        if (sel.charAdvance && go(stepChoice(sel, choice, -1))) return true;
        this.moveToField(this.prevField(s.addr(sel.choices[0]!.row, sel.choices[0]!.col)), true);
        return true;
      case 'delete':
        if (deselectChoice(sel, choice)) {
          refreshSelection(sel, s);
          if (sel.autoEnter === 2) this.sendAid(AID.enter!);
        }
        return true;
      case 'enter':
        if (sel.autoSelect && c.state !== 'selected' && c.state !== 'unavailable') {
          selectChoice(sel, choice);
          refreshSelection(sel, s);
        }
        return false; // the normal Enter follows
      case 'insert':
        return true;
      case 'beginningOfField':
      case 'endOfField':
      case 'eraseEof':
      case 'eraseField':
      case 'backspace':
      case 'deleteWord':
      case 'dup':
      case 'fieldMark':
        return true;
      default:
        return false;
    }
  }

  /** Typed characters inside a selection field: Space and / select, letters match mnemonics, digits numeric choices; true when handled. */
  private selectionType(ch: string): boolean {
    const active = this.activeSelection();
    if (!active) return false;
    const { sel, choice } = active;
    if (ch === ' ') {
      this.applyChoice(sel, choice, true);
      return true;
    }
    if (ch === '/') {
      this.applyChoice(sel, choice, false);
      return true;
    }
    if (sel.indicators === 'numeric1' || sel.indicators === 'numeric2') {
      const idx = sel.choices.findIndex((c) => !c.noCursor && c.digits !== undefined && c.digits.trim() === ch);
      if (idx >= 0) {
        this.enterSelection(sel, idx);
        this.applyChoice(sel, idx, false);
      } else {
        this.error('0004');
      }
      return true;
    }
    const idx = mnemonicChoice(sel, ch);
    if (idx >= 0) {
      this.enterSelection(sel, idx);
      this.applyChoice(sel, idx, false);
      return true;
    }
    this.error('0004');
    return true;
  }

  /**
   * A pointer event the host programmed (Programmable Mouse Buttons): `event` is the
   * 5250 event code (1 = left pressed ... 0x12 = shifted middle double click) at a cell.
   * Returns true when the event was taken (an AID went out or is pending), so the caller
   * does not also treat it as an ordinary click. A single event while the keyboard is
   * locked is kept when the definition says so and sent at the next unlock.
   */
  mouseEvent(event: number, row: number, col: number): boolean {
    const s = this.screen;
    const st = this.state;
    const pending = st.pendingMouse;
    if (pending) {
      if (pending.def.second !== event) return true; // still waiting for the trailing edge
      st.pendingMouse = undefined;
      if (st.inputInhibited !== 'none') return true;
      if (pending.def.moveCursor) s.cursor = s.addr(row, col);
      // Two-event inbound: cursor, X'80', where the first event was, then the host's AID
      // and (as for that AID) the field data.
      const data = this.processor.readResponse(st.pendingRead === 'input' ? 'input' : st.pendingRead === 'mdtAlt' ? 'mdtAlt' : 'mdt', pending.def.aid);
      const out = new Uint8Array(data.length + 3);
      out.set(data.subarray(0, 2), 0);
      out[2] = AID_TWO_EVENT;
      out[3] = pending.row + 1;
      out[4] = pending.col + 1;
      out.set(data.subarray(2), 5);
      st.pendingRead = undefined;
      st.inputInhibited = 'system';
      this.out.send(OP_PUT_GET, 0, out);
      return true;
    }
    const def = st.mouseButtons.find((d) => d.first === event);
    if (!def) return false;
    if (def.twoEvent) {
      if (st.inputInhibited !== 'none') return false;
      st.pendingMouse = { def, row, col };
      return true;
    }
    if (st.inputInhibited !== 'none') {
      if (def.queue) st.queuedMouse = { def, row, col };
      return true;
    }
    if (def.moveCursor) s.cursor = s.addr(row, col);
    this.sendAid(def.aid);
    return true;
  }

  /** Sends a host-defined AID (pull-down cancel, programmed buttons) with the usual read response. */
  pressAid(aid: number): void {
    if (this.state.inputInhibited !== 'none') return;
    this.sendAid(aid);
  }

  /** Sends a single mouse event kept while the keyboard was locked (called on unlock). */
  flushQueuedMouse(): void {
    const q = this.state.queuedMouse;
    if (!q || this.state.inputInhibited !== 'none') return;
    this.state.queuedMouse = undefined;
    if (q.def.moveCursor) this.screen.cursor = this.screen.addr(q.row, q.col);
    this.sendAid(q.def.aid);
  }

  private sendAid(aid: number): void {
    const s = this.screen;
    // A command attention key (DDS CAnn) returns the AID only: what was typed is not
    // sent, so the program cannot act on it, and mandatory-enter checks do not apply.
    const pf = pfNumber(aid);
    const attention = pf > 0 && (this.state.caKeys & (1 << (pf - 1))) !== 0;
    const missing = attention ? undefined : this.inputFields().find((f) => f.mandatoryEnter && !f.mdt);
    if (missing && aid !== AID.clear && aid !== AID.help) {
      s.cursor = missing.start;
      this.error('0007');
      return;
    }
    const kind = this.state.pendingRead === 'input' ? 'input' : this.state.pendingRead === 'mdtAlt' ? 'mdtAlt' : 'mdt';
    const data = attention ? this.processor.aidOnly(aid) : this.processor.readResponse(kind, aid);
    this.state.pendingRead = undefined;
    this.state.inputInhibited = 'system';
    this.out.send(OP_PUT_GET, 0, data);
  }
}
