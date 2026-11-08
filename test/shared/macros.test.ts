import { describe, expect, it } from 'vitest';
import {
  MacroRecorder,
  actionName,
  describeStep,
  keyMatches,
  macroProblems,
  macrosFromJson,
  macrosToJson,
  mergeMacros,
  runMacro,
  sanitizeMacro,
  type Macro,
  type MacroStep,
  type MacroTarget,
  watchRecording,
  RECORDING_IDLE_LIMIT_MS,
  RECORDING_REMINDER_MS,
} from '../../src/shared/macros';

const macro = (steps: MacroStep[], key = ''): Macro => ({ id: 'm1', name: 'Test', key, steps });

/** A session fake: records what was typed and pressed; `locked` is a script of inputAllowed answers. */
function fakeTarget(options: { locked?: boolean[]; screen?: string[]; answers?: Array<string | undefined> } = {}) {
  const log: string[] = [];
  const locked = [...(options.locked ?? [])];
  const screen = [...(options.screen ?? [''])];
  const answers = [...(options.answers ?? [])];
  const target: MacroTarget = {
    type: (t) => log.push(`type:${t}`),
    press: (a) => log.push(`press:${a}`),
    inputAllowed: () => !(locked.length > 1 ? locked.shift() : locked[0]),
    screenText: () => (screen.length > 1 ? (screen.shift() as string) : (screen[0] as string)),
    prompt: async (label) => {
      log.push(`prompt:${label}`);
      return answers.shift();
    },
  };
  return { target, log };
}

const instant = { sleep: async () => undefined, pollMs: 1 };

describe('MacroRecorder', () => {
  it('merges typed characters, follows a host key with a wait for input, drops local actions', () => {
    const r = new MacroRecorder();
    for (const ch of 'wrkactjob') r.text(ch);
    r.key('copy');
    r.key('enter');
    r.text('5');
    r.key('tab');
    r.key('pf3');
    expect(r.finish()).toEqual([
      { type: 'text', text: 'wrkactjob' },
      { type: 'key', action: 'enter' },
      { type: 'waitInput' },
      { type: 'text', text: '5' },
      { type: 'key', action: 'tab' },
      { type: 'key', action: 'pf3' },
    ]);
    // The recorder itself keeps the trailing wait; finish() drops it.
    expect(r.steps[r.steps.length - 1]).toEqual({ type: 'waitInput' });
  });
});

describe('runMacro', () => {
  it('types, presses and waits for the host to accept input again', async () => {
    // inputAllowed answers: before Enter free; after Enter: locked, locked, free.
    const { target, log } = fakeTarget({ locked: [false, true, true, false] });
    const r = await runMacro(macro([{ type: 'text', text: 'wrkactjob' }, { type: 'key', action: 'enter' }, { type: 'waitInput' }, { type: 'key', action: 'pf3' }]), target, instant);
    expect(r).toEqual({ ok: true });
    expect(log).toEqual(['type:wrkactjob', 'press:enter', 'press:pf3']);
  });

  it('does not wait forever for a host that answered before the macro looked', async () => {
    const { target, log } = fakeTarget({ locked: [false] });
    let t = 0;
    const r = await runMacro(macro([{ type: 'key', action: 'enter' }, { type: 'waitInput' }, { type: 'text', text: 'x' }]), target, { ...instant, now: () => (t += 100), busyGraceMs: 400 });
    expect(r).toEqual({ ok: true });
    expect(log).toEqual(['press:enter', 'type:x']);
  });

  it('stops with the step and the reason when the host stays locked', async () => {
    const { target } = fakeTarget({ locked: [true] });
    let t = 0;
    const r = await runMacro(macro([{ type: 'key', action: 'enter' }, { type: 'waitInput' }]), target, { ...instant, now: () => (t += 1000), timeoutMs: 5000 });
    expect(r).toEqual({ ok: false, step: 1, reason: 'the host did not accept input in time' });
  });

  it('refuses to type into a locked keyboard', async () => {
    const { target, log } = fakeTarget({ locked: [true] });
    const r = await runMacro(macro([{ type: 'text', text: 'x' }]), target, instant);
    expect(r).toEqual({ ok: false, step: 0, reason: 'the keyboard is locked' });
    expect(log).toEqual([]);
  });

  it('waits for a text on the screen, with the step timeout', async () => {
    const { target, log } = fakeTarget({ screen: ['Sign On', 'Sign On', 'Main Menu'] });
    const r = await runMacro(macro([{ type: 'waitText', text: 'Main Menu' }, { type: 'text', text: 'go' }]), target, instant);
    expect(r).toEqual({ ok: true });
    expect(log).toEqual(['type:go']);
    let t = 0;
    const missing = await runMacro(macro([{ type: 'waitText', text: 'Never', timeoutMs: 300 }]), fakeTarget().target, { ...instant, now: () => (t += 100) });
    expect(missing).toEqual({ ok: false, step: 0, reason: '"Never" did not appear' });
  });

  it('asks for a prompt value and types it; a cancelled prompt stops the macro', async () => {
    const { target, log } = fakeTarget({ answers: ['secret', undefined] });
    expect(await runMacro(macro([{ type: 'prompt', label: 'Password', secret: true }, { type: 'key', action: 'enter' }]), target, instant)).toEqual({ ok: true });
    expect(log).toEqual(['prompt:Password', 'type:secret', 'press:enter']);
    expect(await runMacro(macro([{ type: 'prompt', label: 'Order' }]), target, instant)).toEqual({ ok: false, step: 0, reason: 'cancelled' });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const { target, log } = fakeTarget({ locked: [true] });
    const run = runMacro(macro([{ type: 'key', action: 'enter' }, { type: 'waitInput' }, { type: 'text', text: 'never' }]), target, { ...instant, signal: controller.signal, sleep: async () => controller.abort() });
    expect(await run).toEqual({ ok: false, step: 1, reason: 'stopped' });
    expect(log).toEqual(['press:enter']);
  });

  it('pauses for a wait step', async () => {
    const slept: number[] = [];
    const { target } = fakeTarget();
    await runMacro(macro([{ type: 'wait', ms: 250 }]), target, { sleep: async (ms) => void slept.push(ms) });
    expect(slept).toEqual([250]);
  });
});

describe('macro helpers', () => {
  it('describes steps and names actions', () => {
    expect(describeStep({ type: 'text', text: 'abc' })).toBe('Type "abc"');
    expect(describeStep({ type: 'key', action: 'pf12' })).toBe('Press F12');
    expect(describeStep({ type: 'key', action: 'fieldExit' })).toBe('Press Field Exit');
    expect(describeStep({ type: 'waitInput' })).toBe('Wait for the host to accept input');
    expect(describeStep({ type: 'waitText', text: 'Menu', timeoutMs: 5000 })).toBe('Wait for "Menu" on the screen (5000 ms)');
    expect(describeStep({ type: 'prompt', label: 'Password', secret: true })).toBe('Ask for Password (hidden) and type it');
    expect(actionName('enter')).toBe('Enter');
  });

  it('matches a key event against the macro key in keyName form', () => {
    // A character key carries its shift state in the character ("!" is Shift+1 on a US keyboard).
    const ev = { key: '1', code: 'Digit1', ctrl: true, shift: false, alt: false, meta: false };
    expect(keyMatches(ev, 'Ctrl+1')).toBe(true);
    expect(keyMatches({ ...ev, key: '!', shift: true }, 'Ctrl+!')).toBe(true);
    expect(keyMatches({ key: 'F5', code: 'F5', ctrl: false, shift: true, alt: false, meta: false }, 'Shift+F5')).toBe(true);
    expect(keyMatches(ev, 'Ctrl+Shift+1')).toBe(false);
    expect(keyMatches(ev, '')).toBe(false);
  });

  it('sanitizes a macro from a settings file, dropping bad steps', () => {
    const m = sanitizeMacro({
      id: 'a',
      name: 'Sign on',
      key: 'Ctrl+Shift+S',
      steps: [
        { type: 'text', text: 'user' },
        { type: 'key', action: 'tab' },
        { type: 'key', action: 'notAKey' },
        { type: 'prompt', label: 'Password', secret: true },
        { type: 'wait', ms: 12.6 },
        { type: 'wait', ms: -1 },
        { type: 'waitText', text: '' },
        { type: 'waitText', text: 'Menu', timeoutMs: 1000 },
        { type: 'waitInput', extra: 1 },
        'junk',
      ],
    });
    expect(m).toEqual({
      id: 'a',
      name: 'Sign on',
      key: 'Ctrl+Shift+S',
      steps: [
        { type: 'text', text: 'user' },
        { type: 'key', action: 'tab' },
        { type: 'prompt', label: 'Password', secret: true },
        { type: 'wait', ms: 13 },
        { type: 'waitText', text: 'Menu', timeoutMs: 1000 },
        { type: 'waitInput' },
      ],
    });
    expect(sanitizeMacro({ name: 'no id' })).toBeUndefined();
    expect(sanitizeMacro(null)).toBeUndefined();
  });

  it('reports what keeps a macro from being saved', () => {
    const others: Macro[] = [{ id: 'x', name: 'Other', key: 'Ctrl+Shift+1', steps: [{ type: 'waitInput' }] }];
    expect(macroProblems(macro([], 'Ctrl+Shift+1'), others)).toEqual(['The macro has no steps.', 'Ctrl+Shift+1 already runs "Other".']);
    expect(macroProblems({ ...macro([{ type: 'waitInput' }]), name: ' ' }, [])).toEqual(['The macro needs a name.']);
    expect(macroProblems(macro([{ type: 'waitInput' }], 'Ctrl+Shift+2'), others)).toEqual([]);
  });
});

describe('macro files', () => {
  const a: Macro = { id: 'a', name: 'A', key: 'Ctrl+Alt+1', steps: [{ type: 'key', action: 'enter' }] };
  const b: Macro = { id: 'b', name: 'B', key: '', steps: [{ type: 'text', text: 'x' }] };

  it('writes and reads the export format, dropping what is malformed', () => {
    const text = macrosToJson([a, b]);
    expect(text.startsWith('{\n  "tn5250Macros": 1,')).toBe(true);
    expect(macrosFromJson(text)).toEqual([a, b]);
    expect(macrosFromJson('﻿' + text)).toEqual([a, b]);
    expect(macrosFromJson(JSON.stringify([a, { id: 'bad' }]))).toEqual([a]);
    expect(macrosFromJson('not json')).toBeUndefined();
    expect(macrosFromJson('{"other": 1}')).toBeUndefined();
  });

  it('merges imported macros: same id replaces, a taken key is dropped, the saved list is not changed', () => {
    const saved = [a];
    const r = mergeMacros(saved, [{ ...b, key: 'Ctrl+Alt+1' }, { ...a, name: 'A2' }]);
    expect(r.added).toBe(1);
    expect(r.replaced).toBe(1);
    expect(r.keysDropped).toEqual(['B']);
    expect(r.macros).toEqual([{ ...a, name: 'A2' }, { ...b, key: '' }]);
    expect(saved).toEqual([a]);
  });
});

describe('watchRecording', () => {
  /** A hand-driven clock and interval. */
  function harness(): { tick: () => void; clock: { t: number }; timers: NonNullable<Parameters<typeof watchRecording>[1]['timers']>; cleared: () => boolean } {
    const clock = { t: 0 };
    let fn: (() => void) | undefined;
    let cleared = false;
    const timers = {
      setInterval: (f: () => void) => {
        fn = f;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    };
    return { tick: () => fn?.(), clock, timers, cleared: () => cleared };
  }

  it('reminds every reminder period and ends the recording after the idle limit', () => {
    const h = harness();
    const rec = new MacroRecorder(() => h.clock.t);
    const reminders: number[] = [];
    let idle = 0;
    watchRecording(rec, { onIdle: () => idle++, onReminder: (m) => reminders.push(m), timers: h.timers, now: () => h.clock.t });
    // Typing within the first minutes: nothing yet.
    h.clock.t = 60_000;
    rec.text('wrkactjob');
    h.tick();
    expect(reminders).toEqual([]);
    // Five minutes in, still typing now and then: a reminder, no stop.
    h.clock.t = RECORDING_REMINDER_MS;
    rec.key('enter');
    h.tick();
    expect(reminders).toEqual([5]);
    expect(idle).toBe(0);
    h.clock.t = RECORDING_REMINDER_MS + 60_000;
    h.tick();
    expect(reminders).toEqual([5]); // not repeated inside the period
    // Second reminder at ten minutes, with a keystroke at nine so the idle limit is not hit.
    h.clock.t = 9 * 60_000;
    rec.text('x');
    h.clock.t = 2 * RECORDING_REMINDER_MS;
    h.tick();
    expect(reminders).toEqual([5, 10]);
    expect(idle).toBe(0);
    // Idle for the whole limit since that keystroke: the recording ends once and the watch stops.
    h.clock.t = 9 * 60_000 + RECORDING_IDLE_LIMIT_MS + 1;
    h.tick();
    expect(idle).toBe(1);
    expect(h.cleared()).toBe(true);
    h.tick();
    expect(idle).toBe(1);
  });

  it('stops watching when told to, and keystrokes reset the idle clock', () => {
    const h = harness();
    const rec = new MacroRecorder(() => h.clock.t);
    let idle = 0;
    const stop = watchRecording(rec, { onIdle: () => idle++, onReminder: () => undefined, idleMs: 1000, reminderMs: 100_000, timers: h.timers, now: () => h.clock.t });
    h.clock.t = 900;
    rec.text('a');
    h.clock.t = 1800;
    h.tick();
    expect(idle).toBe(0); // 900 ms since the last keystroke
    stop();
    expect(h.cleared()).toBe(true);
    h.clock.t = 5000;
    h.tick();
    expect(idle).toBe(0); // stopped: no callbacks
    expect(rec.lastInputAt).toBe(900);
    expect(rec.startedAt).toBe(0);
  });
});
