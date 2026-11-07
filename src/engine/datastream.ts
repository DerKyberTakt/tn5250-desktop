import { ATTR_NORMAL, isAttribute } from './attributes';
import type { CodePage } from './codepage';
import { OP_NOOP, OP_PUT_GET, OP_SAVE_SCREEN } from './gds';
import { Field, type GuiScrollBar, type GuiText, type GuiWindow, Screen } from './screen';
import { firstCursorChoice, layoutSelection, parseSelection, refreshSelection, selectionBytes, selectionRightEdge, writeSelection, type GuiSelection } from './selection';
import type { ReadKind, TerminalState } from './state';

export const ESC = 0x04;

/** Display commands (the byte after ESC). */
export const CMD_WTD = 0x11;
export const CMD_CLEAR_UNIT = 0x40;
export const CMD_CLEAR_UNIT_ALT = 0x20;
export const CMD_CLEAR_FORMAT_TABLE = 0x50;
export const CMD_READ_INPUT_FIELDS = 0x42;
export const CMD_READ_MDT_FIELDS = 0x52;
export const CMD_READ_MDT_FIELDS_ALT = 0x82;
export const CMD_READ_IMMEDIATE = 0x72;
export const CMD_READ_IMMEDIATE_ALT = 0x83;
export const CMD_READ_SCREEN = 0x62;
export const CMD_READ_SCREEN_EXT = 0x64;
/** Read Screen (to Print): the host wants the image after a Print key (AID F6) to spool it; same answer as Read Screen. */
export const CMD_READ_SCREEN_TO_PRINT = 0x66;
export const CMD_READ_SCREEN_EXT_TO_PRINT = 0x6e;
export const CMD_SAVE_SCREEN = 0x02;
export const CMD_SAVE_PARTIAL_SCREEN = 0x03;
export const CMD_RESTORE_SCREEN = 0x12;
export const CMD_RESTORE_PARTIAL_SCREEN = 0x13;
export const CMD_ROLL = 0x23;
export const CMD_WRITE_ERROR_CODE = 0x21;
export const CMD_WRITE_ERROR_CODE_WINDOW = 0x22;
export const CMD_WSF = 0xf3;
export const CMD_COPY_TO_PRINTER = 0x16;

/** Write To Display orders. */
const O_SOH = 0x01;
const O_RA = 0x02;
const O_EA = 0x03;
const O_TD = 0x10;
const O_SBA = 0x11;
const O_WEA = 0x12;
const O_IC = 0x13;
const O_MC = 0x14;
const O_WDSF = 0x15;
const O_SF = 0x1d;

/** A record the terminal must send back, before GDS framing. */
export interface Response {
  opcode: number;
  data: Uint8Array;
}

export interface ProcessEvents {
  alarm?: () => void;
  /** Debug hook: one line per command/order (used by the dump tool). */
  trace?: (line: string) => void;
}

export interface TerminalInfo {
  /** Negotiated terminal type, e.g. IBM-3477-FC. */
  terminalType: string;
  /**
   * Answer the Query as an enhanced-interface device (the normal case, as ACS): the host
   * then draws DDS windows with the Create Window structured field (border by the
   * terminal, covered area restored on Remove GUI Window) instead of plain text that
   * stays behind. False only for tests of the plain reply.
   */
  enhanced?: boolean;
}

/** Structured field types of class D9 that the enhanced interface brings. */
const WDSF_DEFINE_SELECTION = 0x50;
const WDSF_CREATE_WINDOW = 0x51;
const WDSF_UNRESTRICTED_CURSOR = 0x52;
const WDSF_DEFINE_SCROLL_BAR = 0x53;
const WDSF_WRITE_DATA = 0x54;
const WDSF_MOUSE_BUTTONS = 0x55;
const WDSF_REMOVE_GUI_WINDOW = 0x59;
const WDSF_REMOVE_GUI_SCROLL_BAR = 0x5b;
const WDSF_REMOVE_ALL_GUI = 0x5f;

/** Roll AIDs a scroll bar sends: toward the end (Roll Up / Roll Right) or back (Roll Down / Roll Left). */
export const AID_ROLL_UP = 0xf5;
export const AID_ROLL_DOWN = 0xf4;
export const AID_ROLL_LEFT = 0xd9;
export const AID_ROLL_RIGHT = 0xda;

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
  get remaining(): number {
    return Math.max(0, this.buf.length - this.pos);
  }
  peek(): number {
    return this.buf[this.pos] ?? 0;
  }
  peekBytes(n: number): Uint8Array {
    return this.buf.subarray(this.pos, this.pos + n);
  }
  u8(): number {
    const b = this.buf[this.pos] ?? 0;
    this.pos += 1;
    return b;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  bytes(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, Math.min(this.buf.length, this.pos + n));
    this.pos += n;
    return out;
  }
  skipToEsc(): void {
    while (!this.eof && this.peek() !== ESC) this.pos += 1;
  }
}

/**
 * Executes host display commands against the screen buffer and terminal state.
 * One instance per session; `process` handles the payload of one GDS record.
 */
export class DataStreamProcessor {
  /** Current write address for WTD orders. */
  private addr = 0;
  /** Whether an IC/MC order positioned the cursor since the last read command. */
  private cursorSet = false;

  constructor(
    readonly screen: Screen,
    readonly state: TerminalState,
    private readonly info: TerminalInfo,
    private readonly codePage: CodePage,
    private readonly events: ProcessEvents = {},
  ) {}

  process(data: Uint8Array): Response[] {
    const r = new Reader(data);
    const out: Response[] = [];
    // Anything the host writes ends the keyboard's "past the end of the field" state.
    this.state.cursorPastEnd = false;
    this.state.autoAdvanced = false;
    while (!r.eof) {
      if (r.u8() !== ESC) continue;
      if (r.eof) break;
      const cmd = r.u8();
      this.events.trace?.(`cmd ${cmd.toString(16)} @${r.pos}`);
      switch (cmd) {
        case CMD_WTD: {
          const cc1 = r.u8();
          const cc2 = r.u8();
          this.applyCC1(cc1);
          // The host is repainting: an error line written by Write Error Code goes back to
          // what it covered (the host does not rewrite that row for a message it did not
          // write itself), and the cursor returns to where the operator was.
          this.restoreErrorLine();
          this.writeOrders(r);
          this.applyCC2(cc2);
          break;
        }
        case CMD_CLEAR_UNIT:
          this.clearUnit(24, 80);
          break;
        case CMD_CLEAR_UNIT_ALT: {
          const param = r.u8();
          if (param === 0x00 || param === 0x31) this.clearUnit(27, 132);
          else this.clearUnit(24, 80);
          break;
        }
        case CMD_CLEAR_FORMAT_TABLE:
          this.screen.clearFormatTable();
          break;
        case CMD_READ_INPUT_FIELDS:
        case CMD_READ_MDT_FIELDS:
        case CMD_READ_MDT_FIELDS_ALT: {
          const cc1 = r.u8();
          const cc2 = r.u8();
          this.applyCC1(cc1);
          this.applyCC2(cc2);
          const kind: ReadKind =
            cmd === CMD_READ_INPUT_FIELDS ? 'input' : cmd === CMD_READ_MDT_FIELDS ? 'mdt' : 'mdtAlt';
          this.state.pendingRead = kind;
          this.state.inputInhibited = 'none';
          // Home unless an Insert Cursor placed the cursor. A cursor at the top-left corner
          // outside any input field counts as not placed: a restored image of a screen that
          // was written but never read carries IC 1,1, and the window it came back from
          // must not leave the operator there.
          const at0 = this.screen.fieldAt(0);
          // After a Write Error Code the operator stays where the error happened.
          const afterError = this.state.savedCursor !== undefined;
          if (!afterError && (!this.cursorSet || (this.screen.cursor === 0 && !(at0 && !at0.bypass)))) this.homeCursor();
          this.cursorSet = false;
          this.snapToSelection();
          break;
        }
        case CMD_READ_IMMEDIATE:
          out.push({ opcode: OP_PUT_GET, data: this.readResponse('input', 0x00) });
          break;
        case CMD_READ_IMMEDIATE_ALT:
          out.push({ opcode: OP_PUT_GET, data: this.readResponse('mdtAlt', 0x00) });
          break;
        case CMD_READ_SCREEN:
        case CMD_READ_SCREEN_TO_PRINT:
          // Without an answer the host keeps the keyboard locked (X SYSTEM) after the Print key.
          out.push({ opcode: OP_NOOP, data: this.screen.buffer.slice() });
          break;
        case CMD_READ_SCREEN_EXT:
        case CMD_READ_SCREEN_EXT_TO_PRINT:
          out.push({ opcode: OP_NOOP, data: this.readScreenExtended() });
          break;
        case CMD_SAVE_SCREEN:
          out.push({ opcode: OP_SAVE_SCREEN, data: this.saveScreen() });
          break;
        case CMD_SAVE_PARTIAL_SCREEN:
          // flags, top row, left column, depth, width: the host wants the area a window
          // will cover. The whole screen comes back (tn5250 does the same); the restore
          // then repaints everything, which is a superset of what was asked for.
          r.bytes(5);
          out.push({ opcode: OP_SAVE_SCREEN, data: this.saveScreen(CMD_RESTORE_PARTIAL_SCREEN) });
          break;
        case CMD_RESTORE_SCREEN:
          // The saved image that follows replaces everything, including the
          // format table left behind by whatever screen was shown meanwhile.
          this.screen.clear();
          this.addr = 0;
          this.state.savedCursor = undefined;
          this.state.savedErrorRow = undefined;
          this.state.mouseButtons = [];
          this.state.pendingMouse = undefined;
          this.state.queuedMouse = undefined;
          break;
        case CMD_RESTORE_PARTIAL_SCREEN:
          // The image that follows is a full write of what the host saved; whatever
          // windows and scroll bars were open on top are gone with it.
          this.screen.windows = [];
          this.screen.scrollBars = [];
          break;
        case CMD_ROLL: {
          const b = r.u8();
          const top = r.u8();
          const bottom = r.u8();
          const n = b & 0x1f;
          this.screen.roll((b & 0x80) === 0 ? n : -n, top - 1, bottom - 1);
          break;
        }
        case CMD_WRITE_ERROR_CODE:
          this.writeErrorCode(r);
          break;
        case CMD_WRITE_ERROR_CODE_WINDOW:
          r.u8();
          r.u8();
          this.writeErrorCode(r);
          break;
        case CMD_WSF: {
          // One WSF carries one or more structured fields (LL, class, type, data), each
          // walked by its length: a X'04' inside one is data, not the next ESC.
          while (r.remaining >= 4 && r.peek() !== ESC) {
            const ll = r.u16();
            const cls = r.u8();
            const type = r.u8();
            if (ll < 4) break;
            r.bytes(Math.min(ll - 4, r.remaining));
            if (cls === 0xd9 && type === 0x70) {
              out.push({ opcode: OP_NOOP, data: this.queryReply() });
            }
          }
          break;
        }
        case CMD_COPY_TO_PRINTER:
        default:
          r.skipToEsc();
          break;
      }
    }
    return out;
  }

  /**
   * Byte ranges [start, end) of the last read response that came from non-display fields
   * (passwords): a trace must not keep them. Cleared by every response builder.
   */
  secretRanges: Array<[number, number]> = [];

  /** The ranges of the last response, handed over once. */
  takeSecretRanges(): Array<[number, number]> {
    const ranges = this.secretRanges;
    this.secretRanges = [];
    return ranges;
  }

  /** The response of a command attention key: cursor and AID, no field data. */
  aidOnly(aid: number): Uint8Array {
    const s = this.screen;
    this.secretRanges = [];
    return Uint8Array.from([s.rowOf(s.cursor) + 1, s.colOf(s.cursor) + 1, aid]);
  }

  /**
   * Builds the AID response for the pending read (or the kind given). Entry fields and
   * scroll bars come back in screen order; a scroll bar is 4 bytes (the scroll increment
   * set by pointer use), after an SBA of its own address on MDT reads, and only when its
   * MDT is on. Reporting resets the bar's increment and MDT, as the host redefines it.
   */
  readResponse(kind: ReadKind, aid: number): Uint8Array {
    const s = this.screen;
    const out: number[] = [s.rowOf(s.cursor) + 1, s.colOf(s.cursor) + 1, aid];
    const secret: Array<[number, number]> = [];
    this.secretRanges = secret;
    type Entry = { addr: number; field?: Field; bar?: GuiScrollBar; sel?: GuiSelection };
    // A continued entry field set goes out as one field: its first segment's SBA, then the
    // data of every segment with no delimiters; the other segments are not listed.
    const entries: Entry[] = [
      ...s.fields.filter((f) => !f.bypass && (!f.continued || f.continued === 'first' || s.segmentsOf(f)[0] === f)).map((f) => ({ addr: f.start - 1, field: f })),
      ...s.scrollBars.filter((b) => b.owner === undefined).map((b) => ({ addr: b.addr, bar: b })),
      ...s.selections.map((x) => ({ addr: x.addr, sel: x })),
    ].sort((a, b) => a.addr - b.addr);
    const increment = (bar: GuiScrollBar | undefined): void => {
      const n = (bar?.increment ?? 0) >>> 0;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      if (bar) {
        bar.increment = 0;
        bar.mdt = false;
      }
    };
    for (const { field: f, bar, sel } of entries) {
      if (sel) {
        // A selection field: the choice number or one byte per choice, then the scroll
        // increment of its list; on MDT reads only when the field's MDT is on, after an SBA
        // of the cell past the field address.
        const ownBar = sel.scrollBarAddr !== undefined ? s.scrollBarAt(sel.scrollBarAddr) : undefined;
        if (kind !== 'input' && !sel.mdt && !ownBar?.mdt) continue;
        if (kind !== 'input') out.push(O_SBA, s.rowOf(sel.addr + 1) + 1, s.colOf(sel.addr + 1) + 1);
        out.push(...selectionBytes(sel));
        if (sel.scrollBarAddr !== undefined) increment(ownBar);
        continue;
      }
      if (bar) {
        if (kind !== 'input' && !bar.mdt) continue;
        if (kind !== 'input') out.push(O_SBA, s.rowOf(bar.addr) + 1, s.colOf(bar.addr) + 1);
        increment(bar);
        continue;
      }
      if (!f) continue;
      const set = f.continued ? s.segmentsOf(f) : [f];
      const wordWrap = set[0]!.wordWrap;
      // The data of the whole set; a word wrap field drops its padding nulls (Read Input
      // Fields still returns exactly the field length, padded with nulls at the end).
      let bytes = Array.from(s.cellsOf(set), (a) => s.buffer[a] as number);
      if (wordWrap) {
        const n = bytes.length;
        bytes = bytes.filter((b) => b !== 0);
        if (kind === 'input') while (bytes.length < n) bytes.push(0);
      }
      const nondisplay = (set[0]!.attr & 0x07) === 0x07;
      if (kind === 'input') {
        if (nondisplay) secret.push([out.length, out.length + bytes.length]);
        for (const b of bytes) out.push(b === 0 ? 0x40 : b);
        continue;
      }
      if (!set.some((g) => g.mdt)) continue;
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end -= 1;
      if (kind === 'mdt') {
        while (end > 0 && bytes[end - 1] === 0x40) end -= 1;
      }
      out.push(O_SBA, s.rowOf(f.start) + 1, s.colOf(f.start) + 1);
      if (nondisplay) secret.push([out.length, out.length + end]);
      for (let i = 0; i < end; i++) {
        const b = bytes[i] as number;
        out.push(b === 0 && kind === 'mdt' ? 0x40 : b);
      }
    }
    return Uint8Array.from(out);
  }

  private clearUnit(rows: number, cols: number): void {
    this.screen.setSize(rows, cols);
    this.addr = 0;
    this.cursorSet = false;
    this.state.inputInhibited = 'system';
    this.state.insert = false;
    this.state.errorMessage = '';
    this.state.savedCursor = undefined;
    this.state.savedErrorRow = undefined;
    this.state.pendingRead = undefined;
    this.state.caKeys = 0;
    this.state.mouseButtons = [];
    this.state.pendingMouse = undefined;
    this.state.queuedMouse = undefined;
  }

  private put(b: number): void {
    this.screen.buffer[this.addr] = b;
    this.addr = (this.addr + 1) % this.screen.size;
  }

  private writeOrders(r: Reader): void {
    const s = this.screen;
    while (!r.eof && r.peek() !== ESC) {
      const b = r.u8();
      if (b < 0x20 && this.events.trace) {
        this.events.trace(`  order ${b.toString(16)} at ${s.rowOf(this.addr) + 1},${s.colOf(this.addr) + 1} next=${Array.from(r.peekBytes(6), (x) => x.toString(16).padStart(2, '0')).join(' ')}`);
      }
      switch (b) {
        case O_SBA:
          this.addr = s.addrFromStream(r.u8(), r.u8());
          break;
        case O_IC:
        case O_MC:
          s.cursor = s.addrFromStream(r.u8(), r.u8());
          this.cursorSet = true;
          break;
        case O_RA: {
          const end = s.addrFromStream(r.u8(), r.u8());
          const fill = r.u8();
          this.fillTo(end, fill);
          break;
        }
        case O_EA: {
          const end = s.addrFromStream(r.u8(), r.u8());
          const len = r.u8();
          r.bytes(Math.max(0, len - 1));
          this.fillTo(end, 0x00);
          break;
        }
        case O_TD: {
          const len = r.u16();
          for (const d of r.bytes(len)) this.put(d);
          break;
        }
        case O_SOH: {
          const len = r.u8();
          const data = r.bytes(len);
          s.clearFormatTable();
          // A new header starts a new format: an Insert Cursor received before it (for
          // instance the saved cursor replayed by Restore Screen) no longer places the
          // cursor, so the next read homes to the first input field unless this format
          // carries its own IC. That is what a menu redrawn after F3/F12 relies on.
          this.cursorSet = false;
          const errRow = data[3];
          if (errRow !== undefined && errRow > 0 && errRow <= s.rows) s.errorRow = errRow - 1;
          // Command key switches (bytes 4-6: F17-24, F9-16, F1-8; F1 = low bit of the last
          // byte; a set bit = the key returns no data, i.e. a DDS CA key). Absent = all CF.
          this.state.caKeys = data.length >= 7 ? ((data[4]! << 16) | (data[5]! << 8) | data[6]!) >>> 0 : 0;
          break;
        }
        case O_SF:
          this.startField(r);
          break;
        case O_WEA:
          r.bytes(2);
          break;
        case O_WDSF: {
          const ll = r.u16();
          const body = r.bytes(Math.max(0, ll - 2));
          if (body[0] === 0xd9) this.structuredField(body[1] ?? 0, body.subarray(2));
          break;
        }
        default:
          this.put(b);
          break;
      }
    }
  }

  /** Write Display Structured Fields of the enhanced interface; others are ignored. */
  private structuredField(type: number, data: Uint8Array): void {
    switch (type) {
      case WDSF_CREATE_WINDOW:
        this.createWindow(data);
        break;
      case WDSF_DEFINE_SCROLL_BAR:
        this.defineScrollBar(data);
        break;
      case WDSF_UNRESTRICTED_CURSOR:
        for (const w of this.screen.windows) w.restrictCursor = false;
        break;
      case WDSF_WRITE_DATA:
        this.writeData(data);
        break;
      case WDSF_MOUSE_BUTTONS:
        this.mouseButtons(data);
        break;
      case WDSF_DEFINE_SELECTION:
        this.defineSelection(data);
        break;
      case 0x58: // Remove GUI Selection Field: the construct at the current address goes, the screen stays.
        this.removeSelection(this.addr);
        break;
      case WDSF_REMOVE_GUI_WINDOW:
        this.removeWindow();
        break;
      case WDSF_REMOVE_GUI_SCROLL_BAR:
        this.screen.scrollBars = this.screen.scrollBars.filter((b) => b.addr !== this.addr);
        break;
      case WDSF_REMOVE_ALL_GUI:
        while (this.screen.windows.length > 0) this.removeWindow();
        this.screen.scrollBars = [];
        this.screen.selections = [];
        break;
      default:
        break;
    }
  }

  /**
   * Define Selection Field at the current write address: the choices are laid out and
   * written into the buffer as a character display would show them (attribute cells,
   * radio/check indicators, push button characters); a list with TotalRows/SliderPos gets
   * a scroll bar at its right edge that reports with the field. The address is not moved.
   */
  private defineSelection(data: Uint8Array): void {
    const s = this.screen;
    const sel = parseSelection(data, this.addr, this.codePage);
    if (!sel) return;
    layoutSelection(sel, s);
    const lastRow = Math.max(...sel.choices.map((c) => c.row), sel.separator?.row ?? 0);
    const edge = selectionRightEdge(sel);
    if (lastRow >= s.rows || edge + (sel.total !== undefined ? 2 : 0) > s.cols) return;
    const previous = s.selections.find((x) => x.addr === sel.addr);
    if (previous?.scrollBarAddr !== undefined) s.scrollBars = s.scrollBars.filter((b) => b.addr !== previous.scrollBarAddr);
    writeSelection(sel, s, this.codePage);
    if (sel.total !== undefined && sel.pos !== undefined && sel.kind !== 'menuBar') {
      const row = s.rowOf(sel.addr);
      const bar: GuiScrollBar = {
        addr: s.addr(row, edge - 1),
        horizontal: false,
        moveCursor: true,
        mdt: false,
        total: sel.total,
        pos: sel.pos,
        size: sel.rows,
        increment: 0,
        owner: sel.addr,
      };
      if (sel.rows >= 3 && row + sel.rows <= s.rows) {
        for (let r = 0; r < sel.rows; r++) {
          s.buffer[s.addr(row + r, edge - 1)] = 0x22; // white: the leading scroll bar attribute of a GUI-like display
          s.buffer[s.addr(row + r, edge)] = 0;
          s.buffer[s.addr(row + r, edge + 1)] = ATTR_NORMAL;
        }
        s.addScrollBar(bar);
        sel.scrollBarAddr = bar.addr;
      }
    }
    // A redefinition keeps the selection cursor where it was.
    if (previous && previous.cursor >= 0 && s.selectionAt(s.cursor)?.sel === previous) {
      sel.cursor = Math.min(previous.cursor, sel.choices.length - 1);
      if (sel.choices[sel.cursor]?.noCursor) sel.cursor = firstCursorChoice(sel);
    }
    s.addSelection(sel);
  }

  private removeSelection(addr: number): void {
    const s = this.screen;
    const sel = s.selections.find((x) => x.addr === addr);
    if (!sel) return;
    s.selections = s.selections.filter((x) => x !== sel);
    if (sel.scrollBarAddr !== undefined) s.scrollBars = s.scrollBars.filter((b) => b.addr !== sel.scrollBarAddr);
  }

  /**
   * Define Scroll Bar Field: flags (bit 0 horizontal, bit 1 move the cursor onto the bar
   * when the pointer uses it, bit 7 MDT), reserved, total rows/columns (4 bytes), slider
   * position (4 bytes), rows or columns the bar occupies, then optional minor structures
   * (0x03 scroll bar indicators: characters and highlighting, which the terminal draws its
   * own way). The bar sits at the current write address: a vertical bar is 3 columns wide
   * (attribute, bar, attribute), a horizontal one 1 row. The cells under it are blanked so
   * the terminal can draw the bar; the address is not moved.
   */
  private defineScrollBar(data: Uint8Array): void {
    const s = this.screen;
    if (data.length < 11) return;
    const flags = data[0] as number;
    const u32 = (i: number): number => (((data[i] as number) << 24) | ((data[i + 1] as number) << 16) | ((data[i + 2] as number) << 8) | (data[i + 3] as number)) >>> 0;
    const horizontal = (flags & 0x80) !== 0;
    const size = data[10] as number;
    const row = s.rowOf(this.addr);
    const col = s.colOf(this.addr);
    if (size < (horizontal ? 7 : 3)) return;
    if (horizontal ? col + size > s.cols : row + size > s.rows || col + 3 > s.cols) return;
    const bar: GuiScrollBar = {
      addr: this.addr,
      horizontal,
      moveCursor: (flags & 0x40) !== 0,
      mdt: (flags & 0x01) !== 0,
      total: u32(2),
      pos: u32(6),
      size,
      increment: 0,
    };
    if (horizontal) {
      s.buffer[s.addr(row, col)] = ATTR_NORMAL;
      s.buffer.fill(0, s.addr(row, col + 1), s.addr(row, col + size - 1));
      s.buffer[s.addr(row, col + size - 1)] = ATTR_NORMAL;
    } else {
      for (let r = 0; r < size; r++) {
        s.buffer[s.addr(row + r, col)] = ATTR_NORMAL;
        s.buffer[s.addr(row + r, col + 1)] = 0;
        s.buffer[s.addr(row + r, col + 2)] = ATTR_NORMAL;
      }
    }
    s.addScrollBar(bar);
  }

  /**
   * Create Window: flags, 2 reserved, depth, width, then minor structures (length,
   * type, ...): 0x01 border presentation = flags, monochrome attribute, colour
   * attribute, 8 border characters (upper-left, top, upper-right, left, right,
   * lower-left, bottom, lower-right); 0x10 title/footer (handled). The window sits at
   * the current write address and is laid out like the text windows the host draws
   * for a plain terminal: attribute, border character, attribute, `width` cells,
   * attribute, border character, attribute; `depth` rows between a top and a bottom
   * border row.
   */
  private createWindow(data: Uint8Array): void {
    const s = this.screen;
    const depth = data[3] ?? 0;
    const width = data[4] ?? 0;
    if (depth === 0 || width === 0) return;
    let attr = 0x3b; // blue reverse image, the DDS WDWBORDER default colour
    const chars = [0x6d, 0x6d, 0x6d, 0x4f, 0x4f, 0x6d, 0x6d, 0x6d]; // '_' and '|'
    let title: GuiText | undefined;
    let footer: GuiText | undefined;
    let i = 5;
    while (i < data.length) {
      const len = data[i] ?? 0;
      const type = data[i + 1] ?? 0;
      if (len < 2) break;
      if (type === 0x01) {
        const mono = data[i + 3];
        const colour = data[i + 4];
        if (colour !== undefined && isAttribute(colour)) attr = colour;
        else if (mono !== undefined && isAttribute(mono)) attr = mono;
        for (let k = 0; k < 8; k++) {
          const c = data[i + 5 + k];
          if (c !== undefined && c !== 0x00) chars[k] = c;
        }
      } else if (type === 0x10 && len > 6) {
        // Title/footer: flags (bits 0-1 orientation: 00 centred, 01 right, 10 left; bit 2
        // footer), monochrome attribute, colour attribute, reserved, text.
        const flags = data[i + 2] ?? 0;
        const orientation = (flags >> 6) & 0x03;
        const text = this.codePage.decodeBytes(data, i + 6, i + len).split(String.fromCharCode(0)).join(' ').trim();
        const entry: GuiText = { text, align: orientation === 1 ? 'right' : orientation === 2 ? 'left' : 'center' };
        if ((flags & 0x20) !== 0) footer = entry;
        else title = entry;
      }
      i += len;
    }
    const row = s.rowOf(this.addr);
    const col = s.colOf(this.addr);
    const rows = Math.min(depth + 2, s.rows - row);
    const cols = Math.min(width + 6, s.cols - col);
    if (rows <= 0 || cols <= 0) return;
    const saved = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) saved.set(s.buffer.subarray(s.addr(row + r, col), s.addr(row + r, col + cols)), r * cols);
    const touches = (f: Field): boolean => {
      for (let r = 0; r < rows; r++) {
        const a = s.addr(row + r, col);
        if (f.start - 1 < a + cols && f.end > a) return true;
      }
      return false;
    };
    const savedFields = s.fields.filter(touches);
    s.fields = s.fields.filter((f) => !touches(f));
    const win: GuiWindow = { row, col, depth, width, rows, cols, saved, savedFields, title, footer, restrictCursor: ((data[0] ?? 0) & 0x80) !== 0, wdsf: data.slice() };
    // Draw: every rectangle cell starts as null, then the border.
    for (let r = 0; r < rows; r++) s.buffer.fill(0, s.addr(row + r, col), s.addr(row + r, col + cols));
    const put = (r: number, c: number, b: number): void => {
      if (r < rows && c < cols) s.buffer[s.addr(row + r, col + c)] = b;
    };
    const [ul, top, ur, left, right, ll, bottom, lr] = chars as [number, number, number, number, number, number, number, number];
    const line = (r: number, first: number, mid: number, last: number): void => {
      put(r, 0, attr);
      put(r, 1, first);
      for (let c = 2; c < width + 4; c++) put(r, c, mid);
      put(r, width + 4, last);
      put(r, width + 5, 0x20);
    };
    line(0, ul, top, ur);
    for (let r = 1; r <= depth; r++) {
      put(r, 0, attr);
      put(r, 1, left);
      put(r, 2, 0x20);
      put(r, width + 3, attr);
      put(r, width + 4, right);
      put(r, width + 5, 0x20);
    }
    line(depth + 1, ll, bottom, lr);
    // The title sits in the top border, the footer in the bottom one, as the 5494 writes
    // them for a character display; the enhanced renderer draws them its own way.
    const writeText = (r: number, t: GuiText | undefined): void => {
      if (!t?.text) return;
      const room = width + 2; // cells between the corner characters
      const text = this.codePage.encodeString(t.text.slice(0, room));
      const start = t.align === 'left' ? 0 : t.align === 'right' ? room - text.length : Math.floor((room - text.length) / 2);
      for (let k = 0; k < text.length; k++) put(r, 2 + start + k, text[k] as number);
    };
    writeText(0, title);
    writeText(depth + 1, footer);
    s.windows.push(win);
  }

  /**
   * Write Data: flag (bit 0 must be on), reserved, then the data for the entry field whose
   * first position is the current write address; the rest of the field is nulled. The
   * address does not move. (Continued and word-wrap fields: see the FCW support.)
   */
  private writeData(data: Uint8Array): void {
    const s = this.screen;
    if (data.length < 2 || ((data[0] as number) & 0x80) === 0) return;
    const f = s.fields.find((x) => x.start === this.addr);
    if (!f) return;
    const text = data.subarray(2);
    if (text.length > f.length) return;
    s.buffer.fill(0, f.start, f.end);
    for (let i = 0; i < text.length; i++) {
      const b = text[i] as number;
      s.buffer[f.start + i] = b;
    }
  }

  /**
   * Programmable Mouse Buttons: 3 reserved bytes then 4-byte event definitions (flags:
   * bit 0 two-event, bit 1 move the cursor, bit 2 queue while locked, bit 3 marker box;
   * first event; second event; AID). Every structured field replaces the whole table;
   * none = the table is cleared.
   */
  private mouseButtons(data: Uint8Array): void {
    const defs = [];
    for (let i = 3; i + 4 <= data.length; i += 4) {
      const flags = data[i] as number;
      const first = data[i + 1] as number;
      const second = data[i + 2] as number;
      const aid = data[i + 3] as number;
      if (first === 0 || first > 0x12) continue;
      defs.push({
        twoEvent: (flags & 0x80) !== 0,
        moveCursor: (flags & 0x40) !== 0,
        queue: (flags & 0x20) !== 0,
        marker: (flags & 0x10) !== 0,
        first,
        second,
        aid,
      });
    }
    this.state.mouseButtons = defs;
    this.state.pendingMouse = undefined;
    this.state.queuedMouse = undefined;
  }

  /** Remove GUI Window: the newest window goes, and what it covered comes back. */
  private removeWindow(): void {
    const s = this.screen;
    const win = s.windows.pop();
    if (!win) return;
    const inside = (f: Field): boolean => {
      for (let r = 0; r < win.rows; r++) {
        const a = s.addr(win.row + r, win.col);
        if (f.start - 1 < a + win.cols && f.end > a) return true;
      }
      return false;
    };
    s.fields = s.fields.filter((f) => !inside(f));
    for (let r = 0; r < win.rows; r++) {
      s.buffer.set(win.saved.subarray(r * win.cols, (r + 1) * win.cols), s.addr(win.row + r, win.col));
    }
    for (const f of win.savedFields) s.addField(f);
  }

  /** A read command without a preceding Insert Cursor homes the cursor to the first input field (inside the window that restricts the cursor, if one does). */
  /** Undoes a Write Error Code: the saved error row and cursor come back, the message goes. */
  private restoreErrorLine(): void {
    const s = this.screen;
    if (this.state.savedErrorRow) {
      s.buffer.set(this.state.savedErrorRow, s.errorRow * s.cols);
      this.state.savedErrorRow = undefined;
      this.state.errorMessage = '';
    }
    if (this.state.savedCursor !== undefined) {
      s.cursor = this.state.savedCursor;
      this.state.savedCursor = undefined;
    }
  }

  /**
   * A cursor the host placed inside a selection field but not on a choice (its field
   * address, a lead cell, the gap between columns) lands on the first choice the selection
   * cursor may rest on, so the arrow keys work the field at once.
   */
  private snapToSelection(): void {
    const s = this.screen;
    const on = s.selectionAt(s.cursor);
    if (on) {
      // On a choice already (maybe on its lead cells): make it the selection cursor so it
      // shows as such, with the text cursor on the choice text.
      const c = on.sel.choices[on.choice]!;
      if (c.noCursor) return;
      if (s.colOf(s.cursor) < c.textCol) s.cursor = s.addr(c.row, c.textCol);
      if (on.sel.cursor !== on.choice) {
        on.sel.cursor = on.choice;
        refreshSelection(on.sel, s);
      }
      return;
    }
    for (const sel of s.selections) {
      let end = sel.addr;
      for (const c of sel.choices) end = Math.max(end, s.addr(c.row, c.textCol + c.textLen));
      if (s.cursor < sel.addr - 1 || s.cursor > end) continue;
      const idx = firstCursorChoice(sel);
      if (idx < 0) return;
      const c = sel.choices[idx]!;
      sel.cursor = idx;
      s.cursor = s.addr(c.row, c.textCol);
      refreshSelection(sel, s);
      return;
    }
  }

  private homeCursor(): void {
    const s = this.screen;
    const first = s.fields.find((f) => !f.bypass && s.cursorAllowed(f.start));
    // A selection field before the first entry field is the home instead: the selection
    // cursor goes to its first choice.
    for (const sel of s.selections) {
      const idx = firstCursorChoice(sel);
      if (idx < 0) continue;
      const c = sel.choices[idx]!;
      const start = s.addr(c.row, c.textCol);
      if (!s.cursorAllowed(start) || (first && first.start < start)) continue;
      sel.cursor = idx;
      s.cursor = start;
      refreshSelection(sel, s);
      return;
    }
    if (first) s.cursor = first.start;
  }

  private fillTo(end: number, fill: number): void {
    const size = this.screen.size;
    let guard = 0;
    while (guard++ < size) {
      const here = this.addr;
      this.put(fill);
      if (here === end) break;
    }
  }

  private startField(r: Reader): void {
    let ffw: number | undefined;
    const fcws: number[] = [];
    if ((r.peek() & 0xc0) === 0x40) {
      ffw = r.u16();
      while ((r.peek() & 0xc0) === 0x80) fcws.push(r.u16());
    }
    const attr = r.u8();
    const len = r.u16();
    this.put(attr);
    if (ffw !== undefined) {
      this.screen.addField(new Field(this.addr, len, ffw, fcws, attr));
    }
  }

  private applyCC1(cc1: number): void {
    const op = cc1 & 0xe0;
    if (op === 0) return;
    this.state.inputInhibited = 'system';
    const fields = this.screen.fields;
    const resetMdt = (all: boolean): void => {
      for (const f of fields) if (all || !f.bypass) f.mdt = false;
    };
    const nullFields = (mdtOnly: boolean): void => {
      for (const f of fields) {
        if (f.bypass) continue;
        // A continued entry field is nulled as a whole when any segment was modified.
        const set = f.continued ? this.screen.segmentsOf(f) : [f];
        if (mdtOnly && !set.some((g) => g.mdt)) continue;
        this.screen.buffer.fill(0, f.start, f.end);
      }
    };
    switch (op) {
      case 0x40:
        resetMdt(false);
        break;
      case 0x60:
        resetMdt(true);
        break;
      case 0x80:
        nullFields(true);
        break;
      case 0xa0:
        resetMdt(false);
        nullFields(false);
        break;
      case 0xc0:
        resetMdt(false);
        nullFields(true);
        break;
      case 0xe0:
        resetMdt(true);
        nullFields(false);
        break;
      default:
        break; // 0x20: lock only
    }
  }

  private applyCC2(cc2: number): void {
    if (cc2 & 0x08) this.state.inputInhibited = 'none';
    if (cc2 & 0x04) this.events.alarm?.();
    if (cc2 & 0x02) this.state.messageWaiting = true;
    if (cc2 & 0x01) this.state.messageWaiting = false;
  }

  private writeErrorCode(r: Reader): void {
    const s = this.screen;
    const rowStart = s.errorRow * s.cols;
    if (this.state.savedCursor === undefined) {
      this.state.savedCursor = s.cursor;
      this.state.savedErrorRow = s.buffer.slice(rowStart, rowStart + s.cols);
    }
    s.buffer.fill(0, rowStart, rowStart + s.cols);
    this.addr = rowStart;
    this.writeOrders(r);
    this.state.errorMessage = s.rowText(s.errorRow, this.codePage).trim();
    this.state.inputInhibited = 'error';
  }

  private readScreenExtended(): Uint8Array {
    const s = this.screen;
    const out: number[] = [];
    for (let row = 0; row < s.rows; row++) {
      let end = (row + 1) * s.cols;
      while (end > row * s.cols && s.buffer[end - 1] === 0) end -= 1;
      for (let i = row * s.cols; i < end; i++) out.push(s.buffer[i] as number);
      out.push(0xff);
    }
    return Uint8Array.from(out);
  }

  /** ESC RESTORE + a WTD that rebuilds the current screen, as the host expects for Save Screen. */
  private saveScreen(restore: number = CMD_RESTORE_SCREEN): Uint8Array {
    const s = this.screen;
    // Record the screen size too: the host may switch between 24x80 and 27x132 in between.
    // (A partial restore keeps the unit as it is.)
    const size = restore !== CMD_RESTORE_SCREEN ? [] : s.cols === 132 ? [ESC, CMD_CLEAR_UNIT_ALT, 0x00] : [ESC, CMD_CLEAR_UNIT];
    // The header carries the error row and the command key switches of this screen.
    const ca = this.state.caKeys;
    const soh = [O_SOH, 7, 0x00, 0x00, 0x00, s.errorRow + 1, (ca >> 16) & 0xff, (ca >> 8) & 0xff, ca & 0xff];
    const out: number[] = [ESC, restore, ...size, ESC, CMD_WTD, 0x00, 0x00, ...soh];
    // The windows go back layer by layer: the screen under them, then every Create Window
    // with the cells it showed, oldest first. Replayed, each Create Window covers what the
    // earlier layers wrote, so Remove GUI Window uncovers the same screen as before. The
    // layers come from closing the windows on the live screen, which is put back after.
    const snapshot = { buffer: s.buffer.slice(), fields: s.fields, windows: s.windows };
    s.windows = s.windows.slice();
    const layers: number[][] = [];
    while (s.windows.length > 0) {
      const win = s.windows[s.windows.length - 1]!;
      const body = [0xd9, WDSF_CREATE_WINDOW, ...win.wdsf];
      const layer = [O_SBA, win.row + 1, win.col + 1, O_WDSF, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
      for (let r = 0; r < win.rows; r++) {
        const a = s.addr(win.row + r, win.col);
        layer.push(O_SBA, win.row + r + 1, win.col + 1);
        this.dumpCells(layer, a, a + win.cols);
      }
      layers.unshift(layer);
      this.removeWindow();
    }
    out.push(O_SBA, 1, 1);
    this.dumpCells(out, 0, s.size);
    s.buffer.set(snapshot.buffer);
    s.fields = snapshot.fields;
    s.windows = snapshot.windows;
    for (const layer of layers) out.push(...layer);
    out.push(O_IC, s.rowOf(s.cursor) + 1, s.colOf(s.cursor) + 1);
    return Uint8Array.from(out);
  }

  /** Appends the cells of [from, to) as WTD data, with a Start of Field order where a field begins. */
  private dumpCells(out: number[], from: number, to: number): void {
    const s = this.screen;
    const fieldsByAttr = new Map<number, Field>();
    for (const f of s.fields) fieldsByAttr.set(f.start - 1, f);
    for (let i = from; i < to; i++) {
      const b = s.buffer[i] as number;
      const f = fieldsByAttr.get(i);
      if (f && isAttribute(b)) {
        out.push(O_SF, (f.ffw >> 8) & 0xff, f.ffw & 0xff);
        for (const w of f.fcws) out.push((w >> 8) & 0xff, w & 0xff);
        out.push(b, (f.length >> 8) & 0xff, f.length & 0xff);
      } else {
        out.push(b);
      }
    }
  }

  /**
   * Query reply for WSF class D9 type 70. A plain terminal answers 61 bytes; an
   * enhanced one 67, with byte 53 bit 6 (enhanced 5250 FCWs and WDSFs) and byte 54
   * bit 0 (enhanced user interface level 2) set, as tn5250 does.
   */
  queryReply(): Uint8Array {
    const wide = this.info.terminalType.toUpperCase().startsWith('IBM-3477');
    const ebcdicDigits = (s: string): number[] => Array.from(s, (c) => this.codePage.encode(c));
    const enhanced = this.info.enhanced === true;
    const out = new Uint8Array(enhanced ? 67 : 61);
    out.set([0x00, 0x00, 0x88, 0x00, enhanced ? 0x40 : 0x3a, 0xd9, 0x70, 0x80, 0x06, 0x00, 0x01, 0x01, 0x00], 0);
    if (enhanced) {
      out[53] = 0x02;
      out[54] = 0x80;
    }
    out[29] = 0x01;
    out.set(ebcdicDigits(wide ? '3477' : '3179'), 30);
    out[34] = 0x00;
    out.set(ebcdicDigits(wide ? 'FC' : '02'), 35);
    out[37] = 0x02;
    out.set([0x00, 0x61, 0x50, 0x00], 40);
    out[44] = 0xff;
    out[45] = 0xff;
    out[49] = 0x7b;
    out[50] = wide ? 0x31 : 0x11;
    return out;
  }
}
