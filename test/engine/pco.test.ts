import { describe, expect, it } from 'vitest';
import { CodePage } from '../../src/engine/codepage';
import { detectPcCommand } from '../../src/engine/pco';
import { Session5250 } from '../../src/engine/session';
import type { PcCommandRequest } from '../../src/engine/pco';
import { bytesToHex, hexToBytes } from '../helpers/fixture';

const cp = CodePage.get(37);
const e = (s: string): string => bytesToHex(cp.encodeString(s));

/** A GDS record carrying one 5250 command stream (as the host sends it over telnet, EOR excluded). */
function record(data: string): Uint8Array {
  const len = (10 + data.length / 2).toString(16).padStart(4, '0');
  return hexToBytes(`${len}12a0000004000003${data}ffef`);
}

/**
 * What STRPCCMD writes: a 1034-byte nondisplay field at row 1 col 1 with the PCO header, the
 * flag byte ('a' = PAUSE(*NO)), the command, then the fallback text and a Read MDT Fields.
 */
function pcoScreen(command: string, flag = 'a', attr = '27'): string {
  const header = '80fc' + e('PCO ') + '8380a180' + e(flag) + e(command);
  return (
    '04110028' +
    '110101' + '1d4820' + attr + '040a' + header +
    '111012' + '20' + e('Required PC program (PCO.EXE) is not active') + '20' +
    '111212' + '20' + e('Press ENTER to resume') + '20' +
    '04520000'
  );
}

function session(onPc?: (r: PcCommandRequest) => boolean) {
  const sent: string[] = [];
  let updates = 0;
  const s = new Session5250(
    { screenSize: '24x80', codePage: 37 },
    { send: (b) => sent.push(bytesToHex(b)), update: () => updates++, pcCommand: onPc },
  );
  return { s, sent, updates: () => updates };
}

describe('STRPCCMD / PC Organizer detection', () => {
  it('finds the command and the PAUSE flag in the hidden row-1 field', () => {
    const { s } = session();
    s.feed(record(pcoScreen('START http://pub400.com/demo?x=1')));
    expect(detectPcCommand(s.screen, cp)).toEqual({ command: 'START http://pub400.com/demo?x=1', wait: false });
    const { s: s2 } = session();
    s2.feed(record(pcoScreen('NOTEPAD C:\\TEMP\\A.TXT', 'b')));
    expect(detectPcCommand(s2.screen, cp)).toEqual({ command: 'NOTEPAD C:\\TEMP\\A.TXT', wait: true });
  });

  it('ignores ordinary screens, even ones with PCO text in a visible field', () => {
    const { s } = session();
    s.feed(record(pcoScreen('START http://pub400.com/', 'a', '20')));
    expect(detectPcCommand(s.screen, cp)).toBeUndefined();
    const { s: plain } = session();
    plain.feed(record('04110028' + '110101' + '1d402020' + '0010' + e('PCO START x') + '04520000'));
    expect(detectPcCommand(plain.screen, cp)).toBeUndefined();
  });

  it('hands the request to the host, hides the screen and lets Enter answer the read', () => {
    const got: PcCommandRequest[] = [];
    const { s, sent, updates } = session((r) => {
      got.push(r);
      return true;
    });
    s.feed(record(pcoScreen('START https://pub400.com/')));
    expect(got).toEqual([{ command: 'START https://pub400.com/', wait: false }]);
    expect(updates()).toBe(0);
    expect(s.state.pendingRead).toBe('mdt');
    // The host answers Enter itself when the command was handled; the MDT field goes back
    // with the data the host wrote, as PC Organizer does.
    s.press('enter');
    expect(updates()).toBe(0);
    const last = sent.at(-1) as string;
    expect(last).toContain('f1' + '110102' + '80fc' + e('PCO '));
    expect(s.state.inputInhibited).toBe('system');
    // The next host record publishes again.
    s.feed(record('04110008' + '110101' + '20' + e('Back') + '20'));
    expect(updates()).toBe(1);
  });

  it('shows the host screen when the host declines the request', () => {
    const { s, updates } = session(() => false);
    s.feed(record(pcoScreen('START https://pub400.com/')));
    expect(updates()).toBe(1);
    expect(s.snapshot().text).toContain('Required PC program (PCO.EXE) is not active');
  });
});
