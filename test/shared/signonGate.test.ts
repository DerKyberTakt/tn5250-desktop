import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignonGate } from '../../src/shared/signonGate';

describe('bypass sign-on gate (one attempt per user and host at a time, none after a failure)', () => {
  afterEach(() => vi.useRealTimers());

  it('keys by upper-case user and lower-case host', () => {
    expect(SignonGate.key(' wardk ', 'MyHost.Example ')).toBe('WARDK@myhost.example');
  });

  it('the first caller tries, the others wait for its result: success lets them go', async () => {
    const g = new SignonGate();
    const k = SignonGate.key('u', 'h');
    expect(await g.acquire(k)).toBe('try');
    const second = g.acquire(k);
    const third = g.acquire(k);
    g.report(k, true);
    expect(await second).toBe('go');
    expect(await third).toBe('go');
    expect(await g.acquire(k)).toBe('go');
    expect(g.isPaused(k)).toBe(false);
  });

  it('a failure pauses the waiters and every later caller until re-armed', async () => {
    const g = new SignonGate();
    const k = SignonGate.key('u', 'h');
    await g.acquire(k);
    const second = g.acquire(k);
    g.report(k, false);
    expect(await second).toBe('paused');
    expect(await g.acquire(k)).toBe('paused');
    expect(g.isPaused(k)).toBe(true);
    g.rearm(k);
    expect(await g.acquire(k)).toBe('try');
  });

  it('keys are independent', async () => {
    const g = new SignonGate();
    await g.acquire(SignonGate.key('u1', 'h'));
    g.report(SignonGate.key('u1', 'h'), false);
    expect(await g.acquire(SignonGate.key('u2', 'h'))).toBe('try');
    expect(await g.acquire(SignonGate.key('u1', 'other'))).toBe('try');
  });

  it('rearmAll starts every key over, one attempt at a time, even after a success', async () => {
    const g = new SignonGate();
    const k = SignonGate.key('u', 'h');
    await g.acquire(k);
    g.report(k, true);
    g.rearmAll();
    expect(await g.acquire(k)).toBe('try');
    const waiting = g.acquire(k);
    g.report(k, true);
    expect(await waiting).toBe('go');
  });

  it('an attempt that ends without an answer hands over to the next waiter, or frees the key', async () => {
    const g = new SignonGate();
    const k = SignonGate.key('u', 'h');
    await g.acquire(k);
    const second = g.acquire(k);
    g.release(k);
    expect(await second).toBe('try');
    g.release(k);
    expect(await g.acquire(k)).toBe('try');
  });

  it('a waiter gives up waiting after the timeout and tries on its own', async () => {
    vi.useFakeTimers();
    const g = new SignonGate(1000);
    const k = SignonGate.key('u', 'h');
    await g.acquire(k);
    const second = g.acquire(k);
    vi.advanceTimersByTime(1000);
    expect(await second).toBe('try');
  });
});
