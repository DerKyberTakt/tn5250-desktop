import type { KeyAction } from './keymap';
import { keyName } from './keymap';
import type { KeyEventInfo } from './protocol';

/**
 * Macros: recorded or hand-written sequences of keystrokes a session plays back, with a
 * key that runs them. Shared between the desktop app and the VS Code extension; the UI
 * (recorder button, editor, key capture) lives in each host, this file holds the model,
 * the recorder and the player, with nothing from the DOM.
 *
 * A step is text to type, a 5250 function key, a pause, a wait for the host to accept
 * input again (what the recorder puts after Enter or a function key, so a macro never
 * types into a locked keyboard), a wait for a text on the screen, or a prompt that asks
 * the user for a value at playback (a password, an order number) and types the answer.
 */
export type MacroStep =
  | { type: 'text'; text: string }
  | { type: 'key'; action: KeyAction }
  | { type: 'wait'; ms: number }
  | { type: 'waitInput' }
  | { type: 'waitText'; text: string; timeoutMs?: number }
  | { type: 'prompt'; label: string; secret?: boolean };

export interface Macro {
  id: string;
  name: string;
  /** The key that runs it, in keyName() form ("Ctrl+Shift+1"); '' for none. */
  key: string;
  steps: MacroStep[];
}

export function newMacroId(): string {
  return `m${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/** Keys the host answers: the recorder waits for input after each of them. */
export const AID_ACTIONS: ReadonlySet<KeyAction> = new Set<KeyAction>([
  'enter', 'pageUp', 'pageDown', 'clear', 'help', 'attn', 'sysreq', 'print', 'testRequest',
  'pf1', 'pf2', 'pf3', 'pf4', 'pf5', 'pf6', 'pf7', 'pf8', 'pf9', 'pf10', 'pf11', 'pf12',
  'pf13', 'pf14', 'pf15', 'pf16', 'pf17', 'pf18', 'pf19', 'pf20', 'pf21', 'pf22', 'pf23', 'pf24',
]);

/** Actions that never reach the host; a recording leaves them out. */
const LOCAL_ACTIONS: ReadonlySet<KeyAction> = new Set<KeyAction>(['copy', 'paste', 'printScreen', 'rule']);

/** Human names for the function keys and actions, for the editor and the step list. */
export const ACTION_NAMES: Partial<Record<KeyAction, string>> = {
  enter: 'Enter',
  fieldExit: 'Field Exit',
  fieldPlus: 'Field +',
  fieldMinus: 'Field -',
  tab: 'Tab',
  backtab: 'Back Tab',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  home: 'Home',
  newline: 'New Line',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  endOfField: 'End of Field',
  eraseEof: 'Erase EOF',
  eraseInput: 'Erase Input',
  dup: 'Dup',
  fieldMark: 'Field Mark',
  reset: 'Reset',
  attn: 'Attention',
  sysreq: 'System Request',
  clear: 'Clear',
  help: 'Help',
  pageUp: 'Page Up',
  pageDown: 'Page Down',
  print: 'Print',
  recordBackspace: 'Record Backspace',
  fastUp: 'Fast Up',
  fastDown: 'Fast Down',
  fastLeft: 'Fast Left',
  fastRight: 'Fast Right',
  wordLeft: 'Word Left',
  wordRight: 'Word Right',
  beginningOfField: 'Beginning of Field',
  deleteWord: 'Delete Word',
  eraseField: 'Erase Field',
  testRequest: 'Test Request',
};

export function actionName(action: KeyAction): string {
  const m = /^pf(\d+)$/.exec(action);
  if (m) return `F${m[1]}`;
  return ACTION_NAMES[action] ?? action;
}

/** The actions the editor offers, function keys first. */
export const EDITOR_ACTIONS: KeyAction[] = [
  'enter', 'fieldExit', 'fieldPlus', 'fieldMinus', 'tab', 'backtab', 'home', 'newline', 'eraseEof', 'eraseInput',
  'pf1', 'pf2', 'pf3', 'pf4', 'pf5', 'pf6', 'pf7', 'pf8', 'pf9', 'pf10', 'pf11', 'pf12',
  'pf13', 'pf14', 'pf15', 'pf16', 'pf17', 'pf18', 'pf19', 'pf20', 'pf21', 'pf22', 'pf23', 'pf24',
  'pageUp', 'pageDown', 'help', 'attn', 'sysreq', 'reset', 'clear', 'print', 'up', 'down', 'left', 'right',
  'backspace', 'delete', 'insert', 'endOfField', 'dup', 'fieldMark',
];

/** One line per step, for lists and logs. */
export function describeStep(step: MacroStep): string {
  switch (step.type) {
    case 'text':
      return `Type "${step.text}"`;
    case 'key':
      return `Press ${actionName(step.action)}`;
    case 'wait':
      return `Wait ${step.ms} ms`;
    case 'waitInput':
      return 'Wait for the host to accept input';
    case 'waitText':
      return `Wait for "${step.text}" on the screen${step.timeoutMs ? ` (${step.timeoutMs} ms)` : ''}`;
    case 'prompt':
      return `Ask for ${step.label || 'a value'}${step.secret ? ' (hidden)' : ''} and type it`;
  }
}

/**
 * Collects what the user does in a session into steps: consecutive characters become
 * one text step, a key the host answers is followed by a wait for input, local actions
 * (copy, paste, print screen, rule line) are left out.
 */
export class MacroRecorder {
  readonly steps: MacroStep[] = [];

  text(text: string): void {
    if (!text) return;
    const last = this.steps[this.steps.length - 1];
    if (last?.type === 'text') last.text += text;
    else this.steps.push({ type: 'text', text });
  }

  key(action: KeyAction): void {
    if (LOCAL_ACTIONS.has(action)) return;
    this.steps.push({ type: 'key', action });
    if (AID_ACTIONS.has(action)) this.steps.push({ type: 'waitInput' });
  }

  /** A trailing wait for input is of no use; the macro ends when its last key is sent. */
  finish(): MacroStep[] {
    const steps = [...this.steps];
    while (steps.length && steps[steps.length - 1]?.type === 'waitInput') steps.pop();
    return steps;
  }
}

/** What a macro plays into. */
export interface MacroTarget {
  type(text: string): void;
  press(action: KeyAction): void;
  /** True when the keyboard is not locked (the host accepts input). */
  inputAllowed(): boolean;
  /** The screen as text, rows joined with newlines. */
  screenText(): string;
  /** Asks the user for a value; undefined cancels the macro. */
  prompt(label: string, secret: boolean): Promise<string | undefined>;
}

/** The part of an AbortSignal a run looks at (shared code has no DOM or Node typings). */
export interface StopSignal {
  readonly aborted: boolean;
}

/** Timers without assuming a DOM or Node typing in shared code. */
const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown };

export interface RunOptions {
  signal?: StopSignal;
  /** How often the waits look at the session. */
  pollMs?: number;
  /** How long a wait for input or for a text may take before the macro stops. */
  timeoutMs?: number;
  /** After a key the host answers, how long to allow the keyboard to lock before giving up on seeing it lock. */
  busyGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type RunResult = { ok: true } | { ok: false; step: number; reason: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, ms));

/**
 * Plays a macro. A wait for input first gives the host a moment to lock the keyboard
 * (the lock arrives after the key went out) and then waits until it is free again; a
 * host that answered before the macro looked is not waited for.
 */
export async function runMacro(macro: Macro, target: MacroTarget, options: RunOptions = {}): Promise<RunResult> {
  const pollMs = options.pollMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 20000;
  const busyGraceMs = options.busyGraceMs ?? 400;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const stopped = (): boolean => options.signal?.aborted === true;

  const waitUntil = async (condition: () => boolean, limitMs: number): Promise<boolean> => {
    const start = now();
    while (!condition()) {
      if (stopped() || now() - start >= limitMs) return false;
      await sleep(pollMs);
    }
    return true;
  };

  for (let i = 0; i < macro.steps.length; i++) {
    if (stopped()) return { ok: false, step: i, reason: 'stopped' };
    const step = macro.steps[i] as MacroStep;
    switch (step.type) {
      case 'text':
        if (!target.inputAllowed()) return { ok: false, step: i, reason: 'the keyboard is locked' };
        target.type(step.text);
        break;
      case 'key':
        target.press(step.action);
        break;
      case 'wait':
        await sleep(step.ms);
        break;
      case 'waitInput':
        await waitUntil(() => !target.inputAllowed(), busyGraceMs);
        if (!(await waitUntil(() => target.inputAllowed(), timeoutMs))) {
          return { ok: false, step: i, reason: stopped() ? 'stopped' : 'the host did not accept input in time' };
        }
        break;
      case 'waitText': {
        const limit = step.timeoutMs ?? timeoutMs;
        if (!(await waitUntil(() => target.screenText().includes(step.text), limit))) {
          return { ok: false, step: i, reason: stopped() ? 'stopped' : `"${step.text}" did not appear` };
        }
        break;
      }
      case 'prompt': {
        const value = await target.prompt(step.label, step.secret === true);
        if (value === undefined) return { ok: false, step: i, reason: 'cancelled' };
        if (!target.inputAllowed()) return { ok: false, step: i, reason: 'the keyboard is locked' };
        target.type(value);
        break;
      }
    }
  }
  return { ok: true };
}

/** Whether a key event is the macro's key. */
export function keyMatches(event: KeyEventInfo, key: string): boolean {
  return !!key && keyName(event) === key;
}

const ACTIONS: ReadonlySet<string> = new Set<string>([...EDITOR_ACTIONS, 'recordBackspace', 'fastUp', 'fastDown', 'fastLeft', 'fastRight', 'wordLeft', 'wordRight', 'beginningOfField', 'deleteWord', 'eraseField', 'testRequest']);

function sanitizeStep(v: unknown): MacroStep | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  switch (s.type) {
    case 'text':
      return typeof s.text === 'string' && s.text ? { type: 'text', text: s.text } : undefined;
    case 'key':
      return typeof s.action === 'string' && ACTIONS.has(s.action) ? { type: 'key', action: s.action as KeyAction } : undefined;
    case 'wait':
      return typeof s.ms === 'number' && s.ms >= 0 && s.ms <= 600000 ? { type: 'wait', ms: Math.round(s.ms) } : undefined;
    case 'waitInput':
      return { type: 'waitInput' };
    case 'waitText':
      if (typeof s.text !== 'string' || !s.text) return undefined;
      return typeof s.timeoutMs === 'number' && s.timeoutMs > 0 ? { type: 'waitText', text: s.text, timeoutMs: Math.round(s.timeoutMs) } : { type: 'waitText', text: s.text };
    case 'prompt':
      return typeof s.label === 'string' ? { type: 'prompt', label: s.label, ...(s.secret === true ? { secret: true } : {}) } : undefined;
    default:
      return undefined;
  }
}

/** A macro read from a settings file: anything malformed is dropped, step by step. */
export function sanitizeMacro(v: unknown): Macro | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id || typeof m.name !== 'string') return undefined;
  const steps = Array.isArray(m.steps) ? m.steps.map(sanitizeStep).filter((s): s is MacroStep => !!s) : [];
  return { id: m.id, name: m.name, key: typeof m.key === 'string' ? m.key : '', steps };
}

/** What is wrong with a macro about to be saved; empty when it can be saved. */
export function macroProblems(macro: Macro, others: Macro[]): string[] {
  const problems: string[] = [];
  if (!macro.name.trim()) problems.push('The macro needs a name.');
  if (!macro.steps.length) problems.push('The macro has no steps.');
  if (macro.key) {
    const taken = others.find((o) => o.id !== macro.id && o.key === macro.key);
    if (taken) problems.push(`${macro.key} already runs "${taken.name}".`);
  }
  return problems;
}
