import { isAttribute } from './attributes';
import type { CodePage } from './codepage';
import { OP_NOOP, OP_PUT_GET, OP_SAVE_SCREEN } from './gds';
import { Field, Screen } from './screen';
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
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get eof(): boolean {
    return this.pos >= this.buf.length;
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
          // The host is repainting: anything saved for Reset is stale now.
          this.state.savedCursor = undefined;
          this.state.savedErrorRow = undefined;
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
          if (!this.cursorSet || (this.screen.cursor === 0 && !(at0 && !at0.bypass))) this.homeCursor();
          this.cursorSet = false;
          break;
        }
        case CMD_READ_IMMEDIATE:
          out.push({ opcode: OP_PUT_GET, data: this.readResponse('input', 0x00) });
          break;
        case CMD_READ_IMMEDIATE_ALT:
          out.push({ opcode: OP_PUT_GET, data: this.readResponse('mdtAlt', 0x00) });
          break;
        case CMD_READ_SCREEN:
          out.push({ opcode: OP_NOOP, data: this.screen.buffer.slice() });
          break;
        case CMD_READ_SCREEN_EXT:
          out.push({ opcode: OP_NOOP, data: this.readScreenExtended() });
          break;
        case CMD_SAVE_SCREEN:
          out.push({ opcode: OP_SAVE_SCREEN, data: this.saveScreen() });
          break;
        case CMD_SAVE_PARTIAL_SCREEN:
          r.bytes(5);
          break;
        case CMD_RESTORE_SCREEN:
          // The saved image that follows replaces everything, including the
          // format table left behind by whatever screen was shown meanwhile.
          this.screen.clear();
          this.addr = 0;
          this.state.savedCursor = undefined;
          this.state.savedErrorRow = undefined;
          break;
        case CMD_RESTORE_PARTIAL_SCREEN:
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
          const ll = r.u16();
          const cls = r.u8();
          const type = r.u8();
          r.bytes(Math.max(0, ll - 4));
          if (cls === 0xd9 && type === 0x70) {
            out.push({ opcode: OP_NOOP, data: this.queryReply() });
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

  /** The response of a command attention key: cursor and AID, no field data. */
  aidOnly(aid: number): Uint8Array {
    const s = this.screen;
    return Uint8Array.from([s.rowOf(s.cursor) + 1, s.colOf(s.cursor) + 1, aid]);
  }

  /** Builds the AID response for the pending read (or the kind given). */
  readResponse(kind: ReadKind, aid: number): Uint8Array {
    const s = this.screen;
    const out: number[] = [s.rowOf(s.cursor) + 1, s.colOf(s.cursor) + 1, aid];
    for (const f of s.fields) {
      if (f.bypass) continue;
      const bytes = s.fieldBytes(f);
      if (kind === 'input') {
        for (const b of bytes) out.push(b === 0 ? 0x40 : b);
        continue;
      }
      if (!f.mdt) continue;
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end -= 1;
      if (kind === 'mdt') {
        while (end > 0 && bytes[end - 1] === 0x40) end -= 1;
      }
      out.push(O_SBA, s.rowOf(f.start) + 1, s.colOf(f.start) + 1);
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
          r.bytes(Math.max(0, ll - 2));
          break;
        }
        default:
          this.put(b);
          break;
      }
    }
  }

  /** A read command without a preceding Insert Cursor homes the cursor to the first input field. */
  private homeCursor(): void {
    const s = this.screen;
    const first = s.fields.find((f) => !f.bypass);
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
        if (f.bypass || (mdtOnly && !f.mdt)) continue;
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
  private saveScreen(): Uint8Array {
    const s = this.screen;
    // Record the screen size too: the host may switch between 24x80 and 27x132 in between.
    const size = s.cols === 132 ? [ESC, CMD_CLEAR_UNIT_ALT, 0x00] : [ESC, CMD_CLEAR_UNIT];
    // The header carries the error row and the command key switches of this screen.
    const ca = this.state.caKeys;
    const soh = [O_SOH, 7, 0x00, 0x00, 0x00, s.errorRow + 1, (ca >> 16) & 0xff, (ca >> 8) & 0xff, ca & 0xff];
    const out: number[] = [ESC, CMD_RESTORE_SCREEN, ...size, ESC, CMD_WTD, 0x00, 0x00, ...soh, O_SBA, 1, 1];
    const fieldsByAttr = new Map<number, Field>();
    for (const f of s.fields) fieldsByAttr.set(f.start - 1, f);
    for (let i = 0; i < s.size; i++) {
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
    out.push(O_IC, s.rowOf(s.cursor) + 1, s.colOf(s.cursor) + 1);
    return Uint8Array.from(out);
  }

  /** Query reply for WSF class D9 type 70 (non-enhanced terminal). */
  queryReply(): Uint8Array {
    const wide = this.info.terminalType.toUpperCase().startsWith('IBM-3477');
    const ebcdicDigits = (s: string): number[] => Array.from(s, (c) => this.codePage.encode(c));
    const out = new Uint8Array(61);
    out.set([0x00, 0x00, 0x88, 0x00, 0x3a, 0xd9, 0x70, 0x80, 0x06, 0x00, 0x01, 0x01, 0x00], 0);
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
