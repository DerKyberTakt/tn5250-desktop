// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chipLabel, macroEditorDialog, macroKeyFromEvent } from '../../src/desktop/macroEditor';
import type { Macro } from '../../src/shared/macros';

// jsdom has no showModal(): the editor only needs open/close and the close event.
beforeEach(() => {
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);

const dialog = (): HTMLDialogElement => document.querySelector('dialog.macro-editor') as HTMLDialogElement;
const button = (label: string): HTMLButtonElement => {
  const b = [...dialog().querySelectorAll('button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const setInput = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const chips = (): HTMLLIElement[] => [...dialog().querySelectorAll<HTMLLIElement>('.macro-timeline li.chip:not(.end)')];
const labels = (): string[] => chips().map((c) => c.querySelector('.label')?.textContent ?? '');
const panel = (): HTMLElement => dialog().querySelector('.step-panel') as HTMLElement;
const panelInput = (): HTMLInputElement => panel().querySelector('input, select') as HTMLInputElement;

describe('macroKeyFromEvent', () => {
  it('takes function keys and chords with Ctrl, Alt or Meta, in keyName form', () => {
    expect(macroKeyFromEvent(key({ key: 'F5', code: 'F5' }))).toBe('F5');
    expect(macroKeyFromEvent(key({ key: 'F5', code: 'F5', shiftKey: true }))).toBe('Shift+F5');
    expect(macroKeyFromEvent(key({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+1');
    expect(macroKeyFromEvent(key({ key: 'm', code: 'KeyM', altKey: true }))).toBe('Alt+M');
  });

  it('refuses plain keys, Shift alone with a character, and bare modifiers', () => {
    expect(macroKeyFromEvent(key({ key: 'a', code: 'KeyA' }))).toBeUndefined();
    expect(macroKeyFromEvent(key({ key: 'A', code: 'KeyA', shiftKey: true }))).toBeUndefined();
    expect(macroKeyFromEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeUndefined();
    expect(macroKeyFromEvent(key({ key: 'Enter', code: 'Enter' }))).toBeUndefined();
  });
});

describe('chipLabel', () => {
  it('keeps chips short and tells the step kinds apart', () => {
    expect(chipLabel({ type: 'text', text: 'wrkactjob' })).toBe('"wrkactjob"');
    expect(chipLabel({ type: 'text', text: 'a very long piece of typed text indeed' })).toBe('"a very long piece…"');
    expect(chipLabel({ type: 'key', action: 'enter' })).toBe('Enter');
    expect(chipLabel({ type: 'wait', ms: 250 })).toBe('250 ms');
    expect(chipLabel({ type: 'waitInput' })).toBe('wait for input');
    expect(chipLabel({ type: 'waitText', text: 'Main Menu' })).toBe('until "Main Menu"');
    expect(chipLabel({ type: 'prompt', label: 'Password' })).toBe('ask: Password');
    expect(chipLabel({ type: 'text', text: '' })).toBe('text…');
  });
});

describe('macroEditorDialog', () => {
  const macro: Macro = { id: 'm1', name: 'Sign off', key: '', steps: [{ type: 'text', text: 'signoff' }, { type: 'key', action: 'enter' }, { type: 'waitInput' }] };

  it('shows the steps as chips, edits the selected one in the panel, saves a copy and leaves the original alone', async () => {
    const result = macroEditorDialog(macro, []);
    expect(labels()).toEqual(['"signoff"', 'Enter', 'wait for input']);
    expect(panel().textContent).toContain('Select a step');
    const name = dialog().querySelector<HTMLInputElement>('.head input[type="text"]:not(.keycapture)') as HTMLInputElement;
    setInput(name, 'Sign off now');
    chips()[0]?.click();
    expect(chips()[0]?.classList.contains('selected')).toBe(true);
    expect(panel().textContent).toContain('Step 1: Type text');
    setInput(panelInput(), 'SIGNOFF *LIST');
    // The chip follows the field.
    expect(labels()[0]).toBe('"SIGNOFF *LIST"');
    button('Save').click();
    const r = await result;
    expect(r?.action).toBe('save');
    expect(r?.macro.name).toBe('Sign off now');
    expect(r?.macro.steps[0]).toEqual({ type: 'text', text: 'SIGNOFF *LIST' });
    expect(macro.name).toBe('Sign off');
    expect(macro.steps[0]).toEqual({ type: 'text', text: 'signoff' });
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('adds steps and delays after the selected chip, at the end when nothing is selected, and moves and removes them', async () => {
    const result = macroEditorDialog(macro, []);
    // Nothing selected: a delay goes at the end, 0 ms, and becomes the selection.
    button('Add delay').click();
    expect(labels()).toEqual(['"signoff"', 'Enter', 'wait for input', '0 ms']);
    expect(chips()[3]?.classList.contains('selected')).toBe(true);
    expect(panel().textContent).toContain('Delay');
    setInput(panelInput(), '750');
    expect(labels()[3]).toBe('750 ms');
    // Select the first chip: a new step goes right after it.
    chips()[0]?.click();
    const kind = dialog().querySelector<HTMLSelectElement>('.step-tools select') as HTMLSelectElement;
    kind.value = 'prompt';
    button('Add step').click();
    expect(labels()).toEqual(['"signoff"', 'ask: …', 'Enter', 'wait for input', '750 ms']);
    setInput(panelInput(), 'Order');
    (panel().querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    expect(labels()[1]).toBe('ask: Order');
    // Move it right twice with the arrows, then remove the wait for input with Delete on its chip.
    button('▶').click();
    button('▶').click();
    expect(labels()).toEqual(['"signoff"', 'Enter', 'wait for input', 'ask: Order', '750 ms']);
    chips()[2]?.dispatchEvent(key({ key: 'Delete', cancelable: true }));
    expect(labels()).toEqual(['"signoff"', 'Enter', 'ask: Order', '750 ms']);
    // The selection moved to the chip that took its place.
    expect(chips()[2]?.classList.contains('selected')).toBe(true);
    button('Save').click();
    const r = await result;
    expect(r?.macro.steps).toEqual([{ type: 'text', text: 'signoff' }, { type: 'key', action: 'enter' }, { type: 'prompt', label: 'Order', secret: true }, { type: 'wait', ms: 750 }]);
  });

  it('offers Record from here with the insert position after the selected chip', async () => {
    const result = macroEditorDialog(macro, [], { canRun: true, canRecord: true });
    chips()[1]?.click();
    button('Record from here').click();
    const r = await result;
    expect(r?.action).toBe('record');
    expect(r?.insertAt).toBe(2);
    expect(r?.macro.steps).toHaveLength(3);
    // Without a session the button is not there.
    void macroEditorDialog(macro, [], { canRun: false });
    expect([...dialog().querySelectorAll('button')].some((b) => b.textContent === 'Record from here')).toBe(false);
    expect([...dialog().querySelectorAll('button')].some((b) => b.textContent === 'Save and run')).toBe(false);
  });

  it('captures the key from a key press, refuses a plain letter, clears with Backspace, refuses a taken key', async () => {
    const result = macroEditorDialog(macro, [{ id: 'other', name: 'Other', key: 'Ctrl+Alt+2', steps: [{ type: 'waitInput' }] }]);
    const capture = dialog().querySelector<HTMLInputElement>('input.keycapture') as HTMLInputElement;
    capture.dispatchEvent(key({ key: 'a', code: 'KeyA', cancelable: true }));
    expect(capture.value).toBe('');
    capture.dispatchEvent(key({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true }));
    expect(capture.value).toBe('Ctrl+Alt+2');
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toContain('already runs "Other"');
    capture.dispatchEvent(key({ key: 'Backspace', code: 'Backspace', cancelable: true }));
    expect(capture.value).toBe('');
    capture.dispatchEvent(key({ key: 'F7', code: 'F7', cancelable: true }));
    button('Save').click();
    const r = await result;
    expect(r?.macro.key).toBe('F7');
  });

  it('refuses a macro without a name or steps, drops empty text steps, resets to the original, cancels cleanly', async () => {
    const blank: Macro = { id: 'm2', name: '', key: '', steps: [] };
    const result = macroEditorDialog(blank, [], { canRun: true });
    expect(panel().textContent).toContain('No steps yet');
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toBe('The macro needs a name. The macro has no steps.');
    const kind = dialog().querySelector<HTMLSelectElement>('.step-tools select') as HTMLSelectElement;
    kind.value = 'text';
    button('Add step').click();
    expect(labels()).toEqual(['text…']);
    button('Save and run').click();
    // An empty text step does not count as a step.
    expect(dialog().querySelector('.problems')?.textContent).toContain('no steps');
    expect(labels()).toEqual([]);
    button('Add delay').click();
    expect(labels()).toEqual(['0 ms']);
    button('Reset').click();
    expect(labels()).toEqual([]);
    button('Cancel').click();
    expect(await result).toBeUndefined();
    expect(document.querySelector('dialog')).toBeNull();
  });
});
