import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { DataStreamProcessor } from '../../src/engine/datastream';
import { Keyboard } from '../../src/engine/keyboard';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));
const h = (n: number, bytes = 1): string => n.toString(16).padStart(bytes * 2, '0');
const wdsf = (body: string): string => '15' + h(body.length / 2 + 2, 2) + body;
const SBA = (row: number, col: number): string => '11' + h(row) + h(col);

function setup() {
  const screen = new Screen();
  const state = new TerminalState();
  const proc = new DataStreamProcessor(screen, state, { terminalType: 'IBM-3179-2', enhanced: true }, cp, {});
  const sent: string[] = [];
  const keyboard = new Keyboard(screen, state, proc, cp, { send: (_op, _flags, data) => sent.push(bytesToHex(data)) });
  return { screen, state, proc, keyboard, sent };
}

// Two entry fields (row 2 col 2, row 3 col 2) and a Read MDT.
const TWO_FIELDS = '04110008' + SBA(2, 2) + '1d4000200005' + SBA(3, 2) + '1d4300200006' + '0452' + '0000';

describe('Write Error Code and the error line', () => {
  it('a read after the error keeps the cursor where the operator was', () => {
    const { screen, state, proc, keyboard } = setup();
    proc.process(hexToBytes(TWO_FIELDS));
    keyboard.press('tab'); // cursor into the second field
    const here = screen.cursor;
    expect(screen.rowOf(here)).toBe(2);
    // Write Error Code with a message, followed by the host's Read MDT.
    proc.process(hexToBytes('0421' + e('Roll past the end') + '0452' + '0000'));
    expect(state.errorMessage).toBe('Roll past the end');
    expect(screen.rowText(screen.errorRow, cp).trim()).toBe('Roll past the end');
    expect(screen.cursor).toBe(here); // not homed to the first field
  });

  it('Write Error Code to Window writes between the given columns and leaves the rest of the row', () => {
    const { screen, state, proc } = setup();
    // A window whose left border sits in column 5 of the error row; the host says the error line runs from column 7 to 40.
    proc.process(hexToBytes('04110008' + SBA(24, 1) + e('Roll') + SBA(24, 5) + e('|') + SBA(2, 2) + '1d4000200005' + '0452' + '0000'));
    proc.process(hexToBytes('0422' + '07' + '28' + e('Roll up or down past the first record') + '0452' + '0000'));
    const row = screen.rowText(screen.errorRow, cp);
    expect(row.slice(0, 5)).toBe('Roll|');
    expect(row.charAt(4)).toBe('|');
    expect(row.slice(6).trim()).toBe('Roll up or down past the first record');
    expect(state.errorMessage).toContain('Roll up or down past the first record');
    // The repaint restores the whole row.
    proc.process(hexToBytes('04110000' + SBA(2, 10) + e('x') + '0452' + '0000'));
    expect(screen.rowText(screen.errorRow, cp).slice(0, 5)).toBe('Roll|');
    expect(screen.rowText(screen.errorRow, cp).slice(6).trim()).toBe('');
  });

  it('the next Write to Display takes the message off the error line', () => {
    const { screen, state, proc } = setup();
    proc.process(hexToBytes('04110008' + SBA(24, 2) + e('F3=Exit') + SBA(2, 2) + '1d4000200005' + '0452' + '0000'));
    proc.process(hexToBytes('0421' + e('Roll past the end') + '0452' + '0000'));
    expect(screen.rowText(screen.errorRow, cp).trim()).toBe('Roll past the end');
    // A valid page: the host rewrites row 2 only.
    proc.process(hexToBytes('04110000' + SBA(2, 10) + e('page 2') + '0452' + '0000'));
    expect(screen.rowText(screen.errorRow, cp).trim()).toBe('F3=Exit');
    expect(state.errorMessage).toBe('');
  });
});

describe('I/O fields (DDS data type I)', () => {
  it('refuse keyboard data with operator error 0004', () => {
    const { screen, state, proc, keyboard } = setup();
    // FFW 0x4600: shift 110 = I/O feature input field.
    proc.process(hexToBytes('04110008' + SBA(2, 2) + '1d4600200005' + '0452' + '0000'));
    keyboard.type('a');
    expect(state.inputInhibited).toBe('error');
    expect(state.errorMessage).toBe('0004 Entry of data not allowed in this input/output field');
    expect(screen.buffer[screen.addr(1, 2)]).toBe(0);
  });
});

describe('cursor placed inside a selection field', () => {
  // One single choice field at row 5 col 5 (two choices, TextSize 6) and the host's IC on the
  // field address itself, between the choices' cells.
  const choice = (text: string): string => {
    const body = '10' + '00' + '00' + '80' + e(text);
    return h(body.length / 2 + 1) + body;
  };
  const major =
    '00' + '00' + '00' + '11' + '00' + '0000' + '0000' + '06' + '02' + '01' + '00' + '00' + '00' + '00';
  const SEL = '04110028' + SBA(5, 5) + wdsf('d950' + major + choice('Red') + choice('Blue'));

  it('snaps to the first choice so the arrow keys work the field', () => {
    for (const [row, col] of [[5, 5], [5, 6], [5, 9]]) {
      const { screen, proc } = setup();
      proc.process(hexToBytes(SEL + '13' + h(row as number) + h(col as number) + '04520000'));
      const hit = screen.selectionAt(screen.cursor);
      expect(hit).toBeDefined();
      expect(hit!.choice).toBe(0);
      expect(hit!.sel.cursor).toBe(0);
      expect(screen.colOf(screen.cursor)).toBeGreaterThanOrEqual(hit!.sel.choices[0]!.textCol);
    }
  });
});
