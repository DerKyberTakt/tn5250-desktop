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

function setup(terminalType = 'IBM-3477-FC') {
  const screen = new Screen();
  const state = new TerminalState();
  const alarms: number[] = [];
  const proc = new DataStreamProcessor(screen, state, { terminalType }, cp, { alarm: () => alarms.push(1) });
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
