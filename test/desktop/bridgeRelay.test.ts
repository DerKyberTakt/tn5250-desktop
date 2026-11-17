// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { brokerIsReady, onRelay, relay } from '../../src/desktop/bridge';

/** A Go Relay whose calls resolve only when the test says so. */
function fakeRelay() {
  const calls: Array<{ to: string; msg: unknown; resolve: () => void }> = [];
  const Relay = vi.fn((to: string, _name: string, msg: unknown) => new Promise<void>((resolve) => calls.push({ to, msg, resolve })));
  window.go = { main: { App: { Relay } as never } };
  return { Relay, calls };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('relay keeps the order of messages between windows', () => {
  beforeEach(() => brokerIsReady());

  it('messages queued in one tick travel in one call, in order', async () => {
    const { Relay, calls } = fakeRelay();
    void relay('main', { type: 'tab:output', n: 1 });
    void relay('main', { type: 'tab:output', n: 2 });
    void relay('other', { type: 'tab:state', n: 3 });
    expect(Relay).not.toHaveBeenCalled();
    await tick();
    expect(Relay).toHaveBeenCalledTimes(1);
    expect(calls[0]!.to).toBe('main');
    expect(calls[0]!.msg).toEqual({ type: 'relay:batch', msgs: [{ type: 'tab:output', n: 1 }, { type: 'tab:output', n: 2 }] });
    calls[0]!.resolve();
    await tick();
    expect(Relay).toHaveBeenCalledTimes(2);
    expect(calls[1]!.to).toBe('other');
    expect(calls[1]!.msg).toEqual({ type: 'tab:state', n: 3 });
    calls[1]!.resolve();
    await tick();
  });

  it('a later tick waits until the earlier call was delivered, so Go cannot swap them', async () => {
    const { Relay, calls } = fakeRelay();
    void relay('main', { n: 1 });
    await tick();
    void relay('main', { n: 2 });
    await tick();
    await tick();
    expect(Relay).toHaveBeenCalledTimes(1);
    calls[0]!.resolve();
    await tick();
    expect(Relay).toHaveBeenCalledTimes(2);
    expect(calls[1]!.msg).toEqual({ n: 2 });
    calls[1]!.resolve();
    await tick();
  });

  it('a failed delivery does not block the ones after it', async () => {
    window.go = { main: { App: { Relay: vi.fn(() => Promise.reject(new Error('window gone'))) } as never } };
    void relay('gone', { n: 1 });
    await tick();
    const { Relay, calls } = fakeRelay();
    void relay('main', { n: 2 });
    await tick();
    await tick();
    expect(Relay).toHaveBeenCalledTimes(1);
    calls[0]!.resolve();
    await tick();
  });

  it('onRelay hands a batch out one message at a time, in order', () => {
    let handler: ((data: unknown) => void) | undefined;
    window.runtime = { EventsOn: (_name: string, cb: (data: unknown) => void) => ((handler = cb), () => undefined) } as never;
    const got: unknown[] = [];
    onRelay((m) => got.push(m));
    handler!({ type: 'relay:batch', msgs: [{ n: 1 }, { n: 2 }] });
    handler!({ n: 3 });
    expect(got).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
