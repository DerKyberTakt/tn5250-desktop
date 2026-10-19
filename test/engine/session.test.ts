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

  it('buffers keys while the keyboard is locked and replays them on unlock', () => {
    const sent: string[] = [];
    const session = new Session5250({ screenSize: '27x132', codePage: 37 }, { send: (b) => sent.push(bytesToHex(b)) });
    for (const ev of loadCapture('pub400-signon-3477fc').events) {
      if (ev.dir === 'in') session.feed(hexToBytes(ev.hex));
    }
    const first = session.screen.fields.find((f) => !f.bypass)!;
    session.screen.cursor = first.start;
    session.press('enter');
    expect(session.state.inputInhibited).toBe('system');
    const sentAfterEnter = sent.length;
    session.press('home');
    session.type('AB');
    session.press('enter');
    session.type('C');
    expect(session.queuedKeys).toBe(4);
    expect(session.oia(true).queuedKeys).toBe(4);
    expect(sent.length).toBe(sentAfterEnter);

    // Write to Display, CC2 0x08 = unlock keyboard: replays up to the next Enter.
    session.feed(hexToBytes('000e12a00000040000030411000' + '8' + 'ffef'));
    expect(sent.length).toBe(sentAfterEnter + 1);
    expect(session.state.inputInhibited).toBe('system');
    expect(session.queuedKeys).toBe(1);
    const text = session.snapshot().text;
    expect(text.slice(first.start, first.start + 2)).toBe('AB');

    // Reset throws the rest away.
    session.press('reset');
    expect(session.queuedKeys).toBe(0);
  });

  it('drops keys while locked when type-ahead is off', () => {
    const session = new Session5250({ typeAhead: false }, { send: () => undefined });
    expect(session.state.inputInhibited).toBe('system');
    session.type('X');
    expect(session.queuedKeys).toBe(0);
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
