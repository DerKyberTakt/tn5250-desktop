import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { DataStreamProcessor } from '../../src/engine/datastream';
import { Keyboard } from '../../src/engine/keyboard';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));
const SBA = (row: number, col: number): string => '11' + row.toString(16).padStart(2, '0') + col.toString(16).padStart(2, '0');
/** Start Field with FFW 0x4000, the FCWs given, attribute 0x20 and a length. */
const SF = (len: number, ...fcws: string[]): string => '1d4000' + fcws.join('') + '20' + len.toString(16).padStart(4, '0');

function setup() {
  const screen = new Screen();
  const state = new TerminalState();
  const proc = new DataStreamProcessor(screen, state, { terminalType: 'IBM-3179-2', enhanced: true }, cp, {});
  const sent: string[] = [];
  const keyboard = new Keyboard(screen, state, proc, cp, { send: (_op, _flags, data) => sent.push(bytesToHex(data)) });
  return { screen, state, proc, keyboard, sent };
}

describe('enhanced 5250 FCWs: continued entry fields', () => {
  // Row 3: 5-cell first segment at col 11; row 4: 5-cell last segment at col 11; a plain field at row 6.
  const SCREEN = '04110028' + SBA(3, 11) + SF(5, '8601') + SBA(4, 11) + SF(5, '8602') + SBA(6, 11) + SF(3) + '04520000';

  it('typing flows from one segment into the next and the set reads back as one field', () => {
    const { screen, proc, keyboard, sent } = setup();
    proc.process(hexToBytes(SCREEN));
    expect(screen.segmentsOf(screen.fields[1]!).map((f) => f.start)).toEqual([screen.addr(2, 11), screen.addr(3, 11)]);
    keyboard.type('abcdefg');
    expect(screen.rowText(2, cp).slice(11, 16)).toBe('abcde');
    expect(screen.rowText(3, cp).slice(11, 16)).toBe('fg   ');
    expect(screen.cursor).toBe(screen.addr(3, 13));
    expect(screen.fields[0]?.mdt && screen.fields[1]?.mdt).toBe(true);
    keyboard.press('enter');
    // One SBA (first segment's first cell), seven bytes, no delimiter between the segments.
    expect(sent[0]).toBe('040e' + 'f1' + SBA(3, 12) + e('abcdefg'));
  });

  it('Backspace crosses back into the first segment; Tab leaves the set; Backtab returns to its start', () => {
    const { screen, proc, keyboard } = setup();
    proc.process(hexToBytes(SCREEN));
    keyboard.type('abcde');
    expect(screen.cursor).toBe(screen.addr(3, 11));
    keyboard.press('backspace');
    expect(screen.cursor).toBe(screen.addr(2, 15));
    expect(screen.rowText(2, cp).slice(11, 16)).toBe('abcd ');
    keyboard.press('tab');
    expect(screen.cursor).toBe(screen.addr(5, 11));
    keyboard.press('backtab');
    expect(screen.cursor).toBe(screen.addr(2, 11));
    keyboard.press('tab');
    keyboard.press('backtab');
    expect(screen.cursor).toBe(screen.addr(2, 11));
  });

  it('Field Exit nulls to the end of the set and goes to the next field; Delete and Insert work across segments', () => {
    const { screen, state, proc, keyboard } = setup();
    proc.process(hexToBytes(SCREEN));
    keyboard.type('abcdefgh');
    screen.cursor = screen.addr(2, 13);
    keyboard.press('fieldExit');
    expect(screen.rowText(2, cp).slice(11, 16)).toBe('ab   ');
    expect(screen.rowText(3, cp).slice(11, 16)).toBe('     ');
    expect(screen.cursor).toBe(screen.addr(5, 11));
    screen.cursor = screen.addr(2, 11);
    keyboard.type('abcdefgh');
    screen.cursor = screen.addr(2, 12);
    keyboard.press('delete');
    expect(screen.rowText(2, cp).slice(11, 16) + screen.rowText(3, cp).slice(11, 16)).toBe('acdefgh   ');
    state.insert = true;
    keyboard.type('X');
    expect(screen.rowText(2, cp).slice(11, 16) + screen.rowText(3, cp).slice(11, 16)).toBe('aXcdefgh  ');
  });
});

describe('enhanced 5250 FCWs: word wrap, cursor progression, highlighted entry', () => {
  it('word wrap moves a word that does not fit to the next line and drops the padding on the read', () => {
    const { screen, proc, keyboard, sent } = setup();
    // A 20-cell word wrap field starting at row 5 col 71: 10 cells on row 5, 10 on row 6.
    proc.process(hexToBytes('04110028' + SBA(5, 70) + SF(20, '8680') + '04520000'));
    keyboard.type('hello worl');
    expect(screen.rowText(4, cp).slice(70, 80)).toBe('hello worl');
    keyboard.type('d');
    expect(screen.rowText(4, cp).slice(70, 80)).toBe('hello     ');
    expect(screen.rowText(5, cp).slice(0, 10)).toBe('world     ');
    expect(screen.buffer[screen.addr(4, 76)]).toBe(0); // padded with nulls, not blanks
    expect(screen.cursor).toBe(screen.addr(5, 5));
    keyboard.press('enter');
    expect(sent[0]).toBe('0606' + 'f1' + SBA(5, 71) + e('hello world'));
  });

  it('cursor progression sends Tab to the numbered field and Backtab back to its source', () => {
    const { screen, proc, keyboard } = setup();
    // Field 1 (row 2) progresses to field 3 (row 4); field 2 (row 3) is skipped.
    proc.process(hexToBytes('04110028' + SBA(2, 2) + SF(4, '8803') + SBA(3, 2) + SF(4) + SBA(4, 2) + SF(4) + '04520000'));
    expect(screen.cursor).toBe(screen.addr(1, 2));
    keyboard.press('tab');
    expect(screen.cursor).toBe(screen.addr(3, 2));
    keyboard.press('backtab');
    expect(screen.cursor).toBe(screen.addr(1, 2));
    // Typing the field full advances the same way.
    keyboard.type('abcd');
    expect(screen.cursor).toBe(screen.addr(3, 2));
  });

  it('a highlighted entry field shows its attribute while the cursor is in it, and can hide the cursor', () => {
    const { screen, proc, keyboard } = setup();
    // X'8901': attribute 0x21 (reverse); X'8921': the same with the cursor hidden (bit 2).
    proc.process(hexToBytes('04110028' + SBA(2, 2) + SF(4, '8901') + SBA(3, 2) + SF(4, '8921') + '04520000'));
    let snap = screen.toSnapshot(cp);
    expect(snap.attrs[screen.addr(1, 1)]).toBe(0x21);
    expect(snap.attrs[screen.addr(2, 1)]).toBe(0x20);
    expect(snap.cursorHidden).toBeUndefined();
    keyboard.press('tab');
    snap = screen.toSnapshot(cp);
    expect(snap.attrs[screen.addr(1, 1)]).toBe(0x20);
    expect(snap.attrs[screen.addr(2, 1)]).toBe(0x21);
    expect(snap.cursorHidden).toBe(true);
    // The buffer itself is untouched.
    expect(screen.buffer[screen.addr(2, 1)]).toBe(0x20);
  });
});
