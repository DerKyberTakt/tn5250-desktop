import { describe, expect, it } from 'vitest';
import { MAX_RECORD_BYTES, MAX_SUBNEGOTIATION_BYTES, TelnetSession } from '../../src/engine/telnet';

const IAC = 255;
const SB = 250;
const SE = 240;
const EOR = 239;

function make() {
  const sent: number[][] = [];
  const records: Uint8Array[] = [];
  const errors: Error[] = [];
  const t = new TelnetSession(
    { terminalType: 'IBM-3179-2' },
    { send: (b) => sent.push([...b]), record: (r) => records.push(r), error: (e) => errors.push(e) },
  );
  return { t, sent, records, errors };
}

describe('TelnetSession limits', () => {
  it('answers a terminal-type SEND split across feeds at every byte boundary', () => {
    const frame = [IAC, SB, 24, 1, IAC, SE];
    for (let cut = 1; cut < frame.length; cut++) {
      const { t, sent, errors } = make();
      t.feed(Uint8Array.from(frame.slice(0, cut)));
      t.feed(Uint8Array.from(frame.slice(cut)));
      expect(errors).toEqual([]);
      expect(sent).toHaveLength(1);
    }
  });

  it('fails the session on an unterminated subnegotiation instead of buffering it', () => {
    const { t, sent, errors } = make();
    t.feed(Uint8Array.from([IAC, SB, 24]));
    const chunk = new Uint8Array(1000).fill(65);
    for (let i = 0; i < 3; i++) t.feed(chunk);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/subnegotiation/);
    expect(MAX_SUBNEGOTIATION_BYTES).toBeLessThan(3003);
    // Dead: later bytes are ignored, nothing more is sent.
    t.feed(Uint8Array.from([IAC, SB, 24, 1, IAC, SE]));
    expect(sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('does not rescan an open subnegotiation on every feed (linear time)', () => {
    const { t, errors } = make();
    t.feed(Uint8Array.from([IAC, SB, 24]));
    const start = Date.now();
    for (let i = 0; i < 200; i++) t.feed(new Uint8Array(4).fill(65));
    expect(Date.now() - start).toBeLessThan(500);
    expect(errors).toEqual([]);
  });

  it('fails the session when a record grows past the limit without IAC EOR, even in one huge chunk', () => {
    const { t, records, errors } = make();
    t.feed(new Uint8Array(MAX_RECORD_BYTES + 5000).fill(1));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/record/);
    expect(records).toEqual([]);
  });

  it('still delivers records of normal size', () => {
    const { t, records, errors } = make();
    t.feed(Uint8Array.from([1, 2, IAC, IAC, 3, IAC, EOR]));
    expect(errors).toEqual([]);
    expect([...(records[0] ?? [])]).toEqual([1, 2, IAC, 3]);
  });
});
