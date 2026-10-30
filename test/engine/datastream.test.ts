import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { DataStreamProcessor } from '../../src/engine/datastream';
import { OP_NOOP, OP_PUT_GET, parseRecord } from '../../src/engine/gds';
import { Screen } from '../../src/engine/screen';
import { TerminalState } from '../../src/engine/state';
import { TelnetSession } from '../../src/engine/telnet';
import { bytesToHex, hexToBytes, inboundBytes, loadCapture } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));

function setup(terminalType = 'IBM-3477-FC', info: { enhanced?: boolean } = {}) {
  const screen = new Screen();
  const state = new TerminalState();
  const alarms: number[] = [];
  const proc = new DataStreamProcessor(screen, state, { terminalType, ...info }, cp, { alarm: () => alarms.push(1) });
  return { screen, state, proc, alarms };
}

function signOnData(): Uint8Array {
  const capture = loadCapture('pub400-signon-3477fc');
  const records: Uint8Array[] = [];
  const telnet = new TelnetSession({ terminalType: 'IBM-3477-FC' }, { send: () => undefined, record: (r) => records.push(r) });
  telnet.feed(inboundBytes(capture));
  return parseRecord(records[0] as Uint8Array).data;
}

describe('DataStreamProcessor with the PUB400 sign-on record', () => {
  const { screen, state, proc } = setup();
  const responses = proc.process(signOnData());

  it('renders the sign-on screen text', () => {
    const rows = Array.from({ length: screen.rows }, (_, r) => screen.rowText(r, cp));
    expect(screen.rows).toBe(24);
    expect(screen.cols).toBe(80);
    expect(rows[0]).toContain('Welcome to PUB400.COM');
    expect(rows[4]?.startsWith('Your user name:')).toBe(true);
    expect(rows[5]?.startsWith('Password (max. 128):')).toBe(true);
    expect(rows[23]).toContain('(C) COPYRIGHT IBM CORP.');
  });

  it('defines the user and password fields and unlocks the keyboard', () => {
    expect(screen.fields).toHaveLength(2);
    const [user, password] = screen.fields;
    expect(user?.start).toBe(screen.addr(4, 24));
    expect(user?.length).toBe(10);
    expect(user?.monocase).toBe(true);
    expect(user?.attr).toBe(0x24);
    expect(password?.start).toBe(screen.addr(5, 24));
    expect(password?.length).toBe(128);
    expect(password?.attr).toBe(0x27); // nondisplay
    expect(screen.fields.every((f) => !f.bypass)).toBe(true);
    expect(state.inputInhibited).toBe('none');
    expect(state.pendingRead).toBe('mdt');
    expect(responses).toHaveLength(0);
  });

  it('places the cursor in the first input field', () => {
    const first = screen.fields[0];
    expect(first).toBeDefined();
    expect(screen.cursor).toBe(first?.start);
  });
});

describe('DataStreamProcessor commands', () => {
  it('Clear Unit Alternate switches to 27x132 and back', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes('042000'));
    expect([screen.rows, screen.cols]).toEqual([27, 132]);
    proc.process(hexToBytes('042080'));
    expect([screen.rows, screen.cols]).toEqual([24, 80]);
    proc.process(hexToBytes('042031'));
    expect([screen.rows, screen.cols]).toEqual([27, 132]);
    proc.process(hexToBytes('0440'));
    expect([screen.rows, screen.cols]).toEqual([24, 80]);
  });

  it('WTD writes data at SBA, repeats to address and sets the cursor', () => {
    const { screen, proc } = setup();
    // WTD cc1=00 cc2=08; SBA 2,5 "AB"; RA to 2,10 fill '-'; IC 3,1
    proc.process(hexToBytes('04110008' + '110205' + e('AB') + '02020a' + e('-') + '130301'));
    expect(screen.rowText(1, cp).slice(4, 10)).toBe('AB----');
    expect(screen.cursor).toBe(screen.addr(2, 0));
  });

  it('SF creates fields from the format word and tracks MDT', () => {
    const { screen, proc } = setup();
    // SF ffw=4000 attr=20 len=5 "abc" then attr 20 ; second SF with FCW and MDT set
    proc.process(hexToBytes('04110008' + '110101' + '1d400020000' + '5' + e('abc') + '20' + '110301' + '1d4800820027000a'));
    expect(screen.fields).toHaveLength(2);
    const [f1, f2] = screen.fields;
    expect(f1?.start).toBe(screen.addr(0, 1));
    expect(f1?.length).toBe(5);
    expect(f1?.mdt).toBe(false);
    expect(cp.decodeBytes(screen.fieldBytes(f1!))).toBe('abc  ');
    expect(f2?.fcws).toEqual([0x8200]);
    expect(f2?.attr).toBe(0x27);
    expect(f2?.length).toBe(10);
    expect(f2?.mdt).toBe(true);
  });

  it('CC1 resets MDT and nulls fields; CC2 unlocks, alarms and sets the message light', () => {
    const { screen, state, proc, alarms } = setup();
    proc.process(hexToBytes('04110008' + '110101' + '1d48002000' + '03' + e('xyz')));
    expect(screen.fields[0]?.mdt).toBe(true);
    proc.process(hexToBytes('0411a006'));
    expect(screen.fields[0]?.mdt).toBe(false);
    expect(Array.from(screen.fieldBytes(screen.fields[0]!))).toEqual([0, 0, 0]);
    expect(state.inputInhibited).toBe('system');
    expect(alarms).toHaveLength(1);
    expect(state.messageWaiting).toBe(true);
    proc.process(hexToBytes('04110009'));
    expect(state.inputInhibited).toBe('none');
    expect(state.messageWaiting).toBe(false);
  });

  it('a read command homes the cursor unless an Insert Cursor was given', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes('04110008' + '110201' + '1d4000200005' + '110301' + '1d4000200005' + '04520000'));
    expect(screen.cursor).toBe(screen.addr(1, 1));
    screen.cursor = screen.addr(2, 3); // user moved into the second field
    proc.process(hexToBytes('04110008' + '110501' + e('msg') + '04520000')); // repaint without IC
    expect(screen.cursor).toBe(screen.addr(1, 1));
    proc.process(hexToBytes('04110008' + '130203' + '04520000')); // IC then read
    expect(screen.cursor).toBe(screen.addr(1, 2));
  });

  it('a repaint discards the error row saved for Reset', () => {
    const { screen, state, proc } = setup();
    proc.process(hexToBytes('04110008' + '111801' + e('Footer') + '130101'));
    proc.process(hexToBytes('0421' + e('Not allowed')));
    expect(state.savedErrorRow).toBeDefined();
    proc.process(hexToBytes('04110008' + '110101' + e('New screen') + '04520000'));
    expect(state.savedErrorRow).toBeUndefined();
    expect(state.savedCursor).toBeUndefined();
    expect(screen.rowText(23, cp).trim()).toBe('Not allowed');
  });

  it('Roll scrolls the region', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes('04110008' + '110501' + e('top') + '110601' + e('next')));
    proc.process(hexToBytes('0423' + '01' + '05' + '06'));
    expect(screen.rowText(4, cp).trimEnd()).toBe('next');
    expect(screen.rowText(5, cp).trim()).toBe('');
  });

  it('Write Error Code puts the message on the error row and inhibits input', () => {
    const { screen, state, proc } = setup();
    proc.process(hexToBytes('04110008' + '130a05'));
    proc.process(hexToBytes('0421' + e('Password incorrect')));
    expect(screen.rowText(23, cp).trim()).toBe('Password incorrect');
    expect(state.errorMessage).toBe('Password incorrect');
    expect(state.inputInhibited).toBe('error');
    expect(state.savedCursor).toBe(screen.addr(9, 4));
  });

  it('answers a WSF Query with a 61-byte reply that declares the screen size', () => {
    const wide = setup('IBM-3477-FC');
    const r = wide.proc.process(hexToBytes('04f30005d97000'));
    expect(r).toHaveLength(1);
    expect(r[0]?.opcode).toBe(OP_NOOP);
    const reply = r[0]?.data as Uint8Array;
    expect(reply.length).toBe(61);
    expect(bytesToHex(reply.subarray(0, 7))).toBe('000088003ad970');
    expect(cp.decodeBytes(reply, 30, 34)).toBe('3477');
    expect(reply[50]).toBe(0x31);
    const narrow = setup('IBM-3179-2');
    const reply2 = narrow.proc.process(hexToBytes('04f30005d97000'))[0]?.data as Uint8Array;
    expect(cp.decodeBytes(reply2, 30, 34)).toBe('3179');
    expect(reply2[50]).toBe(0x11);
  });

  it('Read Immediate answers at once with all fields, flat format, AID 0', () => {
    const { proc } = setup();
    proc.process(hexToBytes('04110008' + '110101' + '1d400020000' + '3' + e('ab') + '130102'));
    const r = proc.process(hexToBytes('0472'));
    expect(r).toHaveLength(1);
    expect(r[0]?.opcode).toBe(OP_PUT_GET);
    expect(bytesToHex(r[0]?.data as Uint8Array)).toBe('010200' + e('ab') + '40');
  });

  it('Read MDT response sends only changed fields with SBA and trailing nulls removed', () => {
    const { screen, proc } = setup();
    proc.process(hexToBytes('04110008' + '110101' + '1d400020000' + '5' + '110201' + '1d4800200005' + e('hi')));
    const second = screen.fields[1]!;
    screen.buffer.set(cp.encodeString('hi'), second.start);
    screen.cursor = second.start + 2;
    const data = proc.readResponse('mdt', 0xf1);
    // Field data starts one position after the attribute written at row 2 col 1.
    expect(bytesToHex(data)).toBe('0204f1' + '110202' + e('hi'));
  });

  it('Save Screen returns a restorable stream that rebuilds fields', () => {
    const a = setup();
    a.proc.process(hexToBytes('04110008' + '110305' + e('Name:') + '1d4000200008' + e('Alex') + '20' + '130307'));
    const saved = a.proc.process(hexToBytes('0402'));
    expect(saved[0]?.opcode).toBe(0x04);
    const b = setup();
    b.proc.process(saved[0]?.data as Uint8Array);
    expect(b.screen.rowText(2, cp).trim()).toBe('Name: Alex');
    expect(b.screen.fields).toHaveLength(1);
    expect(b.screen.fields[0]?.length).toBe(8);
    expect(b.screen.cursor).toBe(a.screen.cursor);
  });

  it('Restore Screen restores the saved screen size (80-column wrap tricks keep working)', () => {
    const t = setup();
    // 24x80 menu: attribute at (5,80) so the text wraps to (6,1).
    t.proc.process(hexToBytes('0440' + '04110008' + '110550' + '30' + e(' 1.') + '130101'));
    expect(t.screen.rowText(5, cp).slice(0, 3)).toBe(' 1.');
    const saved = t.proc.process(hexToBytes('0402'))[0]?.data as Uint8Array;
    t.proc.process(hexToBytes('042000' + '04110008' + '110101' + e('wide')));
    expect(t.screen.cols).toBe(132);
    t.proc.process(saved);
    expect(t.screen.cols).toBe(80);
    expect(t.screen.rowText(5, cp).slice(0, 3)).toBe(' 1.');
  });

  it('Restore Screen drops fields of the screen shown in between', () => {
    const t = setup();
    t.proc.process(hexToBytes('04110008' + '110305' + e('Name:') + '1d4000200008' + e('Alex') + '20' + '130307'));
    const saved = t.proc.process(hexToBytes('0402'))[0]?.data as Uint8Array;
    // A message screen with a long field replaces the menu...
    t.proc.process(hexToBytes('0440' + '04110008' + '110101' + '1d5000240099' + e('Message line')));
    expect(t.screen.fields[0]?.length).toBe(0x99);
    // ...then the host restores the saved image.
    t.proc.process(saved);
    expect(t.screen.fields.map((f) => f.length)).toEqual([8]);
    expect(t.screen.rowText(0, cp).trim()).toBe('');
    expect(t.screen.rowText(2, cp).trim()).toBe('Name: Alex');
  });
});

describe('cursor after a window closes (Restore Screen)', () => {
  // A full-screen format written without IC and never read, then a window: the host
  // saves the screen (cursor still at 1,1), shows the window, and restores on F12.
  const FORMAT = '04110008' + '110305' + e('Name:') + '1d4000200008' + '20';
  const WINDOW = '04110008' + '110a14' + e('Pick:') + '1d4000200003' + '20' + '130a1a' + '04520000';

  it('READ after the restored image homes the cursor to the first input field', () => {
    const t = setup();
    t.proc.process(hexToBytes(FORMAT));
    expect(t.screen.cursor).toBe(0);
    const saved = t.proc.process(hexToBytes('0402'))[0]?.data as Uint8Array;
    t.proc.process(hexToBytes(WINDOW));
    expect(t.screen.cursor).toBe(t.screen.addr(9, 25));
    t.proc.process(saved); // Restore Screen replays IC 1,1
    t.proc.process(hexToBytes('04520000'));
    expect(t.screen.cursor).toBe(t.screen.fields[0]?.start);
  });

  it('a format rewritten after Restore Screen homes the cursor (menu after F3/F12)', () => {
    // Menu: option field at 20,22 and a second field at 20,68. The operator typed 1 and
    // pressed Enter (cursor at 20,23), the program saved the screen, showed another
    // format, and on F3 restores the image and rewrites the whole menu (SOH, fields)
    // before reading. The saved IC 20,23 must not survive the new header.
    const MENU = '04110008' + '0107' + '00000018' + '000804' + '111415' + '1d4020200002' + '114443' + '1d4020200008';
    const t = setup();
    t.proc.process(hexToBytes(MENU + '04520000'));
    expect(t.screen.cursor).toBe(t.screen.addr(19, 21));
    t.screen.cursor = t.screen.addr(19, 22);
    const saved = t.proc.process(hexToBytes('0402'))[0]?.data as Uint8Array;
    t.proc.process(hexToBytes('04110008' + '0107' + '00000018' + '000804' + '110305' + e('Other:') + '1d4000200008' + '20' + '04520000'));
    t.proc.process(saved);
    expect(t.screen.cursor).toBe(t.screen.addr(19, 22));
    t.proc.process(hexToBytes(MENU + '04520000'));
    expect(t.screen.cursor).toBe(t.screen.addr(19, 21));
  });

  it('Restore Screen alone keeps the saved cursor when the host reads without a new header', () => {
    const MENU = '04110008' + '0107' + '00000018' + '000804' + '111415' + '1d4020200002' + '114443' + '1d4020200008';
    const t = setup();
    t.proc.process(hexToBytes(MENU + '04520000'));
    t.screen.cursor = t.screen.addr(19, 22);
    const saved = t.proc.process(hexToBytes('0402'))[0]?.data as Uint8Array;
    t.proc.process(hexToBytes('04110008' + '0107' + '00000018' + '000804' + '110305' + e('Other:') + '1d4000200008' + '20' + '04520000'));
    t.proc.process(saved);
    t.proc.process(hexToBytes('04110000' + '04520000'));
    expect(t.screen.cursor).toBe(t.screen.addr(19, 22));
  });

  it('READ keeps a deliberate Insert Cursor on a protected cell', () => {
    const t = setup();
    t.proc.process(hexToBytes(FORMAT + '130505' + '04520000'));
    expect(t.screen.cursor).toBe(t.screen.addr(4, 4));
  });

  it('READ on a screen without input fields leaves the cursor at the top-left corner', () => {
    const t = setup();
    t.proc.process(hexToBytes('04110008' + '110305' + e('Just text') + '04520000'));
    expect(t.screen.cursor).toBe(0);
  });
});

describe('Start of Header command key switches', () => {
  // SOH data: flags, reserved, resequence, error row, then F17-24, F9-16, F1-8 (F1 = low bit).
  const soh = (keys: string): string => '0107' + '00000018' + keys;

  it('reads which keys are command attention keys', () => {
    const t = setup();
    t.proc.process(hexToBytes('04110008' + soh('000804') + '04520000')); // CA03 + CA12
    expect(t.state.caKeys).toBe((1 << 2) | (1 << 11));
    t.proc.process(hexToBytes('04110008' + soh('010005') + '04520000')); // CA01, CA03, CA17
    expect(t.state.caKeys).toBe((1 << 0) | (1 << 2) | (1 << 16));
  });

  it('treats a short header and Clear Unit as "every key returns data"', () => {
    const t = setup();
    t.proc.process(hexToBytes('04110008' + soh('000804') + '04520000'));
    t.proc.process(hexToBytes('04110008' + '0104' + '00000018' + '04520000'));
    expect(t.state.caKeys).toBe(0);
    t.proc.process(hexToBytes('04110008' + soh('000804') + '04520000'));
    t.proc.process(hexToBytes('0440'));
    expect(t.state.caKeys).toBe(0);
  });

  it('keeps the keys of a saved screen through Restore Screen', () => {
    const t = setup();
    t.proc.process(hexToBytes('04110008' + soh('000804') + '110305' + e('Name:') + '1d4000200008'));
    const saved = t.proc.process(hexToBytes('0402'))[0]?.data as Uint8Array;
    t.proc.process(hexToBytes('0440' + '04110008' + soh('000000') + '110101' + e('win')));
    expect(t.state.caKeys).toBe(0);
    t.proc.process(saved);
    expect(t.state.caKeys).toBe((1 << 2) | (1 << 11));
    expect(t.screen.errorRow).toBe(23);
  });
});

describe('enhanced 5250: GUI windows', () => {
  // Base screen: a label and an input field on row 8, a protected field on row 12.
  const BASE = '04110008' + '0107' + '00000018' + '000004' + '110802' + e('Name:') + '1d4000200008' + '110c02' + e('Below the window') + '04520000';
  // WTD: SBA 7,30, Create Window (depth 5, width 20) with a border minor structure:
  // flags 0, mono 0x21, colour 0x3b, corners/edges '.', '-', '.', '|', '|', ':', '-', ':'.
  const sfBody = 'd951' + '00' + '0000' + '05' + '14' + '0d01' + '00' + '21' + '3b' + '4b604b4f4f7a607a';
  const CREATE = '15' + ((sfBody.length / 2) + 2).toString(16).padStart(4, '0') + sfBody;
  const WINDOW = '04110000' + '11071e' + CREATE + '110821' + e('In the window') + '1d4000200003' + '04520000';
  const REMOVE = '04110000' + '11071e' + '15' + '0007' + 'd959' + '000000' + '04520000';

  function withWindow() {
    const t = setup('IBM-3477-FC', { enhanced: true });
    t.proc.process(hexToBytes(BASE));
    const before = t.screen.buffer.slice();
    t.proc.process(hexToBytes(WINDOW));
    return { t, before };
  }

  it('answers the Query as an enhanced display', () => {
    const t = setup('IBM-3477-FC', { enhanced: true });
    const reply = t.proc.process(hexToBytes('04f30005d97000'))[0]?.data as Uint8Array;
    expect(reply.length).toBe(67);
    expect(reply[4]).toBe(0x40);
    expect(reply[53]).toBe(0x02);
    expect(reply[54]).toBe(0x80);
    expect((setup().proc.process(hexToBytes('04f30005d97000'))[0]?.data as Uint8Array).length).toBe(61);
  });

  it('Create Window draws the border at the write address and clears the inside', () => {
    const { t } = withWindow();
    const s = t.screen;
    // Top border: attribute, upper-left, dashes, upper-right, reset.
    expect(s.buffer[s.addr(6, 29)]).toBe(0x3b);
    expect(s.buffer[s.addr(6, 30)]).toBe(0x4b);
    expect(s.buffer[s.addr(6, 31)]).toBe(0x60);
    expect(s.buffer[s.addr(6, 30 + 22)]).toBe(0x60);
    expect(s.buffer[s.addr(6, 30 + 23)]).toBe(0x4b);
    expect(s.buffer[s.addr(6, 30 + 24)]).toBe(0x20);
    // Side borders on the first usable row, bottom border row.
    expect(s.buffer[s.addr(7, 30)]).toBe(0x4f);
    expect(s.buffer[s.addr(7, 30 + 23)]).toBe(0x4f);
    expect(s.buffer[s.addr(12, 30)]).toBe(0x7a);
    // What the base screen had under the window is gone, the window's text is there.
    expect(t.screen.rowText(7, cp).slice(32, 47)).toBe('In the window  ');
    expect(t.screen.rowText(11, cp).slice(1, 17)).toBe('Below the window');
    expect(s.windows).toHaveLength(1);
    // The base field sits left of the window and stays; the window adds its own.
    expect(s.fields.map((f) => f.start)).toEqual([s.addr(7, 7), s.addr(7, 46)]);
  });

  it('Remove GUI Window restores the covered cells and fields', () => {
    const { t, before } = withWindow();
    t.proc.process(hexToBytes(REMOVE));
    expect(Array.from(t.screen.buffer)).toEqual(Array.from(before));
    expect(t.screen.windows).toHaveLength(0);
    expect(t.screen.fields.map((f) => f.start)).toEqual([t.screen.addr(7, 7)]);
  });

  it('Remove All GUI Constructs closes every window, newest first', () => {
    const { t, before } = withWindow();
    t.proc.process(hexToBytes('04110000' + '110a28' + CREATE + '04520000'));
    expect(t.screen.windows).toHaveLength(2);
    t.proc.process(hexToBytes('04110000' + '15' + '0007' + 'd95f' + '000000' + '04520000'));
    expect(Array.from(t.screen.buffer)).toEqual(Array.from(before));
  });

  it('Save Partial Screen answers an image that restores with Restore Partial Screen', () => {
    const t = setup('IBM-3477-FC', { enhanced: true });
    t.proc.process(hexToBytes(BASE));
    const before = t.screen.buffer.slice();
    const saved = t.proc.process(hexToBytes('0403' + '00' + '07' + '1e' + '05' + '14'))[0]?.data as Uint8Array;
    expect(bytesToHex(saved.subarray(0, 2))).toBe('0413');
    t.proc.process(hexToBytes(WINDOW));
    t.proc.process(saved);
    expect(Array.from(t.screen.buffer)).toEqual(Array.from(before));
    expect(t.screen.windows).toHaveLength(0);
    expect(t.screen.fields.map((f) => f.start)).toEqual([t.screen.addr(7, 7)]);
  });
});
