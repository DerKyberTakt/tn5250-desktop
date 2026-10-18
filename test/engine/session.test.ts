import { describe, expect, it } from 'vitest';
import { Session5250 } from '../../src/engine/session';
import { bytesToHex, hexToBytes, loadCapture, outboundHex } from '../helpers/fixture';

describe('Session5250', () => {
  it('negotiates, renders the PUB400 sign-on screen and reports status', () => {
    const sent: string[] = [];
    let updates = 0;
    const session = new Session5250(
      { screenSize: '27x132', codePage: 37 },
      { send: (b) => sent.push(bytesToHex(b)), update: () => updates++ },
    );
    const capture = loadCapture('pub400-signon-3477fc');
    for (const ev of capture.events) {
      if (ev.dir === 'in') session.feed(hexToBytes(ev.hex));
    }
    expect(sent.join('')).toBe(outboundHex(capture));
    expect(updates).toBe(1);
    const snap = session.snapshot();
    expect(snap.rows).toBe(24);
    expect(snap.text.slice(0, 80)).toContain('Welcome to PUB400.COM');
    expect(snap.attrs.filter((a) => a !== 0).length).toBeGreaterThan(5);
    const oia = session.oia(true);
    expect(oia.connected).toBe(true);
    expect(oia.inputInhibited).toBe('none');
    expect(oia.messageWaiting).toBe(false);
  });

  it('answers Cancel Invite and tracks the message light opcodes', () => {
    const sent: string[] = [];
    const session = new Session5250({}, { send: (b) => sent.push(bytesToHex(b)) });
    session.feed(hexToBytes('000a12a00000040000' + '0b' + 'ffef'));
    expect(session.state.messageWaiting).toBe(true);
    session.feed(hexToBytes('000a12a00000040000' + '0c' + 'ffef'));
    expect(session.state.messageWaiting).toBe(false);
    session.feed(hexToBytes('000a12a00000040000' + '0a' + 'ffef'));
    expect(sent).toEqual(['000a12a000000400000affef']);
  });
});
