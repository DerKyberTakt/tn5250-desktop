import { describe, expect, it } from 'vitest';
import { GdsError, OP_PUT_GET, buildRecord, parseRecord } from '../../src/engine/gds';
import { TelnetSession } from '../../src/engine/telnet';
import { bytesToHex, hexToBytes, inboundBytes, loadCapture } from '../helpers/fixture';

describe('GDS records', () => {
  it('parses the PUB400 sign-on record header', () => {
    const capture = loadCapture('pub400-signon-3477fc');
    const records: Uint8Array[] = [];
    const telnet = new TelnetSession({ terminalType: 'IBM-3477-FC' }, { send: () => undefined, record: (r) => records.push(r) });
    telnet.feed(inboundBytes(capture));
    const rec = parseRecord(records[0] as Uint8Array);
    expect(rec.length).toBe(0x032d);
    expect(rec.opcode).toBe(OP_PUT_GET);
    expect(rec.flags1).toBe(0);
    expect(bytesToHex(rec.data.subarray(0, 4))).toBe('04400411');
  });

  it('builds a record with the 10-byte header', () => {
    const rec = buildRecord(OP_PUT_GET, 0, hexToBytes('0101f1'));
    expect(bytesToHex(rec)).toBe('000d12a000000400000301 01f1'.replace(' ', ''));
    const parsed = parseRecord(rec);
    expect(parsed.opcode).toBe(OP_PUT_GET);
    expect(bytesToHex(parsed.data)).toBe('0101f1');
  });

  it('rejects malformed records', () => {
    expect(() => parseRecord(hexToBytes('0005'))).toThrow(GdsError);
    expect(() => parseRecord(hexToBytes('000a12a1000004000003'))).toThrow(GdsError);
  });
});
