import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { DataStreamProcessor } from '../../src/engine/datastream';
import { Keyboard } from '../../src/engine/keyboard';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';
import { Session5250 } from '../../src/engine/session';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));
const wdsf = (body: string): string => '15' + (body.length / 2 + 2).toString(16).padStart(4, '0') + body;

function setup() {
  const screen = new Screen();
  const state = new TerminalState();
  const proc = new DataStreamProcessor(screen, state, { terminalType: 'IBM-3179-2', enhanced: true }, cp, {});
  const sent: string[] = [];
  const keyboard = new Keyboard(screen, state, proc, cp, { send: (_op, _flags, data) => sent.push(bytesToHex(data)) });
  return { screen, state, proc, keyboard, sent };
}

// A screen with one 5-byte field at row 3 col 11 and a mouse button table: right button
// pressed (4) -> AID 0x71 with the cursor moved; middle pressed/released two-event (7, 8)
// -> AID 0x72 with a marker; shifted left double click (0x0C) -> 0x73 queued while locked.
const PMB = wdsf('d955' + '000000' + '40' + '04' + '00' + '71' + 'c0' + '07' + '08' + '72' + '20' + '0c' + '00' + '73');
const SCREEN = '04110028' + '11030a' + '1d4000200005' + e('ab') + PMB + '04520000';

describe('enhanced 5250: programmable mouse buttons', () => {
  it('keeps the table and reports the programmed events in the snapshot', () => {
    const { state, proc } = setup();
    proc.process(hexToBytes(SCREEN));
    expect(state.mouseButtons).toHaveLength(3);
    expect(state.mouseButtons[0]).toEqual({ twoEvent: false, moveCursor: true, queue: false, marker: false, first: 4, second: 0, aid: 0x71 });
    expect(state.mouseButtons[1]).toMatchObject({ twoEvent: true, moveCursor: true, first: 7, second: 8, aid: 0x72 });
    const session = new Session5250({ screenSize: '24x80', codePage: 37 }, { send: () => undefined });
    session.processor.process(hexToBytes(SCREEN));
    expect(session.snapshot().gui?.mouseEvents).toEqual([4, 7, 0x0c]);
  });

  it('a single event moves the cursor and sends the AID with the field data', () => {
    const { screen, keyboard, proc, sent } = setup();
    proc.process(hexToBytes(SCREEN));
    screen.fields[0]!.mdt = true;
    expect(keyboard.mouseEvent(4, 5, 7)).toBe(true);
    expect(screen.cursor).toBe(screen.addr(5, 7));
    expect(sent[0]).toBe('0608' + '71' + '11030b' + e('ab'));
    // An event the host did not program is not taken.
    expect(keyboard.mouseEvent(1, 0, 0)).toBe(false);
  });

  it('a two-event sequence answers with X80, the first position and the host AID', () => {
    const { screen, state, keyboard, proc, sent } = setup();
    proc.process(hexToBytes(SCREEN));
    expect(keyboard.mouseEvent(7, 2, 3)).toBe(true);
    expect(state.pendingMouse).toMatchObject({ row: 2, col: 3 });
    expect(sent).toHaveLength(0);
    expect(keyboard.mouseEvent(8, 9, 10)).toBe(true);
    expect(screen.cursor).toBe(screen.addr(9, 10));
    expect(sent[0]).toBe('0a0b' + '80' + '0304' + '72');
    expect(state.pendingMouse).toBeUndefined();
    // A keystroke cancels a started sequence.
    proc.process(hexToBytes('04520000'));
    keyboard.mouseEvent(7, 2, 3);
    keyboard.press('right');
    expect(state.pendingMouse).toBeUndefined();
  });

  it('a queued single event waits for the unlock; the table goes with Clear Unit', () => {
    const session = new Session5250({ screenSize: '24x80', codePage: 37 }, { send: () => undefined });
    const sent: string[] = [];
    const s2 = new Session5250({ screenSize: '24x80', codePage: 37 }, { send: (b) => sent.push(bytesToHex(b)) });
    void session;
    s2.processor.process(hexToBytes(SCREEN));
    s2.press('enter');
    expect(s2.state.inputInhibited).toBe('system');
    expect(s2.mouseEvent(0x0c, 1, 1)).toBe(true);
    expect(s2.state.queuedMouse).toBeDefined();
    const before = sent.length;
    // The host unlocks with a Read: the queued event goes out at once.
    s2.feed(hexToBytes('000e12a00000040000030452' + '0000' + 'ffef'));
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toContain('73');
    s2.processor.process(hexToBytes('0440'));
    expect(s2.state.mouseButtons).toEqual([]);
  });
});

describe('enhanced 5250: Write Data and window cursor restriction', () => {
  it('Write Data fills the entry field at the write address and nulls the rest', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes('04110028' + '11030a' + '1d4000200006' + e('abcdef') + '11030b' + wdsf('d954' + '80' + '00' + e('xy')) + '04520000'));
    expect(bytesToHex(screen.buffer.subarray(screen.addr(2, 10), screen.addr(2, 16)))).toBe(e('xy') + '00000000');
    // Flag off, or not at the first position of a field: nothing happens.
    proc.process(hexToBytes('04110000' + '11030b' + wdsf('d954' + '00' + '00' + e('zz')) + '11030c' + wdsf('d954' + '80' + '00' + e('zz')) + '04520000'));
    expect(screen.rowText(2, cp).slice(10, 12)).toBe('xy');
  });

  it('a window with the restrict flag keeps the cursor, Tab and clicks inside it until Unrestricted Window Cursor Movement', () => {
    const { screen, keyboard, proc } = setup();
    const base = '04110028' + '110202' + '1d4000200004' + '04520000';
    proc.process(hexToBytes(base));
    // Window at row 8 col 20, depth 4, width 20, restrict cursor (flag 0x80), with a field inside.
    const create = wdsf('d951' + '80' + '0000' + '04' + '14');
    proc.process(hexToBytes('04110000' + '110814' + create + '110918' + '1d4000200005' + '04520000'));
    const inside = screen.addr(8, 24);
    expect(screen.cursor).toBe(inside);
    expect(screen.cursorBounds()).toEqual({ top: 8, left: 22, bottom: 11, right: 41 });
    keyboard.press('tab');
    expect(screen.cursor).toBe(inside);
    keyboard.press('up');
    expect(screen.cursor).toBe(screen.addr(11, 24));
    keyboard.press('left');
    expect(screen.cursor).toBe(screen.addr(11, 23));
    keyboard.press('home');
    expect(screen.cursor).toBe(inside);
    const session = new Session5250({ screenSize: '24x80', codePage: 37 }, { send: () => undefined });
    session.processor.process(hexToBytes(base));
    session.processor.process(hexToBytes('04110000' + '110814' + create + '110918' + '1d4000200005' + '04520000'));
    session.setCursor(0, 0);
    expect(session.screen.cursor).toBe(inside);
    session.setCursor(9, 30);
    expect(session.screen.cursor).toBe(session.screen.addr(9, 30));
    // Unrestricted Window Cursor Movement lifts it.
    proc.process(hexToBytes('04110000' + wdsf('d952' + '0000') + '04520000'));
    expect(screen.cursorBounds()).toBeUndefined();
    // The read after it homed to the first field of the whole screen; Tab reaches the window's field.
    expect(screen.cursor).toBe(screen.addr(1, 2));
    keyboard.press('tab');
    expect(screen.cursor).toBe(inside);
  });
});
