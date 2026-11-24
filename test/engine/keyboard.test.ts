import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { FLAG_ATN, FLAG_SRQ, FLAG_TRQ, OP_NOOP, OP_PUT_GET, parseRecord } from '../../src/engine/gds';
import { Session5250 } from '../../src/engine/session';
import { bytesToHex, hexToBytes, inboundBytes, loadCapture } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));

interface Sent {
  opcode: number;
  flags1: number;
  data: string;
}

/** A session with the socket replaced by a list of parsed outbound records. */
function harness(screenSize: '24x80' | '27x132' = '24x80') {
  const sent: Sent[] = [];
  const session = new Session5250(
    { screenSize, codePage: 37 },
    {
      send: (bytes) => {
        // Skip telnet negotiation replies (they do not end with IAC EOR).
        if (bytes.length >= 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xef) {
          const rec = parseRecord(bytes.subarray(0, bytes.length - 2));
          sent.push({ opcode: rec.opcode, flags1: rec.flags1, data: bytesToHex(rec.data) });
        }
      },
    },
  );
  /** Feeds a host record (payload after the GDS header) as if it arrived on the wire. */
  const host = (hex: string): void => {
    const payload = hexToBytes(hex);
    const total = 10 + payload.length;
    const header = [(total >> 8) & 0xff, total & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, 0x03];
    session.feed(Uint8Array.from([...header, ...payload, 0xff, 0xef]));
  };
  return { session, sent, host, screen: session.screen, state: session.state };
}

/** Like TWO_FIELDS, but the first field is field-exit-required (ffw 4040 -> 4048). */
const FER_FIELDS = '04110008' + '110201' + '1d4048200005' + '110301' + '1d4300200006' + '130202' + '0452' + '0000';
const text = (h: ReturnType<typeof harness>, i: number): string => cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[i]!));

/** Two fields: a 5-char alpha field at row 2 col 2 and a 6-char numeric-only field at row 3 col 2. */
const TWO_FIELDS = '04110008' + '110201' + '1d4000200005' + '110301' + '1d4300200006' + '130202' + '0452' + '0000';

describe('Keyboard on the PUB400 sign-on screen', () => {
  it('types the user name in monocase, tabs to the password and sends Enter', () => {
    const h = harness('27x132');
    h.session.feed(inboundBytes(loadCapture('pub400-signon-3477fc')));
    expect(h.state.inputInhibited).toBe('none');
    h.session.type('alex');
    expect(h.screen.rowText(4, cp)).toContain('ALEX');
    h.session.press('tab');
    expect(h.screen.cursor).toBe(h.screen.addr(5, 24));
    h.session.type('secret');
    h.session.press('enter');
    expect(h.sent).toHaveLength(1);
    const rec = h.sent[0]!;
    expect(rec.opcode).toBe(OP_PUT_GET);
    expect(rec.data).toBe('061f' + 'f1' + '110519' + e('ALEX') + '110619' + e('secret'));
    expect(h.state.inputInhibited).toBe('system');
    h.session.type('ignored while locked');
    expect(h.sent).toHaveLength(1);
  });
});

describe('Keyboard editing', () => {
  it('reports 0005 when typing in a protected area and Reset clears it', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.screen.cursor = 0;
    h.session.type('x');
    expect(h.state.inputInhibited).toBe('error');
    expect(h.state.errorMessage).toMatch(/^0005 /);
    h.session.press('fieldExit');
    expect(h.state.inputInhibited).toBe('error'); // editing keys stay blocked
    h.session.press('reset');
    expect(h.state.inputInhibited).toBe('none');
    expect(h.state.errorMessage).toBe('');
    // Cursor movement and clicks also leave the error state.
    h.screen.cursor = 0;
    h.session.type('x');
    expect(h.state.inputInhibited).toBe('error');
    h.session.press('tab');
    expect(h.state.inputInhibited).toBe('none');
    expect(h.screen.cursor).toBe(h.screen.fields[0]?.start);
    h.session.type('x');
    h.screen.cursor = 0;
    h.session.type('x');
    h.session.setCursor(1, 2);
    expect(h.state.inputInhibited).toBe('none');
  });

  it('auto-advances to the next field after the last character', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('abcde');
    expect(h.screen.cursor).toBe(h.screen.addr(2, 1));
    expect(h.screen.fields[0]?.mdt).toBe(true);
  });

  it('rejects letters in a numeric-only field with 0009', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.press('tab');
    h.session.type('1a');
    expect(h.state.errorMessage).toMatch(/^0009 /);
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[1]!))).toBe('1     ');
  });

  it('insert mode shifts characters right and refuses when the field is full', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('ace');
    h.session.press('home');
    h.session.press('right');
    h.session.press('insert');
    expect(h.state.insert).toBe(true);
    h.session.type('b');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[0]!))).toBe('abce ');
    h.session.type('d');
    h.session.type('x');
    expect(h.state.errorMessage).toMatch(/^0012 /);
  });

  it('Field Exit erases to the end of the field and moves on; Field Minus negates numerics', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('abcde');
    h.session.press('backtab');
    h.session.press('right');
    h.session.press('right');
    h.session.press('fieldExit');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[0]!))).toBe('ab   ');
    expect(h.screen.cursor).toBe(h.screen.fields[1]?.start);
    h.session.type('125');
    h.session.press('fieldMinus');
    const bytes = Array.from(h.screen.fieldBytes(h.screen.fields[1]!));
    expect(bytes.slice(0, 3)).toEqual([0xf1, 0xf2, 0xd5]);
    // Field Minus wrapped the cursor to the alphabetic field; it is not allowed there.
    expect(h.screen.cursor).toBe(h.screen.fields[0]?.start);
    h.session.press('fieldMinus');
    expect(h.state.errorMessage).toMatch(/^0016 /);
  });

  it('right-adjusts with zero fill and handles signed numeric fields', () => {
    const h = harness();
    // field 1: numeric only, right adjust zero fill (ffw 4305); field 2: signed numeric (ffw 4700), len 5
    h.host('04110008' + '110201' + '1d4305200006' + '110301' + '1d4700200005' + '130202' + '04520000');
    h.session.type('42');
    h.session.press('fieldExit');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[0]!))).toBe('000042');
    h.session.type('17');
    h.session.press('fieldMinus');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[1]!))).toBe('  17-');
  });

  it('Erase EOF, Delete and Backspace edit within the field', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('abcde');
    h.session.press('backtab');
    h.session.press('right');
    h.session.press('delete');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[0]!))).toBe('acde ');
    h.session.press('right');
    h.session.press('backspace');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[0]!))).toBe('ade  ');
    h.session.press('right');
    h.session.press('eraseEof');
    expect(cp.decodeBytes(h.screen.fieldBytes(h.screen.fields[0]!))).toBe('ad   ');
  });

  it('Erase Input clears every field and homes the cursor', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('abcde');
    h.session.type('123');
    h.session.press('eraseInput');
    expect(h.screen.fields.every((f) => !f.mdt)).toBe(true);
    expect(h.screen.rowText(1, cp).trim()).toBe('');
    expect(h.screen.cursor).toBe(h.screen.fields[0]?.start);
  });

  it('Dup fills with the DUP character only where allowed', () => {
    const h = harness();
    h.host('04110008' + '110201' + '1d5000200004' + '110301' + '1d4000200004' + '130202' + '04520000');
    h.session.press('dup');
    expect(Array.from(h.screen.fieldBytes(h.screen.fields[0]!))).toEqual([0x1c, 0x1c, 0x1c, 0x1c]);
    expect(h.screen.cursor).toBe(h.screen.fields[1]?.start);
    h.session.press('dup');
    expect(h.state.errorMessage).toMatch(/^0019 /);
  });

  it('Attn and SysReq send flag-only records', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.press('attn');
    h.session.press('sysreq');
    expect(h.sent.map((s) => [s.opcode, s.flags1, s.data])).toEqual([
      [OP_NOOP, FLAG_ATN, ''],
      [OP_NOOP, FLAG_SRQ, ''],
    ]);
  });

  it('Attn and SysReq still go out while the host has the keyboard locked', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.press('enter');
    expect(h.state.inputInhibited).toBe('system');
    h.session.press('pf3'); // ordinary keys stay locked out
    h.session.press('sysreq');
    h.session.press('attn');
    expect(h.sent.slice(1).map((s) => [s.opcode, s.flags1, s.data])).toEqual([
      [OP_NOOP, FLAG_SRQ, ''],
      [OP_NOOP, FLAG_ATN, ''],
    ]);
  });

  it('function keys send their AID with the Read Input Fields flat format when requested', () => {
    const h = harness();
    h.host('04110008' + '110201' + '1d4000200003' + '130202' + '0442' + '0000');
    h.session.type('ab');
    h.session.press('pf3');
    expect(h.sent[0]?.data).toBe('0204' + '33' + e('ab') + '40');
    h.host('04110008' + '0452' + '0000');
    h.session.press('pf13');
    expect(h.sent[1]?.data.slice(4, 6)).toBe('b1');
  });

  it('auto-enter fields transmit when filled; mandatory enter blocks Enter with 0007', () => {
    const h = harness();
    // field 1 auto-enter (ffw 4080) len 2; field 2 mandatory enter (ffw 4008) len 3
    h.host('04110008' + '110201' + '1d4080200002' + '110301' + '1d4008200003' + '130202' + '04520000');
    h.session.press('enter');
    expect(h.sent).toHaveLength(0);
    expect(h.state.errorMessage).toMatch(/^0007 /);
    expect(h.screen.cursor).toBe(h.screen.fields[1]?.start);
    h.session.press('reset');
    h.session.type('xyz');
    h.session.press('home');
    h.session.type('12');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.data.slice(4, 6)).toBe('3f');
  });

  it('cursor keys wrap around the screen and newline finds the next field', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.screen.cursor = 0;
    h.session.press('left');
    expect(h.screen.cursor).toBe(h.screen.size - 1);
    h.session.press('down');
    expect(h.screen.cursor).toBe(h.screen.cols - 1);
    h.session.press('newline');
    expect(h.screen.cursor).toBe(h.screen.fields[0]?.start);
  });
});

describe('ACS cursor and edit functions (0.1.5)', () => {
  it('fast cursor moves three cells or rows and wraps like the arrows', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.screen.cursor = 0;
    h.session.press('fastRight');
    expect(h.screen.cursor).toBe(3);
    h.session.press('fastDown');
    expect(h.screen.cursor).toBe(3 + 3 * h.screen.cols);
    h.screen.cursor = 0;
    h.session.press('fastLeft');
    expect(h.screen.cursor).toBe(h.screen.size - 3);
    h.screen.cursor = 0;
    h.session.press('fastUp');
    expect(h.screen.cursor).toBe(h.screen.size - 3 * h.screen.cols);
  });

  it('Tab Word and Backtab Word jump between word starts anywhere on the screen', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    const f0 = h.screen.fields[0]!;
    const f1 = h.screen.fields[1]!;
    h.screen.cursor = f0.start;
    h.session.type('ab');
    h.session.press('tab');
    h.session.type('12');
    h.screen.cursor = f0.start;
    h.session.press('wordRight');
    expect(h.screen.cursor).toBe(f1.start);
    h.session.press('wordRight'); // wraps to the first word again
    expect(h.screen.cursor).toBe(f0.start);
    h.screen.cursor = f1.start + 1;
    h.session.press('wordLeft'); // start of the current word first
    expect(h.screen.cursor).toBe(f1.start);
    h.session.press('wordLeft');
    expect(h.screen.cursor).toBe(f0.start);
  });

  it('Beginning of Field goes to the field start and reports 0005 outside a field', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    const f0 = h.screen.fields[0]!;
    h.screen.cursor = f0.start + 3;
    h.session.press('beginningOfField');
    expect(h.screen.cursor).toBe(f0.start);
    h.screen.cursor = 0;
    h.session.press('beginningOfField');
    expect(h.state.inputInhibited).toBe('error');
    expect(h.state.errorMessage.startsWith('0005')).toBe(true);
  });

  it('Delete Word removes the word under the cursor and the blanks after it, within the field', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    const f0 = h.screen.fields[0]!;
    h.screen.cursor = f0.start;
    h.session.type('ab cd'); // fills the 5-char field and auto-advances
    h.screen.cursor = f0.start;
    h.session.press('deleteWord');
    expect(bytesToHex(h.screen.fieldBytes(f0))).toBe(e('cd') + '000000');
    expect(f0.mdt).toBe(true);
    expect(h.screen.cursor).toBe(f0.start);
    expect(bytesToHex(h.screen.fieldBytes(h.screen.fields[1]!))).toBe('000000000000');
  });

  it('Erase Field clears the whole field and puts the cursor at its start', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    const f0 = h.screen.fields[0]!;
    h.screen.cursor = f0.start;
    h.session.type('abc');
    h.screen.cursor = f0.start + 1;
    h.session.press('eraseField');
    expect(bytesToHex(h.screen.fieldBytes(f0))).toBe('0000000000');
    expect(h.screen.cursor).toBe(f0.start);
    expect(f0.mdt).toBe(true);
  });

  it('Test Request sends a record with the TRQ flag and no data', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.press('testRequest');
    expect(h.sent.map((s) => [s.opcode, s.flags1, s.data])).toEqual([[OP_NOOP, FLAG_TRQ, '']]);
  });
});

describe('past the end of a full field-exit-required field', () => {
  it('the last character stays on typing and survives Field Exit', () => {
    const h = harness();
    h.host(FER_FIELDS);
    h.session.type('abcde');
    expect(h.screen.cursor).toBe(h.screen.fields[0]!.end - 1);
    h.session.press('fieldExit');
    expect(text(h, 0)).toBe('abcde');
    expect(h.screen.cursor).toBe(h.screen.fields[1]?.start);
  });

  it('typing past the end reports 0020 until the cursor moves', () => {
    const h = harness();
    h.host(FER_FIELDS);
    h.session.type('abcdef');
    expect(h.state.errorMessage).toMatch(/^0020 /);
    expect(text(h, 0)).toBe('abcde');
    h.session.press('reset');
    h.session.type('x');
    expect(h.state.errorMessage).toMatch(/^0020 /);
    h.session.press('left'); // onto the 'd'
    h.session.type('x');
    expect(text(h, 0)).toBe('abcxe');
  });

  it('Erase EOF past the end keeps the field; one cell back it erases', () => {
    const h = harness();
    h.host(FER_FIELDS);
    h.session.type('abcde');
    h.session.press('eraseEof');
    expect(text(h, 0)).toBe('abcde');
    h.session.press('left'); // onto the 'd'
    h.session.press('eraseEof');
    expect(text(h, 0)).toBe('abc  ');
  });

  it('Backspace past the end removes the last character, then works as usual', () => {
    const h = harness();
    h.host(FER_FIELDS);
    h.session.type('abcde');
    h.session.press('backspace');
    expect(text(h, 0)).toBe('abcd ');
    expect(h.screen.cursor).toBe(h.screen.fields[0]!.end - 1);
    h.session.press('backspace');
    expect(text(h, 0)).toBe('abc  ');
    h.session.type('xy');
    expect(text(h, 0)).toBe('abcxy');
  });

  it('a click, a host write and Insert end the past-the-end state', () => {
    for (const leave of ['click', 'host', 'insert'] as const) {
      const h = harness();
      h.host(FER_FIELDS);
      h.session.type('abcde');
      if (leave === 'click') h.session.setCursor(1, 5);
      if (leave === 'host') h.host('04110008' + '110501' + e('msg') + '130206' + '04520000');
      if (leave === 'insert') h.session.press('insert');
      h.session.press('fieldExit');
      expect(text(h, 0), leave).toBe('abcd ');
    }
  });
});

describe('Field Exit right after an automatic advance (paste)', () => {
  it('does not erase the field it just moved into; a later Field Exit does', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    h.session.type('42');
    h.session.setCursor(1, 1);
    h.session.type('abcde'); // fills field 1, advances to field 2
    expect(h.screen.cursor).toBe(h.screen.fields[1]?.start);
    h.session.press('fieldExit');
    expect(text(h, 1)).toBe('42    ');
    expect(h.screen.cursor).toBe(h.screen.fields[1]?.start);
    h.session.press('fieldExit');
    expect(text(h, 1)).toBe('      ');
  });

  it('erases as usual when another key came in between', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    h.session.type('42');
    h.session.setCursor(1, 1);
    h.session.type('abcde');
    h.session.press('right');
    h.session.press('left');
    h.session.press('fieldExit');
    expect(text(h, 1)).toBe('      ');
  });
});

describe('Auto Enter (DDS CHECK(ER))', () => {
  /** Field 1 auto enter (ffw 4080); field 2 numeric. */
  const AE_FIELDS = '04110008' + '110201' + '1d4080200005' + '110301' + '1d4300200006' + '130202' + '0452' + '0000';
  /** Field 1 auto enter and field exit required (ffw 40c0): CHECK(FE) with CHECK(ER). */
  const AE_FER_FIELDS = '04110008' + '110201' + '1d40c0200005' + '110301' + '1d4300200006' + '130202' + '0452' + '0000';

  it('sends the Enter when the last character fills the field', () => {
    const h = harness();
    h.host(AE_FIELDS);
    h.session.type('abcde');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.data.slice(4, 6)).toBe('3f'); // AID 0x3f Auto Enter
  });

  it('with Field Exit Required waits for the Field Exit, as ACS does', () => {
    const h = harness();
    h.host(AE_FER_FIELDS);
    h.session.type('abcde');
    expect(h.sent).toHaveLength(0);
    expect(h.state.cursorPastEnd).toBe(true);
    expect(text(h, 0)).toBe('abcde');
    h.session.press('fieldExit');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.data.slice(4, 6)).toBe('3f');
    expect(text(h, 0)).toBe('abcde');
  });
});

describe('End of Field', () => {
  it('moves just after the last typed character', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('ab');
    h.session.press('home');
    h.session.press('endOfField');
    expect(h.screen.cursor).toBe(h.screen.fields[0]!.start + 2);
  });

  it('on a full field goes to the last cell past the end, so Field Exit keeps the text', () => {
    const h = harness();
    h.host(FER_FIELDS);
    h.session.type('abcde');
    h.session.press('home');
    h.session.press('endOfField');
    expect(h.screen.cursor).toBe(h.screen.fields[0]!.end - 1);
    h.session.press('fieldExit');
    expect(text(h, 0)).toBe('abcde');
  });

  it('goes to the start of an empty field and reports 0005 outside a field', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.press('right');
    h.session.press('endOfField');
    expect(h.screen.cursor).toBe(h.screen.fields[0]?.start);
    h.screen.cursor = 0;
    h.session.press('endOfField');
    expect(h.state.errorMessage).toMatch(/^0005 /);
  });
});

describe('command attention keys send no field data', () => {
  // Alpha field at row 2 col 2; the header marks F3 and F12 as CA keys.
  const CA_SCREEN = '04110008' + '0107' + '00000018' + '000804' + '110201' + '1d4000200005' + '130202' + '0452' + '0000';

  it('F3 sends only the cursor and AID; F5 and Enter send what was typed', () => {
    const h = harness();
    h.host(CA_SCREEN);
    h.session.type('1');
    h.session.press('pf3');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.data).toBe('0203' + '33');
    h.host('04110008' + '0107' + '00000018' + '000804' + '110201' + '1d4000200005' + '130202' + '04520000');
    h.session.type('1');
    h.session.press('pf5');
    expect(h.sent[1]!.data).toBe('0203' + '35' + '110202' + e('1'));
  });

  it('a CA key does not trip the mandatory-enter check', () => {
    const h = harness();
    // Mandatory enter field (ffw bit 0x0008 of the second byte: 4008)
    h.host('04110008' + '0107' + '00000018' + '000804' + '110201' + '1d4008200005' + '130202' + '04520000');
    h.session.press('pf3');
    expect(h.sent).toHaveLength(1);
    expect(h.state.errorMessage).toBe('');
    h.host('04110008' + '0107' + '00000018' + '000804' + '110201' + '1d4008200005' + '130202' + '04520000');
    h.session.press('enter');
    expect(h.state.errorMessage).toMatch(/^0007 /);
  });

  it('without the header bytes every key sends data', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.type('1');
    h.session.press('pf3');
    expect(h.sent[0]!.data).toBe('0203' + '33' + '110202' + e('1'));
  });
});

describe('Paste', () => {
  /** Like TWO_FIELDS, with the second field on row 4: row 3 is protected. */
  const GAP_FIELDS = '04110008' + '110201' + '1d4000200005' + '110401' + '1d4300200006' + '130202' + '0452' + '0000';
  const PASTE = { fieldWrap: true, stopAtProtected: true, moveCursorToEnd: true, tabMode: 'spaces' as const, tabSpaces: 1, tabColumns: 4 };

  it('puts each line one row down at the column the paste started in', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('abc\r\n12', PASTE);
    expect(text(h, 0)).toBe('abc  ');
    expect(text(h, 1)).toBe('12    ');
    expect(h.screen.cursor).toBe(h.screen.addr(2, 3));
    expect(h.state.inputInhibited).toBe('none');
  });

  it('keeps the first line when the screen has one entry field below the cursor (command line, STRSQL)', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    h.session.paste('12\n34\n56', PASTE);
    expect(text(h, 1)).toBe('12    ');
    expect(text(h, 0)).toBe('     ');
    expect(h.state.inputInhibited).toBe('none');
  });

  it('skips a protected row when Stop at protected line is off, stops on it when on', () => {
    const on = harness();
    on.host(GAP_FIELDS);
    on.session.setCursor(1, 1);
    on.session.paste('abc\n12', PASTE);
    expect(text(on, 0)).toBe('abc  ');
    expect(text(on, 1)).toBe('      ');
    const off = harness();
    off.host(GAP_FIELDS);
    off.session.setCursor(1, 1);
    off.session.paste('abc\n12', { ...PASTE, stopAtProtected: false });
    expect(text(off, 0)).toBe('abc  ');
    expect(text(off, 1)).toBe('12    ');
  });

  it('Field Wrap carries a long line into the next field; off cuts it', () => {
    const wrap = harness();
    wrap.host(TWO_FIELDS);
    wrap.session.setCursor(1, 1);
    wrap.session.paste('abcde123', PASTE);
    expect(text(wrap, 0)).toBe('abcde');
    expect(text(wrap, 1)).toBe('123   ');
    const cut = harness();
    cut.host(TWO_FIELDS);
    cut.session.setCursor(1, 1);
    cut.session.paste('abcde123', { ...PASTE, fieldWrap: false });
    expect(text(cut, 0)).toBe('abcde');
    expect(text(cut, 1)).toBe('      ');
    expect(cut.state.inputInhibited).toBe('none');
  });

  it('returns the cursor to the start when Move cursor to end is off', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('ab\n12', { ...PASTE, moveCursorToEnd: false });
    expect(text(h, 1)).toBe('12    ');
    expect(h.screen.cursor).toBe(h.screen.addr(1, 1));
  });

  it('ignores a trailing line break and clears an operator error it raised', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    h.session.paste('12\n', PASTE);
    expect(text(h, 1)).toBe('12    ');
    expect(h.screen.cursor).toBe(h.screen.addr(2, 3));
    const e = harness();
    e.host(TWO_FIELDS);
    e.session.setCursor(2, 1);
    e.session.paste('3x4', PASTE); // x is not valid in a numeric-only field: the paste ends there
    expect(text(e, 1)).toBe('3     ');
    expect(e.state.inputInhibited).toBe('none');
  });

  it('a tab moves to the next field when Tab characters = Paste data to fields', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('ab\t12', { ...PASTE, tabMode: 'nextField' });
    expect(text(h, 0)).toBe('ab   ');
    expect(text(h, 1)).toBe('12    ');
  });
});

describe('Paste Next', () => {
  const GAP_FIELDS = '04110008' + '110201' + '1d4000200005' + '110401' + '1d4300200006' + '130202' + '0452' + '0000';
  /** Like TWO_FIELDS, with the second (last) field field-exit-required (ffw 4300 -> 4340). */
  const FER_LAST = '04110008' + '110201' + '1d4000200005' + '110301' + '1d4340200006' + '130202' + '0452' + '0000';
  const PASTE = { fieldWrap: true, stopAtProtected: true, moveCursorToEnd: true, tabMode: 'spaces' as const, tabSpaces: 1, tabColumns: 4 };

  it('keeps what a protected row stopped and pastes it at the cursor on the next screen', () => {
    const h = harness();
    h.host(GAP_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('abc\n12\n34', PASTE);
    expect(text(h, 0)).toBe('abc  ');
    expect(text(h, 1)).toBe('      ');
    expect(h.session.oia(true).pasteNext).toBe(true);
    h.session.press('enter');
    h.host('0440' + TWO_FIELDS);
    expect(h.state.inputInhibited).toBe('none');
    h.session.press('pasteNext');
    expect(text(h, 0)).toBe('12   ');
    expect(text(h, 1)).toBe('34    ');
    expect(h.session.oia(true).pasteNext).toBe(false);
  });

  it('pressed while the host has the keyboard locked, waits for the next screen (type-ahead)', () => {
    const h = harness();
    h.host(GAP_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('abc\n12', PASTE);
    h.session.press('enter');
    h.session.press('pasteNext');
    expect(h.session.queuedKeys).toBe(1);
    h.host('0440' + TWO_FIELDS);
    expect(text(h, 0)).toBe('12   ');
    expect(h.session.oia(true).pasteNext).toBe(false);
  });

  it('keeps the lines below the last input row, Stop at protected line on or off', () => {
    for (const stopAtProtected of [true, false]) {
      const h = harness();
      h.host(TWO_FIELDS);
      h.session.setCursor(2, 1);
      h.session.paste('12\n34\n56', { ...PASTE, stopAtProtected });
      expect(text(h, 1)).toBe('12    ');
      h.session.setCursor(1, 1);
      h.session.press('pasteNext');
      expect(text(h, 0)).toBe('34   ');
      expect(text(h, 1)).toBe('56    ');
    }
  });

  it('keeps the rest from a character the field refused', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    const before = h.state.refused;
    h.session.paste('3x4\n5', PASTE); // x is not valid in a numeric-only field
    expect(text(h, 1)).toBe('3     ');
    expect(h.state.inputInhibited).toBe('none');
    expect(h.state.refused).toBe(before + 2); // the operator error, and the paste that left text over
    h.session.setCursor(1, 1);
    h.session.press('pasteNext');
    expect(text(h, 0)).toBe('x4   ');
    expect(text(h, 1)).toBe('5     ');
  });

  it('stops when the last field of the screen is full instead of going on in the first one', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    h.session.paste('1234567890', PASTE);
    expect(text(h, 1)).toBe('123456');
    expect(text(h, 0)).toBe('     ');
    expect(h.session.oia(true).pasteNext).toBe(true);
    h.session.setCursor(1, 1);
    h.session.press('pasteNext');
    expect(text(h, 0)).toBe('7890 ');
  });

  it('stops the same way when the last field is field exit required', () => {
    const h = harness();
    h.host(FER_LAST);
    h.session.setCursor(2, 1);
    h.session.paste('1234567', PASTE);
    expect(text(h, 1)).toBe('123456');
    expect(text(h, 0)).toBe('     ');
    expect(h.session.oia(true).pasteNext).toBe(true);
  });

  it('still sends the Enter of an auto enter last field, and keeps what follows', () => {
    const h = harness();
    h.host(FER_LAST.replace('1d4340200006', '1d43c0200006')); // + auto enter (ffw 4340 -> 43c0)
    h.session.setCursor(2, 1);
    h.session.paste('1234567', PASTE);
    expect(h.sent).toHaveLength(1);
    expect(h.state.inputInhibited).toBe('system');
    expect(h.session.oia(true).pasteNext).toBe(true);
  });

  it('a tab in the last field keeps the text after it instead of going back to the first field', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    h.session.paste('12\tab', { ...PASTE, tabMode: 'nextField' });
    expect(text(h, 1)).toBe('12    ');
    expect(text(h, 0)).toBe('     ');
    h.session.setCursor(1, 1);
    h.session.press('pasteNext');
    expect(text(h, 0)).toBe('ab   ');
  });

  it('with nothing left pastes nothing and counts as a refused key', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('ab', PASTE);
    expect(h.session.oia(true).pasteNext).toBe(false);
    const before = h.state.refused;
    h.session.press('pasteNext');
    expect(text(h, 0)).toBe('ab   ');
    expect(h.state.refused).toBe(before + 1);
  });

  it('a paste the keyboard refused leaves the earlier rest in place', () => {
    const h = harness();
    h.host(GAP_FIELDS);
    h.session.setCursor(1, 1);
    h.session.paste('abc\n12', PASTE);
    h.session.setCursor(3, 1);
    h.session.type('x'); // operator error: numeric-only field
    expect(h.state.inputInhibited).toBe('error');
    h.session.paste('zz', PASTE);
    expect(h.session.oia(true).pasteNext).toBe(true);
  });
});

describe('Refused keys (error sound)', () => {
  it('counts operator errors and keys pressed during one, not the arrow key that ends it', () => {
    const h = harness();
    h.host(TWO_FIELDS);
    h.session.setCursor(2, 1);
    const start = h.state.refused;
    h.session.type('x'); // 0009 in a numeric-only field
    expect(h.state.refused).toBe(start + 1);
    h.session.type('y');
    h.session.press('enter');
    expect(h.state.refused).toBe(start + 3);
    h.session.press('right');
    expect(h.state.inputInhibited).toBe('none');
    expect(h.state.refused).toBe(start + 3);
    expect(h.session.oia(true).refused).toBe(start + 3);
  });

  it('counts keys and pastes while the host has the keyboard locked and type-ahead is off, not local actions', () => {
    const session = new Session5250({ typeAhead: false }, { send: () => undefined });
    expect(session.state.inputInhibited).toBe('system');
    session.type('X');
    session.press('pf3');
    session.paste('abc', { fieldWrap: true, stopAtProtected: true, moveCursorToEnd: true, tabMode: 'spaces', tabSpaces: 1, tabColumns: 4 });
    session.press('copy');
    expect(session.state.refused).toBe(3);
  });
});
