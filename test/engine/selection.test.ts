import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { AID_ROLL_UP, DataStreamProcessor } from '../../src/engine/datastream';
import { Keyboard } from '../../src/engine/keyboard';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';
import { Session5250 } from '../../src/engine/session';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));
const h = (n: number, bytes = 1): string => n.toString(16).padStart(bytes * 2, '0');
const wdsf = (body: string): string => '15' + h(body.length / 2 + 2, 2) + body;

function setup() {
  const screen = new Screen();
  const state = new TerminalState();
  const proc = new DataStreamProcessor(screen, state, { terminalType: 'IBM-3179-2', enhanced: true }, cp, {});
  const sent: string[] = [];
  const keyboard = new Keyboard(screen, state, proc, cp, { send: (_op, _flags, data) => sent.push(bytesToHex(data)) });
  return { screen, state, proc, keyboard, sent };
}

interface Major {
  flag1?: number;
  flag2?: number;
  type: number;
  gui?: number;
  textSize: number;
  rows: number;
  cols: number;
  padding?: number;
  cancelAid?: number;
  total?: number;
  pos?: number;
}

/** Define Selection Field major structure + minors. */
function dsf(m: Major, minors: string[]): string {
  const withBar = m.total !== undefined;
  const head =
    h(m.flag1 ?? 0) + h((m.flag2 ?? 0) | (withBar ? 0x80 : 0)) + '00' + h(m.type) + h(m.gui ?? 0) + '0000' + '0000' +
    h(m.textSize) + h(m.rows) + h(m.cols) + h(m.padding ?? 0) + '00' + '00' + h(m.cancelAid ?? 0) +
    (withBar ? h(m.total as number, 4) + h(m.pos as number, 4) : '');
  return wdsf('d950' + head + minors.join(''));
}

/** Choice text minor for a GUI device. */
function choice(text: string, opt: { f1?: number; f2?: number; mnemonic?: number; aid?: number } = {}): string {
  let f1 = opt.f1 ?? 0;
  let extra = '';
  if (opt.mnemonic !== undefined) {
    f1 |= 0x08;
    extra += h(opt.mnemonic);
  }
  if (opt.aid !== undefined) {
    f1 |= 0x04;
    extra += h(opt.aid);
  }
  const body = '10' + h(f1) + h(opt.f2 ?? 0) + '80' + extra + e(text);
  return h(body.length / 2 + 1) + body;
}

const SBA = (row: number, col: number): string => '11' + h(row) + h(col);

describe('enhanced 5250: selection fields', () => {
  // An entry field at row 2, then a single choice field (radio buttons) at row 5 col 5 with
  // three choices, TextSize 10, one column.
  const RADIO = '04110028' + SBA(2, 2) + '1d4000200003' + SBA(5, 5) +
    dsf({ type: 0x11, gui: 0x00, textSize: 10, rows: 3, cols: 1 }, [choice('Red', { mnemonic: 0 }), choice('Green', { mnemonic: 0 }), choice('Blue', { mnemonic: 0 })]) +
    '04520000';

  it('lays the choices out with attribute, indicator and text cells', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes(RADIO));
    expect(screen.selections).toHaveLength(1);
    const sel = screen.selections[0]!;
    expect(sel).toMatchObject({ kind: 'single', indicators: 'left', rows: 3, cols: 1, textSize: 10, cursor: -1 });
    expect(sel.choices.map((c) => [c.row, c.col, c.indicatorCol, c.textCol])).toEqual([[4, 2, 3, 5], [5, 2, 3, 5], [6, 2, 3, 5]]);
    // The field address (col 4) is the text's leading attribute; the indicator pair sits to
    // its left. Row 5 (0-based 4): attr, '.', attr, "Red       ", attr.
    expect(screen.buffer[screen.addr(4, 2)]).toBe(0x20);
    expect(screen.rowText(4, cp).slice(3, 4)).toBe('.');
    expect(screen.buffer[screen.addr(4, 4)]).toBe(0x20);
    expect(screen.rowText(4, cp).slice(5, 15)).toBe('Red       ');
    expect(screen.buffer[screen.addr(4, 15)]).toBe(0x20);
    const snap = screen.toSnapshot(cp);
    expect(snap.gui?.selections[0]).toMatchObject({ style: 'radio', cursor: -1 });
    expect(snap.gui?.selections[0]?.choices[2]).toMatchObject({ row: 6, col: 5, length: 10, indicatorCol: 3, state: 'available', mnemonic: 0 });
  });

  it('Tab enters the field, arrows move the selection cursor, Space selects, Enter returns the choice number', () => {
    const { screen, proc, keyboard, sent } = setup();
    proc.process(hexToBytes(RADIO));
    expect(screen.cursor).toBe(screen.addr(1, 2));
    keyboard.press('tab');
    const sel = screen.selections[0]!;
    expect(sel.cursor).toBe(0);
    expect(screen.cursor).toBe(screen.addr(4, 5));
    expect(screen.buffer[screen.addr(4, 4)]).toBe(0x21); // selection cursor: reverse
    keyboard.press('down');
    expect(sel.cursor).toBe(1);
    expect(screen.buffer[screen.addr(4, 4)]).toBe(0x20);
    expect(screen.buffer[screen.addr(5, 4)]).toBe(0x21);
    keyboard.type(' ');
    expect(sel.choices[1]?.state).toBe('selected');
    expect(screen.rowText(5, cp).slice(3, 4)).toBe('/');
    expect(sel.mdt).toBe(true);
    keyboard.press('enter');
    // cursor at the selection cursor (row 6 col 6), Enter, SBA to the cell after the field address, choice 2 -> X'0021'.
    expect(sent[0]).toBe('0606' + 'f1' + SBA(5, 6) + '0021');
    // Mnemonic: 'b' selects Blue; the previous choice is deselected in a single choice field.
    proc.process(hexToBytes('04520000'));
    keyboard.press('tab');
    keyboard.type('b');
    expect(sel.choices.map((c) => c.state)).toEqual(['available', 'available', 'selected']);
    expect(sel.cursor).toBe(2);
    // Tab leaves to the entry field and clears the selection cursor.
    keyboard.press('tab');
    expect(sel.cursor).toBe(-1);
    expect(screen.cursor).toBe(screen.addr(1, 2));
    keyboard.press('enter');
    expect(sent[1]).toBe('0203' + 'f1' + SBA(5, 6) + '0022');
  });

  it('a multiple choice field toggles check boxes and returns one byte per choice', () => {
    const { screen, proc, keyboard, sent } = setup();
    proc.process(hexToBytes('04110028' + SBA(3, 3) + dsf({ type: 0x12, gui: 0x00, textSize: 6, rows: 2, cols: 2, padding: 1 }, [choice('One'), choice('Two'), choice('Three')]) + '04520000'));
    const sel = screen.selections[0]!;
    expect(sel.kind).toBe('multiple');
    // Two columns: the second starts after lead(3) + text(6) + end(1) + padding(1).
    expect(sel.choices.map((c) => [c.row, c.col])).toEqual([[2, 0], [2, 11], [3, 0]]);
    expect(screen.buffer[screen.addr(2, 0)]).toBe(0x24); // check box indicator attribute: underscore
    expect(screen.cursor).toBe(screen.addr(2, 3)); // the read homed to the first choice
    expect(sel.cursor).toBe(0);
    keyboard.type(' ');
    keyboard.press('right');
    keyboard.type(' ');
    keyboard.type(' ');
    expect(sel.choices.map((c) => c.state)).toEqual(['selected', 'available', 'available']);
    keyboard.press('enter');
    // The selection cursor stayed on the second choice (row 3, text col 15).
    expect(sent[0]).toBe('030f' + 'f1' + SBA(3, 4) + 'f1000000');
  });

  it('push buttons draw < > and send the choice AID at once (auto-enter, auto-select)', () => {
    const { screen, proc, keyboard, sent } = setup();
    // flag1: auto-enter B'01' (0x04) + auto-select (0x02); gui 0x20 = push button box.
    proc.process(hexToBytes('04110028' + SBA(20, 10) + dsf({ flag1: 0x06, type: 0x41, gui: 0x20, textSize: 12, rows: 1, cols: 2, padding: 1 }, [choice('Enter=OK', { aid: 0x31 }), choice('F12=Cancel', { aid: 0x3c })]) + '04520000'));
    const sel = screen.selections[0]!;
    expect(screen.toSnapshot(cp).gui?.selections[0]?.style).toBe('button');
    expect(screen.rowText(19, cp).slice(10, 22)).toBe('<Enter=OK>  ');
    keyboard.press('right');
    keyboard.type(' ');
    expect(sent[0]?.slice(4, 6)).toBe('3c');
    expect(sent[0]).toContain(SBA(20, 11) + '0021');
    expect(sel.choices[1]?.state).toBe('selected');
  });

  it('a menu bar lays its choices on one row and draws the separator underneath', () => {
    const { screen, proc } = setup();
    const separator = '0809' + '00' + '01' + '28' + '00' + '00' + '00';
    proc.process(hexToBytes('04110028' + SBA(1, 1) + dsf({ type: 0x01, gui: 0xf0, textSize: 10, rows: 1, cols: 3, padding: 1 }, [choice('File'), choice('Edit'), choice('Help'), separator]) + '04520000'));
    const sel = screen.selections[0]!;
    expect(sel.kind).toBe('menuBar');
    expect(sel.choices.map((c) => [c.col, c.textCol, c.textLen])).toEqual([[0, 1, 4], [7, 8, 4], [14, 15, 4]]);
    expect(screen.rowText(0, cp).slice(0, 20)).toBe(' File   Edit   Help ');
    expect(sel.separator).toEqual({ row: 1, col: 0, length: 40 });
    expect(screen.buffer[screen.addr(1, 0)]).toBe(0x3a);
    expect(screen.rowText(1, cp).slice(1, 39)).toBe('-'.repeat(38));
  });

  it('a selection list with a scroll bar reports the increment with the field; Remove and a new format take it away', () => {
    const { screen, proc, keyboard, sent } = setup();
    const LIST = '04110028' + SBA(5, 5) + dsf({ type: 0x21, gui: 0x00, textSize: 8, rows: 4, cols: 1, total: 50, pos: 10 }, [choice('a'), choice('b'), choice('c'), choice('d')]) + '04520000';
    proc.process(hexToBytes(LIST));
    const sel = screen.selections[0]!;
    expect(screen.scrollBars).toHaveLength(1);
    const bar = screen.scrollBars[0]!;
    expect(bar).toMatchObject({ owner: sel.addr, total: 50, pos: 10, size: 4, addr: screen.addr(4, 4 + 1 + 8) });
    keyboard.scrollBar(bar.addr, true, 1);
    // The selection cursor is in the list (homed there), so the cursor stays; Roll Up with the
    // field data (nothing selected) and the increment, one SBA for the field.
    expect(sent[0]).toBe('0506' + h(AID_ROLL_UP) + SBA(5, 6) + '0000' + '00000001');
    proc.process(hexToBytes('04110000' + SBA(5, 5) + wdsf('d958' + '0000') + '04520000'));
    expect(screen.selections).toHaveLength(0);
    expect(screen.scrollBars).toHaveLength(0);
    proc.process(hexToBytes(LIST));
    proc.process(hexToBytes('04110000' + '0107' + '00000018' + '000004' + '04520000'));
    expect(screen.selections).toHaveLength(0);
  });

  it('a click selects a choice; a click outside a pull-down sends its cancel AID', () => {
    const session = new Session5250({ screenSize: '24x80', codePage: 37 }, { send: () => undefined });
    const sent: string[] = [];
    const s2 = new Session5250({ screenSize: '24x80', codePage: 37 }, { send: (b) => sent.push(bytesToHex(b)) });
    void session;
    s2.processor.process(hexToBytes('04110028' + SBA(8, 20) + dsf({ type: 0x31, gui: 0x00, textSize: 8, rows: 2, cols: 1, cancelAid: 0x3c }, [choice('Open'), choice('Save')]) + '04520000'));
    const sel = s2.screen.selections[0]!;
    s2.setCursor(8, 24); // row 9 (0-based 8), on "Save"
    expect(sel.cursor).toBe(1);
    expect(sel.choices[1]?.state).toBe('selected');
    s2.setCursor(20, 2);
    expect(sent.at(-1)).toContain('3c');
  });
});
