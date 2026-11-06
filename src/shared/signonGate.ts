/**
 * Bypass sign-ons for the same user profile and host go one at a time, and stop after a
 * failure: QMAXSIGN (default 3) disables the profile after a few wrong passwords, and
 * five tabs reloaded with a wrong code page or a stale saved password would spend them
 * in a second. One gate per process (the extension host, or the desktop's broker page).
 */
export type GateVerdict =
  /** This caller sends and reports the result. */
  | 'try'
  /** Sends; an earlier attempt succeeded, nothing to report. */
  | 'go'
  /** Does not send: an earlier attempt failed and nobody re-armed the gate. */
  | 'paused';

/** Timers without assuming a DOM or Node typing in shared code. */
const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void };

interface Waiter {
  resolve: (v: GateVerdict) => void;
  timer: unknown;
}

interface Entry {
  state: 'idle' | 'trying' | 'ok' | 'failed';
  waiters: Waiter[];
}

export class SignonGate {
  private readonly entries = new Map<string, Entry>();

  /** waitMs: how long a caller waits for the attempt in flight before going on its own. */
  constructor(private readonly waitMs = 10000) {}

  /** USER@host, as the saved passwords are keyed. */
  static key(user: string, host: string): string {
    return `${user.trim().toUpperCase()}@${host.trim().toLowerCase()}`;
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { state: 'idle', waiters: [] };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Asks to send a bypass sign-on for the key. */
  acquire(key: string): Promise<GateVerdict> {
    const e = this.entry(key);
    switch (e.state) {
      case 'idle':
        e.state = 'trying';
        return Promise.resolve('try');
      case 'ok':
        return Promise.resolve('go');
      case 'failed':
        return Promise.resolve('paused');
      case 'trying':
        return new Promise((resolve) => {
          const w: Waiter = {
            resolve,
            timer: timers.setTimeout(() => {
              // The attempt in flight never answered: this caller tries on its own.
              e.waiters = e.waiters.filter((x) => x !== w);
              resolve('try');
            }, this.waitMs),
          };
          e.waiters.push(w);
        });
    }
  }

  /** The caller that got 'try' reports whether the host accepted the sign-on. */
  report(key: string, ok: boolean): void {
    const e = this.entry(key);
    e.state = ok ? 'ok' : 'failed';
    this.flush(e, ok ? 'go' : 'paused');
  }

  /** The attempt ended without an answer (disconnected): the next waiter tries. */
  release(key: string): void {
    const e = this.entries.get(key);
    if (!e || e.state !== 'trying') return;
    const next = e.waiters.shift();
    if (next) {
      timers.clearTimeout(next.timer);
      next.resolve('try');
    } else {
      e.state = 'idle';
    }
  }

  /** The user acted on this key (reconnected by hand): the next sign-on tries again. */
  rearm(key: string): void {
    const e = this.entries.get(key);
    if (e && e.state !== 'trying') e.state = 'idle';
  }

  /** Settings saved or a password set: every key starts over, one attempt at a time. */
  rearmAll(): void {
    for (const e of this.entries.values()) if (e.state !== 'trying') e.state = 'idle';
  }

  isPaused(key: string): boolean {
    return this.entries.get(key)?.state === 'failed';
  }

  /** Tests: forget everything, letting waiters go. */
  reset(): void {
    for (const e of this.entries.values()) this.flush(e, 'go');
    this.entries.clear();
  }

  private flush(e: Entry, v: GateVerdict): void {
    for (const w of e.waiters) {
      timers.clearTimeout(w.timer);
      w.resolve(v);
    }
    e.waiters = [];
  }
}

/** The process-wide gate the session controllers share. */
export const signonGate = new SignonGate();
