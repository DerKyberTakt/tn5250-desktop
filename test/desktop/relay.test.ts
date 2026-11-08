import { describe, expect, it } from 'vitest';
import { InputQueue, isSessionInput, newTabId, snapshotText, TabRegistry, windowNameFromUrl, type RegistryEntry } from '../../src/desktop/relay';

const entry = (tab: string, window: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  tab,
  window,
  letter: 'A',
  title: `${tab} title`,
  name: 'Dev',
  host: 'pub400.com',
  port: 23,
  status: 'connected',
  ...over,
});

describe('tab registry (which window owns which session)', () => {
  it('adds, moves, lists by window and removes', () => {
    const r = new TabRegistry();
    r.add(entry('t1', 'main'));
    r.add(entry('t2', 'main', { letter: 'B' }));
    r.add(entry('t3', 'win-2', { letter: 'C' }));
    expect(r.byWindow('main').map((e) => e.tab)).toEqual(['t1', 't2']);
    expect(r.windows()).toEqual(['main', 'win-2']);
    expect(r.move('t2', 'win-2')).toBe(true);
    expect(r.move('nope', 'win-2')).toBe(false);
    expect(r.byWindow('win-2').map((e) => e.tab)).toEqual(['t2', 't3']);
    expect(r.remove('t1')?.letter).toBe('A');
    expect(r.get('t1')).toBeUndefined();
    expect(r.list()).toHaveLength(2);
  });

  it('the snapshot carries only the public fields', () => {
    const r = new TabRegistry<RegistryEntry & { secret: string }>();
    r.add({ ...entry('t1', 'main'), secret: 'no' });
    expect(r.snapshot()).toEqual([entry('t1', 'main')]);
    expect(Object.keys(r.snapshot()[0]!)).not.toContain('secret');
  });
});

describe('relay helpers', () => {
  it('only session messages go to the broker; copy, paste, print and logs stay in the window', () => {
    expect(isSessionInput({ type: 'action', action: 'enter' })).toBe(true);
    expect(isSessionInput({ type: 'ready' })).toBe(true);
    expect(isSessionInput({ type: 'text', text: 'a' })).toBe(true);
    expect(isSessionInput({ type: 'copy', text: 'x' })).toBe(false);
    expect(isSessionInput({ type: 'paste' })).toBe(false);
    expect(isSessionInput({ type: 'printScreen' })).toBe(false);
    expect(isSessionInput({ type: 'log', message: 'm' })).toBe(false);
  });

  it('tab ids are unique and name their window', () => {
    const a = newTabId('main');
    const b = newTabId('main');
    expect(a).not.toBe(b);
    expect(a.startsWith('main-')).toBe(true);
  });

  it('the window name comes from the page URL, main by default', () => {
    expect(windowNameFromUrl('')).toBe('main');
    expect(windowNameFromUrl('?window=win-2')).toBe('win-2');
    expect(windowNameFromUrl('?x=1&window=win_3')).toBe('win_3');
    expect(windowNameFromUrl('?window=bad name')).toBe('bad');
  });

  it('screen text from a snapshot matches the controller: rows, nulls as blanks, trimmed', () => {
    const text = 'ab\u0000\u0000' + '\u0000cd\u0000';
    expect(snapshotText({ rows: 2, cols: 4, text })).toBe('ab\n cd');
  });
});

describe('InputQueue (keystrokes reach the broker in order)', () => {
  it('gathers what one tick pushes into one send, in order, and sends the next batch only after the previous one', async () => {
    const sent: string[][] = [];
    const pending: Array<() => void> = [];
    const deferred: Array<() => void> = [];
    const q = new InputQueue<string>(
      (msgs) =>
        new Promise<void>((resolve) => {
          sent.push(msgs);
          pending.push(resolve);
        }),
      () => undefined,
      (fn) => deferred.push(fn),
    );
    q.push('tab');
    q.push('tab');
    q.push('40');
    expect(deferred).toHaveLength(1); // one flush scheduled for the tick
    expect(sent).toEqual([]);
    deferred.shift()?.();
    await Promise.resolve(); // the send runs one microtask after the flush
    expect(sent).toEqual([['tab', 'tab', '40']]);
    // The next tick: its batch waits until the first send settled.
    q.push('enter');
    deferred.shift()?.();
    await Promise.resolve();
    expect(sent).toEqual([['tab', 'tab', '40']]);
    pending.shift()?.();
    await new Promise((r) => setTimeout(r, 0)); // the chain settles over a few microtasks
    expect(sent).toEqual([['tab', 'tab', '40'], ['enter']]);
    pending.shift()?.();
    await q.idle;
  });

  it('reports a failed send and keeps going with the next batch', async () => {
    const errors: unknown[] = [];
    const sent: string[][] = [];
    let fail = true;
    const q = new InputQueue<string>(
      (msgs) => {
        if (fail) return Promise.reject(new Error('relay down'));
        sent.push(msgs);
        return Promise.resolve();
      },
      (err) => errors.push(err),
      (fn) => fn(),
    );
    q.push('a');
    await q.idle;
    expect(errors).toHaveLength(1);
    fail = false;
    q.push('b');
    await q.idle;
    expect(sent).toEqual([['b']]);
  });
});
