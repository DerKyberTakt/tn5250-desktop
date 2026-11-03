import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { AID_ROLL_DOWN, AID_ROLL_RIGHT, AID_ROLL_UP, DataStreamProcessor } from '../../src/engine/datastream';
import { Keyboard } from '../../src/engine/keyboard';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));
const u32 = (n: number): string => n.toString(16).padStart(8, '0');

function setup() {
  const screen = new Screen();
  const state = new TerminalState();
  const proc = new DataStreamProcessor(screen, state, { terminalType: 'IBM-3179-2', enhanced: true }, cp, {});
  const sent: string[] = [];
  const keyboard = new Keyboard(screen, state, proc, cp, { send: (_op, _flags, data) => sent.push(bytesToHex(data)) });
  return { screen, state, proc, keyboard, sent };
}

/** WDSF order + length around a D9 structured field body. */
const wdsf = (body: string): string => '15' + (body.length / 2 + 2).toString(16).padStart(4, '0') + body;

/** Define Scroll Bar: flags, reserved, total, slider position, size. */
const scrollBar = (flags: number, total: number, pos: number, size: number): string =>
  wdsf('d953' + flags.toString(16).padStart(2, '0') + '00' + u32(total) + u32(pos) + size.toString(16).padStart(2, '0'));

// A subfile page: heading, an option field per row, a vertical scroll bar at row 5 col 77
// (10 rows, 120 records, the first shown is record 31), then Read MDT Fields.
const SUBFILE =
  '04110028' + '0107' + '00000018' + '000004' +
  '110402' + '22' + e('Opt  Item') + '20' +
  '110502' + '1d4000200002' +
  '110602' + '1d4000200002' +
  '11054d' + scrollBar(0x00, 120, 30, 10) +
  '110f02' + '20' + e('F3=Exit') + '20' +
  '04520000';

describe('enhanced 5250: scroll bars', () => {
  it('Define Scroll Bar Field keeps the bar in screen order and blanks the cells under it', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes(SUBFILE));
    expect(screen.scrollBars).toHaveLength(1);
    const bar = screen.scrollBars[0]!;
    expect(bar).toMatchObject({ addr: screen.addr(4, 76), horizontal: false, moveCursor: false, mdt: false, total: 120, pos: 30, size: 10, increment: 0 });
    for (let r = 4; r < 14; r++) {
      expect(screen.buffer[screen.addr(r, 76)]).toBe(0x20);
      expect(screen.buffer[screen.addr(r, 77)]).toBe(0x00);
      expect(screen.buffer[screen.addr(r, 78)]).toBe(0x20);
    }
    // The text after the bar still lands where the host put it: the address did not move.
    expect(screen.rowText(14, cp).slice(2, 9)).toBe('F3=Exit');
    const snap = screen.toSnapshot(cp);
    expect(snap.gui?.scrollBars).toEqual([{ addr: screen.addr(4, 76), row: 4, col: 76, horizontal: false, size: 10, total: 120, pos: 30 }]);
  });

  it('redefines a bar at the same address and removes it on Remove GUI Scroll Bar / Remove All / a new format', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes(SUBFILE));
    proc.process(hexToBytes('04110000' + '11054d' + scrollBar(0x41, 120, 60, 10) + '04520000'));
    expect(screen.scrollBars).toHaveLength(1);
    expect(screen.scrollBars[0]).toMatchObject({ pos: 60, moveCursor: true, mdt: true });
    proc.process(hexToBytes('04110000' + '11054d' + wdsf('d95b' + '0000') + '04520000'));
    expect(screen.scrollBars).toHaveLength(0);

    proc.process(hexToBytes(SUBFILE));
    proc.process(hexToBytes('04110000' + wdsf('d95f' + '000000') + '04520000'));
    expect(screen.scrollBars).toHaveLength(0);

    proc.process(hexToBytes(SUBFILE));
    proc.process(hexToBytes('04110000' + '0107' + '00000018' + '000004' + '04520000'));
    expect(screen.scrollBars).toHaveLength(0);

    proc.process(hexToBytes(SUBFILE));
    proc.process(hexToBytes('0440'));
    expect(screen.scrollBars).toHaveLength(0);
  });

  it('rejects a bar that does not fit or is too small', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes('04110000' + '11144d' + scrollBar(0x00, 10, 0, 12) + '04520000'));
    proc.process(hexToBytes('04110000' + '11054d' + scrollBar(0x00, 10, 0, 2) + '04520000'));
    expect(screen.scrollBars).toHaveLength(0);
  });

  it('pointer use sends a Roll AID and the increment comes back at the bar address on the MDT read', () => {
    const { screen, proc, keyboard, sent } = setup();
    proc.process(hexToBytes(SUBFILE));
    const addr = screen.addr(4, 76);
    keyboard.scrollBar(addr, true, 1);
    expect(sent).toHaveLength(1);
    // cursor (homed to the first option field), AID Roll Up, then SBA 5,77 + 00000001; no entry field had its MDT on.
    expect(sent[0]).toBe('0503' + AID_ROLL_UP.toString(16) + '11054d' + '00000001');
    expect(screen.scrollBars[0]).toMatchObject({ mdt: false, increment: 0 });
  });

  it('a slider drag reports the rows moved; a page click reports 0; arrows back send Roll Down', () => {
    const { screen, state, proc, keyboard, sent } = setup();
    proc.process(hexToBytes(SUBFILE));
    const addr = screen.addr(4, 76);
    keyboard.scrollBar(addr, false, 25);
    expect(sent[0]).toBe('0503' + AID_ROLL_DOWN.toString(16) + '11054d' + '00000019');
    // The host unlocks and reads again.
    proc.process(hexToBytes('04520000'));
    keyboard.scrollBar(addr, true, 0);
    expect(sent[1]).toBe('0503' + AID_ROLL_UP.toString(16) + '11054d' + '00000000');
    // Locked keyboard: nothing goes out.
    expect(state.inputInhibited).toBe('system');
    keyboard.scrollBar(addr, true, 1);
    expect(sent).toHaveLength(2);
  });

  it('moves the cursor onto the bar when the host asked for it, and Read Input Fields returns the 4 bytes in place', () => {
    const { screen, proc, keyboard, sent } = setup();
    proc.process(hexToBytes('04110028' + '110502' + '1d4000200002' + '11054d' + scrollBar(0x40, 50, 0, 8) + '04420000'));
    keyboard.scrollBar(screen.addr(4, 76), true, 1);
    expect(screen.cursor).toBe(screen.addr(5, 76));
    // Read Input Fields: the 2-byte entry field (blanks) then the 4-byte increment, no SBAs.
    expect(sent[0]).toBe('064d' + AID_ROLL_UP.toString(16) + '4040' + '00000001');
  });

  it('a horizontal bar blanks one row and sends Roll Right / Roll Left', () => {
    const { screen, proc, keyboard, sent } = setup();
    proc.process(hexToBytes('04110028' + '11100a' + scrollBar(0x80, 200, 0, 20) + '04520000'));
    const bar = screen.scrollBars[0]!;
    expect(bar).toMatchObject({ horizontal: true, size: 20, addr: screen.addr(15, 9) });
    expect(screen.buffer[screen.addr(15, 9)]).toBe(0x20);
    expect(screen.buffer[screen.addr(15, 10)]).toBe(0x00);
    expect(screen.buffer[screen.addr(15, 28)]).toBe(0x20);
    keyboard.scrollBar(bar.addr, true, 3);
    expect(sent[0]).toContain(AID_ROLL_RIGHT.toString(16) + '11100a' + '00000003');
  });
});

describe('enhanced 5250: window titles', () => {
  const border = '0d01' + '00' + '21' + '3b' + '4b604b4f4f7a607a';
  const titleMinor = (flags: number, text: string): string => {
    const t = e(text);
    return (t.length / 2 + 6).toString(16).padStart(2, '0') + '10' + flags.toString(16).padStart(2, '0') + '00' + '00' + '00' + t;
  };

  it('keeps the title and footer and writes them into the border rows', () => {
    const { screen, proc } = setup();
    const body = 'd951' + '00' + '0000' + '05' + '14' + border + titleMinor(0x00, 'Options') + titleMinor(0x20 | 0x80, 'F12=Cancel');
    proc.process(hexToBytes('04110000' + '11071e' + wdsf(body) + '04520000'));
    expect(screen.windows).toHaveLength(1);
    expect(screen.windows[0]?.title).toEqual({ text: 'Options', align: 'center' });
    expect(screen.windows[0]?.footer).toEqual({ text: 'F12=Cancel', align: 'left' });
    // Top border: 22 cells between the corners; "Options" centred in them.
    expect(screen.rowText(6, cp).slice(31, 53)).toBe('-------Options--------');
    expect(screen.rowText(12, cp).slice(31, 53)).toBe('F12=Cancel------------');
    expect(screen.toSnapshot(cp).gui?.windows[0]).toMatchObject({ row: 6, col: 29, rows: 7, cols: 26, title: { text: 'Options', align: 'center' } });
  });
});
