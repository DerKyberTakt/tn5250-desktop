// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { macroEditorDialog, macroKeyFromEvent } from '../../src/desktop/macroEditor';
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
  input.dispatchEvent(new Event('input'));
};
const stepRows = (): HTMLLIElement[] => [...dialog().querySelectorAll<HTMLLIElement>('.macro-steps li:not(.empty)')];

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

describe('macroEditorDialog', () => {
  const macro: Macro = { id: 'm1', name: 'Sign off', key: '', steps: [{ type: 'text', text: 'signoff' }, { type: 'key', action: 'enter' }, { type: 'waitInput' }] };

  it('shows the steps, saves the edited copy and leaves the original alone', async () => {
    const result = macroEditorDialog(macro, []);
    expect(stepRows()).toHaveLength(3);
    const name = dialog().querySelector<HTMLInputElement>('.head input[type="text"]:not(.keycapture)') as HTMLInputElement;
    setInput(name, 'Sign off now');
    const text = stepRows()[0]?.querySelector('input') as HTMLInputElement;
    setInput(text, 'SIGNOFF *LIST');
    button('Save').click();
    const r = await result;
    expect(r?.action).toBe('save');
    expect(r?.macro.name).toBe('Sign off now');
    expect(r?.macro.steps[0]).toEqual({ type: 'text', text: 'SIGNOFF *LIST' });
    expect(macro.name).toBe('Sign off');
    expect(macro.steps[0]).toEqual({ type: 'text', text: 'signoff' });
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('moves, removes and adds steps', async () => {
    const result = macroEditorDialog(macro, []);
    (stepRows()[1]?.querySelector('button[title="Move up"]') as HTMLButtonElement).click();
    expect(stepRows()[0]?.querySelector('.kind')?.textContent).toBe('Press a key');
    (stepRows()[2]?.querySelector('button.remove') as HTMLButtonElement).click();
    expect(stepRows()).toHaveLength(2);
    const kind = dialog().querySelector<HTMLSelectElement>('.add-step select') as HTMLSelectElement;
    kind.value = 'prompt';
    button('Add step').click();
    expect(stepRows()).toHaveLength(3);
    const label = stepRows()[2]?.querySelector('input[type="text"]') as HTMLInputElement;
    setInput(label, 'Password');
    (stepRows()[2]?.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    button('Save').click();
    const r = await result;
    expect(r?.macro.steps).toEqual([{ type: 'key', action: 'enter' }, { type: 'text', text: 'signoff' }, { type: 'prompt', label: 'Password', secret: true }]);
  });

  it('captures the key from a key press, refuses a plain letter, clears with Backspace', async () => {
    const result = macroEditorDialog(macro, [{ id: 'other', name: 'Other', key: 'Ctrl+Alt+2', steps: [{ type: 'waitInput' }] }]);
    const capture = dialog().querySelector<HTMLInputElement>('input.keycapture') as HTMLInputElement;
    capture.dispatchEvent(key({ key: 'a', code: 'KeyA', cancelable: true }));
    expect(capture.value).toBe('');
    capture.dispatchEvent(key({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true }));
    expect(capture.value).toBe('Ctrl+Alt+2');
    // The key is taken by another macro: Save refuses and says so.
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toContain('already runs "Other"');
    capture.dispatchEvent(key({ key: 'Backspace', code: 'Backspace', cancelable: true }));
    expect(capture.value).toBe('');
    capture.dispatchEvent(key({ key: 'F7', code: 'F7', cancelable: true }));
    button('Save').click();
    const r = await result;
    expect(r?.macro.key).toBe('F7');
  });

  it('refuses a macro without a name or without steps, drops empty text steps, and cancels cleanly', async () => {
    const blank: Macro = { id: 'm2', name: '', key: '', steps: [] };
    const result = macroEditorDialog(blank, [], { canRun: true });
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toBe('The macro needs a name. The macro has no steps.');
    const kind = dialog().querySelector<HTMLSelectElement>('.add-step select') as HTMLSelectElement;
    kind.value = 'text';
    button('Add step').click();
    button('Save and run').click();
    // An empty text step does not count as a step.
    expect(dialog().querySelector('.problems')?.textContent).toContain('no steps');
    button('Cancel').click();
    expect(await result).toBeUndefined();
    expect(document.querySelector('dialog')).toBeNull();
  });
});
