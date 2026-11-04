import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { Session5250 } from '../../src/engine/session';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));
const h = (n: number): string => n.toString(16).padStart(2, '0');
const SBA = (row: number, col: number): string => '11' + h(row) + h(col);

/** A host record (payload after the GDS header) framed as it arrives on the wire. */
function frame(hex: string): Uint8Array {
  const payload = hexToBytes(hex);
  const total = 10 + payload.length;
  const header = [(total >> 8) & 0xff, total & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, 0x03];
  return Uint8Array.from([...header, ...payload, 0xff, 0xef]);
}

/** A Sign On-like screen: a visible user field (row 6) and a non-display password field (row 7). */
const SIGNON = '04110008' + SBA(6, 10) + '1d4000200010' + SBA(7, 10) + '1d4000270010' + '0452' + '0000';

function setup() {
  const sent: Array<{ wire: string; trace: string }> = [];
  const session = new Session5250({ codePage: 37 }, { send: (b, t) => sent.push({ wire: bytesToHex(b), trace: bytesToHex(t ?? b) }) });
  return { session, sent };
}

describe('non-display fields and the trace', () => {
  it('the trace copy of a read response blanks the password but keeps the length', () => {
    const { session, sent } = setup();
    session.feed(frame(SIGNON));
    session.type('alex');
    session.press('tab');
    session.type('s3cret');
    session.press('enter');
    const out = sent[sent.length - 1]!;
    expect(out.wire).toContain(e('ALEX'.toLowerCase()) === e('alex') ? e('alex') : e('alex'));
    expect(out.wire).toContain(e('s3cret'));
    expect(out.trace).not.toContain(e('s3cret'));
    expect(out.trace).toContain(e('alex'));
    expect(out.trace.length).toBe(out.wire.length);
    // The blanked bytes sit where the password was.
    const at = out.wire.indexOf(e('s3cret'));
    expect(out.trace.slice(at, at + e('s3cret').length)).toBe('40'.repeat(6));
  });

  it('a Read Input Fields response (flat format) is blanked too', () => {
    const { session, sent } = setup();
    session.feed(frame('04110008' + SBA(6, 10) + '1d4000200010' + SBA(7, 10) + '1d4000270010' + '0442' + '0000'));
    session.type('user');
    session.press('tab');
    session.type('pass');
    session.press('enter');
    const out = sent[sent.length - 1]!;
    expect(out.wire).toContain(e('pass'));
    expect(out.trace).not.toContain(e('pass'));
    expect(out.trace).toContain(e('user'));
  });

  it('a frame without non-display data has no separate trace copy', () => {
    const { session, sent } = setup();
    session.feed(frame('04110008' + SBA(6, 10) + '1d4000200004' + '0452' + '0000'));
    session.type('user');
    session.press('enter');
    expect(sent[sent.length - 1]!.trace).toBe(sent[sent.length - 1]!.wire);
  });

  it('the snapshot never carries the characters of a non-display field', () => {
    const { session } = setup();
    session.feed(frame(SIGNON));
    session.press('tab');
    session.type('s3cret');
    const snap = session.snapshot();
    expect(snap.text).not.toContain('s3cret');
    expect(session.screen.rowText(6, cp)).toContain('s3cret'); // the engine still has it for the host
  });
});

describe('Write Structured Field with several structured fields', () => {
  it('walks every structured field by its length; a X\'04\' inside one is data', () => {
    const { session, sent } = setup();
    session.feed(frame('04110008' + SBA(2, 2) + e('hello') + '0452' + '0000'));
    const before = sent.length;
    // WSF: a 5250 Query (D9 70) followed by a second, unknown structured field whose data
    // contains X'04 40' (which would read as ESC CLEAR UNIT if scanned byte by byte).
    const second = '0008' + 'd9' + '7f' + '0440' + '0000';
    session.feed(frame('04f3' + '0005' + 'd970' + '00' + second));
    expect(sent.length).toBe(before + 1); // one Query reply, nothing else
    expect(session.screen.rowText(1, cp).trim()).toBe('hello'); // not cleared
  });
});
