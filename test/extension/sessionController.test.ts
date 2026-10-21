import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionEvents, ConnectOptions, Transport } from '../../src/extension/connection';
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

  write(): void {}

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
});
