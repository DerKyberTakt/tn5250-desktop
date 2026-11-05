import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionEvents, ConnectOptions, Transport } from '../../src/extension/connection';
import { CertificateError } from '../../src/shared/tlsTrust';
import { CodePage } from '../../src/engine/codepage';
import { bytesToHex } from '../helpers/fixture';
import { SessionController } from '../../src/extension/sessionController';
import type { ConnectionInfo, ConnectionStatus } from '../../src/shared/protocol';
import { SETTINGS_DEFAULTS, type TerminalSettings } from '../../src/shared/settings';
import { hexToBytes, loadCapture } from '../helpers/fixture';

/** A transport whose connect() the test settles by hand. */
class FakeTransport implements Transport {
  open = false;
  closed = false;
  settle!: { resolve: () => void; reject: (err: Error) => void };

  constructor(readonly events: ConnectionEvents) {}

  connect(_options: ConnectOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = {
        resolve: () => {
          this.open = true;
          resolve();
        },
        reject,
      };
    });
  }

  writes: Uint8Array[] = [];

  write(bytes: Uint8Array): void {
    this.writes.push(bytes);
  }

  close(): void {
    this.closed = true;
    this.open = false;
  }
}

type Seen = { status: ConnectionStatus; detail: string; info: ConnectionInfo };

function setup(overrides: Partial<TerminalSettings> = {}) {
  const profile: TerminalSettings = { ...SETTINGS_DEFAULTS, host: 'pub400.com', port: 23, autoReconnect: true, ...overrides };
  const seen: Seen[] = [];
  const transports: FakeTransport[] = [];
  const controller = new SessionController(
    profile,
    {
      screen: () => undefined,
      status: (status, detail, info) => seen.push({ status, detail, info }),
      alarm: () => undefined,
      log: () => undefined,
    },
    (events) => {
      const t = new FakeTransport(events);
      transports.push(t);
      return t;
    },
  );
  const last = (): Seen => seen[seen.length - 1] as Seen;
  return { controller, seen, transports, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionController connection states', () => {
  it('reports connecting with the attempt number, then connected', async () => {
    const { controller, transports, last } = setup();
    const done = controller.connect();
    expect(last()).toMatchObject({ status: 'connecting', detail: 'pub400.com:23', info: { attempt: 1 } });
    transports[0]?.settle.resolve();
    await done;
    expect(last().status).toBe('connected');
  });

  it('schedules a reconnect with a countdown after a failed connect', async () => {
    const { controller, transports, last } = setup();
    const done = controller.connect();
    transports[0]?.settle.reject(new Error('connection refused'));
    await done;
    const s = last();
    expect(s.status).toBe('disconnected');
    expect(s.detail).toMatch(/^pub400.com:23 refused the connection/);
    expect(s.info.attempt).toBe(1);
    expect(s.info.retryAt).toBe(Date.now() + 2000);
    vi.advanceTimersByTime(2000);
    expect(last()).toMatchObject({ status: 'connecting', info: { attempt: 2 } });
  });

  it('reports a dropped connection as lost (not manual) and retries', async () => {
    const { controller, transports, last } = setup();
    const done = controller.connect();
    transports[0]?.settle.resolve();
    await done;
    transports[0]?.events.close(true);
    expect(last().status).toBe('disconnected');
    expect(last().info.manual).toBeUndefined();
    expect(last().info.retryAt).toBeGreaterThan(Date.now());
  });

  it('reconnectNow skips the wait', async () => {
    const { controller, transports, last } = setup();
    const done = controller.connect();
    transports[0]?.settle.reject(new Error('timed out'));
    await done;
    controller.reconnectNow();
    expect(last().status).toBe('connecting');
    expect(transports).toHaveLength(2);
  });

  it('stop cancels the pending reconnect and reports a manual disconnect', async () => {
    const { controller, transports, last } = setup();
    const done = controller.connect();
    transports[0]?.settle.reject(new Error('timed out'));
    await done;
    controller.disconnect();
    expect(last()).toMatchObject({ status: 'disconnected', info: { manual: true } });
    vi.advanceTimersByTime(60000);
    expect(transports).toHaveLength(1);
  });

  it('cancel during connecting closes the late connection and stays disconnected', async () => {
    const { controller, transports, last } = setup();
    const done = controller.connect();
    controller.disconnect();
    expect(last()).toMatchObject({ status: 'disconnected', info: { manual: true } });
    transports[0]?.settle.resolve();
    await done;
    expect(transports[0]?.closed).toBe(true);
    expect(last().status).toBe('disconnected');
  });

  it('does not retry when auto-reconnect is off', async () => {
    const { controller, transports, last } = setup({ autoReconnect: false });
    const done = controller.connect();
    transports[0]?.settle.reject(new Error('refused'));
    await done;
    expect(last().info.retryAt).toBeUndefined();
    vi.advanceTimersByTime(60000);
    expect(transports).toHaveLength(1);
  });
});

describe('SessionController bypass sign-on', () => {
  it('follows the live Bypass signon settings, not the ones the tab was opened with', async () => {
    vi.useRealTimers();
    const profile: TerminalSettings = { ...SETTINGS_DEFAULTS, host: 'pub400.com', port: 23, autoSignon: false, signonUser: '' };
    const live = { autoSignon: true, signonUser: 'user1' };
    const logs: string[] = [];
    let asked = 0;
    let transport: FakeTransport | undefined;
    const controller = new SessionController(
      profile,
      {
        screen: () => undefined,
        status: () => undefined,
        alarm: () => undefined,
        log: (m) => logs.push(m),
        password: async () => {
          asked += 1;
          return undefined;
        },
        signon: () => live,
      },
      (events) => (transport = new FakeTransport(events)),
    );
    const done = controller.connect();
    transport?.settle.resolve();
    await done;
    for (const ev of loadCapture('pub400-signon-3477fc').events) {
      if (ev.dir === 'in') transport?.events.data(hexToBytes(ev.hex));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);
    expect(logs.some((l) => l.includes('no password saved for USER1'))).toBe(true);
  });

  /** A host record (payload after the GDS header) framed as it arrives on the wire. */
  const frame = (hex: string): Uint8Array => {
    const payload = hexToBytes(hex);
    const total = 10 + payload.length;
    return Uint8Array.from([(total >> 8) & 0xff, total & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, 0x03, ...payload, 0xff, 0xef]);
  };
  const cp = CodePage.get(37);
  const e = (t: string): string => bytesToHex(cp.encodeString(t));

  function signonHarness(password: string) {
    vi.useRealTimers();
    const profile: TerminalSettings = { ...SETTINGS_DEFAULTS, host: 'pub400.com', port: 23, autoSignon: true, signonUser: 'user1' };
    const logs: string[] = [];
    let asked = 0;
    let transport: FakeTransport | undefined;
    const controller = new SessionController(
      profile,
      {
        screen: () => undefined,
        status: () => undefined,
        alarm: () => undefined,
        log: (m) => logs.push(m),
        password: async () => {
          asked += 1;
          return password;
        },
      },
      (events) => (transport = new FakeTransport(events)),
    );
    const wire = (): string => (transport?.writes ?? []).map((b) => bytesToHex(b)).join(' ');
    return { controller, logs, asked: () => asked, transport: () => transport!, wire };
  }

  it('types the password only into a non-display field; a screen without one is skipped', async () => {
    const h = signonHarness('s3cret');
    const done = h.controller.connect();
    h.transport().settle.resolve();
    await done;
    // Two visible entry fields: not a sign-on screen.
    h.transport().events.data(frame('04110008' + '11060a' + '1d4000200010' + '11070a' + '1d4000200010' + '04520000'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.asked()).toBe(0);
    expect(h.logs.some((l) => l.includes('bypass sign-on skipped'))).toBe(true);
    expect(h.wire()).not.toContain(e('s3cret'));
    // Now the real thing: user field, then a non-display password field.
    h.transport().events.data(frame('04110008' + '11060a' + '1d4000200010' + '11070a' + '1d4000270010' + '04520000'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.asked()).toBe(1);
    expect(h.wire()).toContain(e('user1'));
    expect(h.wire()).toContain(e('s3cret'));
  });

  it('the exported trace never contains the password', async () => {
    const h = signonHarness('s3cret');
    const done = h.controller.connect();
    h.transport().settle.resolve();
    await done;
    h.transport().events.data(frame('04110008' + '11060a' + '1d4000200010' + '11070a' + '1d4000270010' + '04520000'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.wire()).toContain(e('s3cret'));
    const trace = h.controller.exportTrace() as { events: Array<{ dir: string; hex: string }> };
    const out = trace.events.filter((ev) => ev.dir === 'out').map((ev) => ev.hex).join(' ');
    expect(out).toContain(e('user1'));
    expect(out).not.toContain(e('s3cret'));
    expect(out).toContain('40'.repeat(6)); // the password's place, blanked, same length
  });
});

describe('SessionController TLS certificates', () => {
  it('a refused certificate reports its fingerprint to the host side and does not retry', async () => {
    vi.useRealTimers();
    const seen: string[] = [];
    const profile: TerminalSettings = { ...SETTINGS_DEFAULTS, host: 'pub400.com', port: 992, tls: true, autoReconnect: true };
    let transport: FakeTransport | undefined;
    const statuses: string[] = [];
    const controller = new SessionController(
      profile,
      {
        screen: () => undefined,
        status: (st, detail) => statuses.push(`${st}:${detail}`),
        alarm: () => undefined,
        log: () => undefined,
        certificateRejected: (fp, reason) => seen.push(`${fp}|${reason}`),
      },
      (events) => (transport = new FakeTransport(events)),
    );
    const done = controller.connect();
    await new Promise((r) => setTimeout(r, 0)); // the TLS path awaits client-auth material before dialling
    transport?.settle.reject(new CertificateError('certificate of pub400.com not accepted: self signed', 'AB:CD', 'self signed'));
    await done;
    expect(seen).toEqual(['AB:CD|self signed']);
    expect(statuses[statuses.length - 1]).toMatch(/^disconnected:.*trust this certificate/);
    await new Promise((r) => setTimeout(r, 20));
    expect(transport?.closed).toBe(false);
    expect(statuses.filter((x) => x.startsWith('connecting'))).toHaveLength(1);
  });
});

describe('SessionController sign-on hint (issue #5: variant characters and the code page)', () => {
  const frame = (hex: string): Uint8Array => {
    const payload = hexToBytes(hex);
    const total = 10 + payload.length;
    return Uint8Array.from([(total >> 8) & 0xff, total & 0xff, 0x12, 0xa0, 0, 0, 4, 0, 0, 0x03, ...payload, 0xff, 0xef]);
  };
  const e = (t: string, ccsid = 37): string => bytesToHex(CodePage.get(ccsid).encodeString(t));
  /** A Sign On screen (title, user field, non-display password field, Read MDT); `message` goes on row 24. */
  const signonScreen = (message = '', ccsid = 37): Uint8Array =>
    frame('04110008' + '110118' + e('Sign On', ccsid) + '11060a' + '1d4000200010' + '11070a' + '1d4000270010' + (message ? '111801' + e(message, ccsid) : '') + '04520000');
  // A real host clears the unit (ESC 40) before a new screen; without it the old fields stay.
  const menuScreen = (): Uint8Array => frame('0440' + '04110008' + '110118' + e('Main Menu') + '11060a' + '1d4000200010' + '04520000');

  function harness(over: Partial<TerminalSettings> = {}, password?: string) {
    vi.useRealTimers();
    const profile: TerminalSettings = { ...SETTINGS_DEFAULTS, host: 'pub400.com', port: 23, ...over };
    const logs: string[] = [];
    const hints: Array<{ codePage: number; chars: string[] }> = [];
    let transport: FakeTransport | undefined;
    const controller = new SessionController(
      profile,
      {
        screen: () => undefined,
        status: () => undefined,
        alarm: () => undefined,
        log: (m) => logs.push(m),
        password: async () => password,
        signonHint: (info) => hints.push(info),
      },
      (events) => (transport = new FakeTransport(events)),
    );
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const start = async () => {
      const done = controller.connect();
      transport!.settle.resolve();
      await done;
    };
    const host = async (bytes: Uint8Array) => {
      transport!.events.data(bytes);
      await tick();
    };
    const signon = async (pw: string) => {
      controller.type('user1');
      controller.press('tab');
      controller.type(pw);
      controller.press('enter');
      await tick();
    };
    return { controller, logs, hints, start, host, signon, wire: () => (transport?.writes ?? []).map((b) => bytesToHex(b)).join(' ') };
  }

  it('a failed sign-on with ! in the password raises the hint once, naming the character and the code page', async () => {
    const h = harness();
    await h.start();
    await h.host(signonScreen());
    await h.signon('pa!s');
    expect(h.wire()).toContain(e('pa!s'));
    await h.host(signonScreen('CPF1120 - User USER1 does not exist or password not correct for user profile.'));
    expect(h.hints).toEqual([{ codePage: 37, chars: ['!'] }]);
    expect(h.logs.some((l) => l.includes('code page 37') && l.includes('(!)') && !l.includes('pa!s'))).toBe(true);
    // A second failure on the same connection stays quiet.
    await h.signon('pa!s');
    await h.host(signonScreen('CPF1120 - User USER1 does not exist or password not correct for user profile.'));
    expect(h.hints).toHaveLength(1);
  });

  it('no hint when the password has only invariant characters, or when the sign-on succeeded', async () => {
    const h = harness();
    await h.start();
    await h.host(signonScreen());
    await h.signon('Passw0rd.');
    await h.host(signonScreen('CPF1120 - User USER1 does not exist or password not correct for user profile.'));
    expect(h.hints).toEqual([]);
    await h.signon('pa!s');
    await h.host(menuScreen());
    expect(h.hints).toEqual([]);
    // The menu's own Enter is not a sign-on attempt.
    h.controller.press('enter');
    await h.host(signonScreen());
    expect(h.hints).toEqual([]);
  });

  it('works for bypass sign-on and for a non-37 code page (! under 273 is X\'4F\')', async () => {
    const h = harness({ codePage: 273, autoSignon: true, signonUser: 'user1' }, 'ge!heim');
    await h.start();
    await h.host(signonScreen('', 273));
    expect(h.wire()).toContain(e('ge!heim', 273));
    await h.host(signonScreen('CPF1120 - User USER1 does not exist or password not correct for user profile.', 273));
    expect(h.hints).toEqual([{ codePage: 273, chars: ['!'] }]);
  });

  it('a customised sign-on screen without the words "Sign On" (PUB400) still gets the hint', async () => {
    const h = harness();
    await h.start();
    const pub400 = (message = ''): Uint8Array =>
      frame('04110008' + '11010a' + e('Welcome to PUB400.COM * your public IBM i server') + '110501' + e('Your user name:') + '11051e' + '1d4000200010' + '110601' + e('Password (max. 128):') + '11061e' + '1d4000270080' + (message ? '111801' + e(message) : '') + '04520000');
    await h.host(pub400());
    await h.signon('pa!s');
    await h.host(pub400('CPF1120 - User USER1 does not exist or password not correct for user profile.'));
    expect(h.hints).toEqual([{ codePage: 37, chars: ['!'] }]);
  });

  it('a Change Password screen (three non-display fields) arms nothing', async () => {
    const h = harness();
    await h.start();
    await h.host(frame('04110008' + '110118' + e('Change Password') + '11060a' + '1d4000270010' + '11070a' + '1d4000270010' + '11080a' + '1d4000270010' + '04520000'));
    h.controller.type('pa!s');
    h.controller.press('enter');
    await h.host(signonScreen('CPF1120 - User USER1 does not exist or password not correct for user profile.'));
    expect(h.hints).toEqual([]);
  });

  it('a screen with a non-display field that is not a sign-on screen arms nothing', async () => {
    const h = harness();
    await h.start();
    await h.host(frame('04110008' + '110118' + e('Change Password') + '11060a' + '1d4000270010' + '04520000'));
    h.controller.type('pa!s');
    h.controller.press('enter');
    await h.host(signonScreen('CPF1120 - User USER1 does not exist or password not correct for user profile.'));
    expect(h.hints).toEqual([]);
  });
});
