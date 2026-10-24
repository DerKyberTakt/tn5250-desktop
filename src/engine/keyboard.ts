import type { CodePage } from './codepage';
import type { DataStreamProcessor } from './datastream';
import { FLAG_ATN, FLAG_SRQ, OP_NOOP, OP_PUT_GET } from './gds';
import type { Field, Screen } from './screen';
import type { TerminalState } from './state';
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

/** Operator error codes, as shown by 5250 displays. */
export const OPERATOR_ERRORS: Record<string, string> = {
  '0004': 'Data not allowed in this field',
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

const MOVEMENT_ACTIONS = new Set<KeyAction>(['tab', 'backtab', 'left', 'right', 'up', 'down', 'home', 'newline', 'endOfField']);

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
    if (this.state.inputInhibited !== 'none') return;
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
        this.out.send(OP_NOOP, FLAG_ATN, new Uint8Array(0));
        break;
      case 'sysreq':
        this.out.send(OP_NOOP, FLAG_SRQ, new Uint8Array(0));
        break;
      case 'printScreen':
        break; // handled by the UI
      default: {
        const aid = AID[action];
        if (aid !== undefined) this.sendAid(aid);
        break;
      }
    }
  }

  // ---- helpers -----------------------------------------------------------

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

  private firstField(): Field | undefined {
    return this.inputFields()[0];
  }

  private nextField(from: number): Field | undefined {
    const fields = this.inputFields();
    const here = fields.find((f) => f.contains(from));
    const after = fields.find((f) => f.start > from && f !== here);
    return after ?? fields[0];
  }

  private prevField(from: number): Field | undefined {
    const fields = this.inputFields();
    const before = [...fields].reverse().find((f) => f.start < from && !f.contains(from));
    return before ?? fields[fields.length - 1];
  }

  private moveToField(f: Field | undefined): void {
    if (f) this.screen.cursor = f.start;
  }

  private moveCursor(delta: number): void {
    const size = this.screen.size;
    this.screen.cursor = (((this.screen.cursor + delta) % size) + size) % size;
  }

  private backtab(): void {
    const f = this.currentField();
    if (f && this.screen.cursor > f.start) {
      this.screen.cursor = f.start;
      return;
    }
    this.moveToField(this.prevField(this.screen.cursor));
  }

  private newline(): void {
    const s = this.screen;
    const row = (s.rowOf(s.cursor) + 1) % s.rows;
    s.cursor = s.addr(row, 0);
    if (!this.currentField()) {
      const next = this.inputFields().find((f) => f.start >= s.cursor) ?? this.firstField();
      this.moveToField(next);
    }
  }

  private typeChar(ch: string): void {
    if (this.state.inputInhibited !== 'none') return;
    const s = this.screen;
    const f = this.currentField();
    if (!f) {
      this.error('0005');
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
      const last = s.buffer[f.end - 1];
      if (last !== EBCDIC_NULL && last !== EBCDIC_BLANK) {
        this.error('0012');
        return;
      }
      s.buffer.copyWithin(cursor + 1, cursor, f.end - 1);
    }
    s.buffer[cursor] = byte;
    f.mdt = true;
    if (cursor + 1 < f.end) {
      s.cursor = cursor + 1;
      return;
    }
    if (f.autoEnter) {
      this.sendAid(AID_AUTO_ENTER);
      return;
    }
    if (f.fieldExitRequired) {
      // Shown on the last cell, logically past it: Field Exit keeps this character.
      this.state.cursorPastEnd = true;
      return;
    }
    const next = this.nextField(f.end - 1);
    if (next) this.state.autoAdvanced = true;
    this.moveToField(next);
  }

  /** End of Field: the cursor goes just after the last typed character of the field. */
  private endOfField(): void {
    const s = this.screen;
    const f = this.currentField();
    if (!f) {
      this.error('0005');
      return;
    }
    let end = f.end;
    while (end > f.start && (s.buffer[end - 1] === EBCDIC_NULL || s.buffer[end - 1] === EBCDIC_BLANK)) end -= 1;
    if (end >= f.end) {
      // Full: the last cell, past the end (a Field Exit now keeps the text).
      s.cursor = f.end - 1;
      this.state.cursorPastEnd = true;
    } else {
      s.cursor = end;
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
    const f = this.currentField();
    // Past the end of a full field the cursor is after the last character: Backspace
    // removes that character (PC style, like everywhere else in the field).
    if (f && this.pastEnd) {
      s.buffer[f.end - 1] = EBCDIC_NULL;
      f.mdt = true;
      return;
    }
    if (f && s.cursor > f.start) {
      s.cursor -= 1;
      s.buffer.copyWithin(s.cursor, s.cursor + 1, f.end);
      s.buffer[f.end - 1] = EBCDIC_NULL;
      f.mdt = true;
    }
    // At the start of a field, or outside any field, Backspace does nothing.
  }

  private deleteChar(): void {
    const s = this.screen;
    const f = this.currentField();
    if (!f) {
      this.error('0005');
      return;
    }
    s.buffer.copyWithin(s.cursor, s.cursor + 1, f.end);
    s.buffer[f.end - 1] = EBCDIC_NULL;
    f.mdt = true;
  }

  private eraseEof(): void {
    const f = this.currentField();
    if (!f) {
      this.error('0005');
      return;
    }
    this.screen.buffer.fill(EBCDIC_NULL, this.pastEnd ? this.screen.cursor + 1 : this.screen.cursor, f.end);
    f.mdt = true;
  }

  private eraseInput(): void {
    for (const f of this.inputFields()) {
      this.screen.buffer.fill(EBCDIC_NULL, f.start, f.end);
      f.mdt = false;
    }
    this.moveToField(this.firstField());
  }

  private dup(): void {
    const f = this.currentField();
    if (!f || !f.dupEnable) {
      this.error('0019');
      return;
    }
    this.screen.buffer.fill(EBCDIC_DUP, this.pastEnd ? this.screen.cursor + 1 : this.screen.cursor, f.end);
    f.mdt = true;
    this.moveToField(this.nextField(f.end - 1));
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

  private sendAid(aid: number): void {
    const s = this.screen;
    const missing = this.inputFields().find((f) => f.mandatoryEnter && !f.mdt);
    if (missing && aid !== AID.clear && aid !== AID.help) {
      s.cursor = missing.start;
      this.error('0007');
      return;
    }
    const kind = this.state.pendingRead === 'input' ? 'input' : this.state.pendingRead === 'mdtAlt' ? 'mdtAlt' : 'mdt';
    const data = this.processor.readResponse(kind, aid);
    this.state.pendingRead = undefined;
    this.state.inputInhibited = 'system';
    this.out.send(OP_PUT_GET, 0, data);
  }
}
