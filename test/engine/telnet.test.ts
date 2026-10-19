import { describe, expect, it } from 'vitest';
import { OPT_BINARY, OPT_EOR, OPT_NEW_ENVIRON, OPT_TERMINAL_TYPE, TelnetSession, parseEnvironment } from '../../src/engine/telnet';
import { bytesToHex, hexToBytes, loadCapture, outboundHex } from '../helpers/fixture';

function harness(options = { terminalType: 'IBM-3477-FC' }) {
  const sent: string[] = [];
  const records: Uint8Array[] = [];
  const telnet = new TelnetSession(options, {
    send: (b) => sent.push(bytesToHex(b)),
    record: (r) => records.push(r),
  });
  return { telnet, sent, records };
}

describe('TelnetSession', () => {
  it('replays the PUB400 negotiation and produces the same outbound bytes', () => {
    const capture = loadCapture('pub400-signon-3477fc');
    const h = harness();
    for (const ev of capture.events) {
      if (ev.dir === 'in') h.telnet.feed(hexToBytes(ev.hex));
    }
    expect(h.sent.join('')).toBe(outboundHex(capture));
    expect(h.records).toHaveLength(1);
    const rec = h.records[0] as Uint8Array;
    expect(rec.length).toBe(0x032d);
    expect(bytesToHex(rec.subarray(0, 4))).toBe('032d12a0');
    expect([...h.telnet.negotiatedOptions].sort((a, b) => a - b)).toEqual(
      [OPT_BINARY, OPT_EOR, OPT_TERMINAL_TYPE, OPT_NEW_ENVIRON].sort((a, b) => a - b),
    );
  });

  it('handles records split across chunks and escaped IAC bytes', () => {
    const h = harness();
    h.telnet.feed(hexToBytes('0102ff'));
    h.telnet.feed(hexToBytes('ff03ff'));
    expect(h.records).toHaveLength(0);
    h.telnet.feed(hexToBytes('ef'));
    expect(h.records).toHaveLength(1);
    expect(bytesToHex(h.records[0] as Uint8Array)).toBe('0102ff03');
  });

  it('escapes IAC and appends IAC EOR when sending a record', () => {
    const h = harness();
    h.telnet.sendRecord(hexToBytes('01ff02'));
    expect(h.sent).toEqual(['01ffff02ffef']);
  });

  it('refuses options it does not support', () => {
    const h = harness();
    h.telnet.feed(hexToBytes('fffd05fffb20'));
    expect(h.sent).toEqual(['fffc05', 'fffe20']);
  });

  it('sends DEVNAME, KBDTYPE, CODEPAGE and CHARSET when a device name is requested', () => {
    const h = harness({ terminalType: 'IBM-3179-2', deviceName: 'mydev', codePage: 37 } as never);
    h.telnet.feed(hexToBytes('fffa2701fff0'));
    const reply = h.sent[0] as string;
    const text = Buffer.from(reply, 'hex').toString('latin1');
    expect(text).toContain('DEVNAME\u0001MYDEV');
    expect(text).toContain('KBDTYPE\u0001USB');
    expect(text).toContain('CODEPAGE\u000137');
    expect(text).toContain('CHARSET\u0001697');
  });

  it('parses NEW-ENVIRON IS payloads', () => {
    const bytes = Array.from(Buffer.from('\u0003DEVNAME\u0001QPADEV0001\u0000USER\u0001ALEX', 'latin1'));
    const vars = parseEnvironment(bytes);
    expect(vars.get('DEVNAME')).toBe('QPADEV0001');
    expect(vars.get('USER')).toBe('ALEX');
  });
});
