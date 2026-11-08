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
const hasButton = (label: string): boolean => [...dialog().querySelectorAll('button')].some((x) => x.textContent === label);
const setInput = (input: HTMLInputElement, value: string): void => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const chips = (): HTMLLIElement[] => [...dialog().querySelectorAll<HTMLLIElement>('.macro-timeline li.chip:not(.end)')];
/** What each chip shows: its label, plus the unit for a delay. */
const labels = (): string[] =>
  chips().map((c) => {
    const field = c.querySelector<HTMLInputElement | HTMLSelectElement>(':scope > .inline');
    return [field ? field.value : c.querySelector('.label')?.textContent, c.querySelector(':scope > .unit')?.textContent]
      .filter((x): x is string => typeof x === 'string')
      .join(' ');
  });
const plus = (): HTMLLIElement => dialog().querySelector('.macro-timeline li.chip.end') as HTMLLIElement;
const inline = (): HTMLInputElement | HTMLSelectElement | null => dialog().querySelector('.macro-timeline .inline');
const card = (): HTMLElement | null => dialog().querySelector('.macro-timeline .card');
const menuItem = (label: string): HTMLButtonElement => {
  const b = [...dialog().querySelectorAll<HTMLButtonElement>('.add-menu button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no menu item ${label}`);
  return b;
};
const selectedIndex = (): number | undefined => {
  const i = chips().findIndex((c) => c.classList.contains('selected'));
  return i < 0 ? undefined : i;
};

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

  it('shows the steps as chips, the name as the title, edits a text chip in place, saves a copy and leaves the original alone', async () => {
    const result = macroEditorDialog(macro, []);
    expect(labels()).toEqual(['"signoff"', 'Enter', 'wait for input']);
    expect(chips()[1]?.classList.contains('key')).toBe(true);
    // An arrow between every two steps, none after the last.
    expect(dialog().querySelectorAll('.macro-timeline li.arrow')).toHaveLength(2);
    const name = dialog().querySelector<HTMLInputElement>('input.name') as HTMLInputElement;
    expect(name.value).toBe('Sign off');
    setInput(name, 'Sign off now');
    // Click a text chip: it becomes a field with the text; Enter commits and the chip shows the new text.
    chips()[0]?.click();
    expect(selectedIndex()).toBe(0);
    const field = inline() as HTMLInputElement;
    expect(field.value).toBe('signoff');
    setInput(field, 'SIGNOFF *LIST');
    field.dispatchEvent(key({ key: 'Enter', cancelable: true, bubbles: true }));
    expect(inline()).toBeNull();
    expect(labels()[0]).toBe('"SIGNOFF *LIST"');
    // A wait-for-input chip has nothing to set: a click only selects it.
    chips()[2]?.click();
    expect(inline()).toBeNull();
    expect(selectedIndex()).toBe(2);
    button('Save').click();
    const r = await result;
    expect(r?.action).toBe('save');
    expect(r?.macro.name).toBe('Sign off now');
    expect(r?.macro.steps[0]).toEqual({ type: 'text', text: 'SIGNOFF *LIST' });
    expect(macro.name).toBe('Sign off');
    expect(macro.steps[0]).toEqual({ type: 'text', text: 'signoff' });
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('Escape in a field puts the old value back; a key chip edits through a list', async () => {
    void macroEditorDialog(macro, []);
    chips()[0]?.click();
    setInput(inline() as HTMLInputElement, 'nope');
    inline()?.dispatchEvent(key({ key: 'Escape', cancelable: true, bubbles: true }));
    expect(labels()[0]).toBe('"signoff"');
    chips()[1]?.click();
    const list = inline() as HTMLSelectElement;
    expect(list.tagName).toBe('SELECT');
    expect(list.value).toBe('enter');
    list.value = 'pf3';
    list.dispatchEvent(new Event('change', { bubbles: true }));
    expect(inline()).toBeNull();
    expect(labels()[1]).toBe('F3');
  });

  it('the + menu adds after the selected chip (at the end when nothing is selected); a delay starts at 0 ms and edits in place', async () => {
    const result = macroEditorDialog(macro, []);
    // Nothing selected: + at the end opens the menu, Delay goes last, 0 ms, open for editing.
    plus().click();
    expect(dialog().querySelector('.add-menu')).not.toBeNull();
    menuItem('Delay').click();
    // The new delay is open for editing: its field shows 0 and the unit stays beside it.
    expect(labels()).toEqual(['"signoff"', 'Enter', 'wait for input', '0 ms']);
    expect(selectedIndex()).toBe(3);
    const ms = inline() as HTMLInputElement;
    expect(ms.type).toBe('number');
    setInput(ms, '750');
    ms.dispatchEvent(key({ key: 'Enter', cancelable: true, bubbles: true }));
    expect(labels()[3]).toBe('750 ms');
    expect(chips()[3]?.classList.contains('wait')).toBe(true);
    // Select the first chip (a click opens its field; Enter closes it and keeps the selection), then + inserts after it.
    chips()[0]?.click();
    inline()?.dispatchEvent(key({ key: 'Enter', cancelable: true, bubbles: true }));
    expect(selectedIndex()).toBe(0);
    plus().click();
    menuItem('Ask for a value').click();
    expect(labels()).toEqual(['"signoff"', 'ask: …', 'Enter', 'wait for input', '750 ms']);
    // A prompt opens a card under its chip; the chip follows the fields; Done closes it.
    const c = card() as HTMLElement;
    expect(c).not.toBeNull();
    setInput(c.querySelector('input[type="text"]') as HTMLInputElement, 'Order');
    (c.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    expect(labels()[1]).toBe('ask: Order');
    button('Done').click();
    expect(card()).toBeNull();
    // Alt+Right moves it twice; Delete on a focused chip removes it; the selection moves to the chip that took its place.
    chips()[1]?.dispatchEvent(key({ key: 'ArrowRight', altKey: true, cancelable: true }));
    chips()[2]?.dispatchEvent(key({ key: 'ArrowRight', altKey: true, cancelable: true }));
    expect(labels()).toEqual(['"signoff"', 'Enter', 'wait for input', 'ask: Order', '750 ms']);
    chips()[2]?.dispatchEvent(key({ key: 'Delete', cancelable: true }));
    expect(labels()).toEqual(['"signoff"', 'Enter', 'ask: Order', '750 ms']);
    expect(selectedIndex()).toBe(2);
    expect(dialog().querySelectorAll('.macro-timeline li.arrow')).toHaveLength(3);
    button('Save').click();
    const r = await result;
    expect(r?.macro.steps).toEqual([{ type: 'text', text: 'signoff' }, { type: 'key', action: 'enter' }, { type: 'prompt', label: 'Order', secret: true }, { type: 'wait', ms: 750 }]);
  });

  it('right-click on a chip opens the same menu with Remove; Record from here reports the insert position', async () => {
    const result = macroEditorDialog(macro, [], { canRun: true, canRecord: true });
    chips()[1]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(selectedIndex()).toBe(1);
    expect(menuItem('Remove')).toBeDefined();
    menuItem('Record from here').click();
    const r = await result;
    expect(r?.action).toBe('record');
    expect(r?.insertAt).toBe(2);
    expect(r?.macro.steps).toHaveLength(3);
    // Without a session: no Record from here in the menu, no Save and run.
    void macroEditorDialog(macro, [], { canRun: false });
    plus().click();
    expect([...dialog().querySelectorAll('.add-menu button')].map((b) => b.textContent)).toEqual(['Key', 'Text', 'Delay', 'Wait for input', 'Wait for a text on the screen', 'Ask for a value']);
    expect(hasButton('Save and run')).toBe(false);
    // Remove from the menu.
    chips()[0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    menuItem('Remove').click();
    expect(labels()).toEqual(['Enter', 'wait for input']);
  });

  it('drags a chip with the pointer: a few pixels of movement start it, the release ends it and swallows the click', () => {
    void macroEditorDialog(macro, []);
    const pointer = (type: string, x: number, y: number): MouseEvent => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    chips()[0]?.dispatchEvent(pointer('pointerdown', 10, 10));
    // Two pixels: still a click in the making, nothing dragged.
    document.dispatchEvent(pointer('pointermove', 12, 10));
    expect(chips()[0]?.classList.contains('dragging')).toBe(false);
    document.dispatchEvent(pointer('pointermove', 30, 10));
    expect(chips()[0]?.classList.contains('dragging')).toBe(true);
    expect(dialog().classList.contains('dragging-chip')).toBe(true);
    document.dispatchEvent(pointer('pointerup', 30, 10));
    expect(chips().some((c) => c.classList.contains('dragging'))).toBe(false);
    expect(dialog().classList.contains('dragging-chip')).toBe(false);
    // The click the release produces must not open the field.
    chips()[0]?.click();
    expect(inline()).toBeNull();
    chips()[0]?.click();
    expect(inline()).not.toBeNull();
  });

  it('captures the key from a key press, refuses a plain letter, clears with Backspace, refuses a taken key', async () => {
    const result = macroEditorDialog(macro, [{ id: 'other', name: 'Other', key: 'Ctrl+Alt+2', steps: [{ type: 'waitInput' }] }]);
    const capture = dialog().querySelector<HTMLInputElement>('input.keycapture') as HTMLInputElement;
    capture.dispatchEvent(key({ key: 'a', code: 'KeyA', cancelable: true }));
    expect(capture.value).toBe('');
    const clear = dialog().querySelector('button.clear') as HTMLButtonElement;
    expect(clear.hidden).toBe(true);
    expect(capture.placeholder).toBe('e.g. Ctrl+R');
    expect(dialog().querySelector('.info .tip')?.textContent).toContain('Macro keybinds are checked before the terminal keybinds');
    expect(dialog().querySelector('.info')?.getAttribute('title')).toBeNull();
    capture.dispatchEvent(key({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true }));
    expect(capture.value).toBe('Ctrl+Alt+2');
    expect(clear.hidden).toBe(false);
    // The red x removes it; a key press sets it again.
    clear.click();
    expect(capture.value).toBe('');
    expect(clear.hidden).toBe(true);
    capture.dispatchEvent(key({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true, cancelable: true }));
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toContain('already runs "Other"');
    capture.dispatchEvent(key({ key: 'Backspace', code: 'Backspace', cancelable: true }));
    expect(capture.value).toBe('');
    capture.dispatchEvent(key({ key: 'F7', code: 'F7', cancelable: true }));
    button('Save').click();
    const r = await result;
    expect(r?.macro.key).toBe('F7');
  });

  it('refuses a macro without a name or steps, drops empty text steps, resets to the original, closes with the X', async () => {
    const blank: Macro = { id: 'm2', name: '', key: '', steps: [] };
    const result = macroEditorDialog(blank, [], { canRun: true });
    expect(dialog().querySelector('.macro-timeline .empty')?.textContent).toContain('No steps yet');
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toBe('The macro needs a name. The macro has no steps.');
    plus().click();
    menuItem('Text').click();
    // The new text step is open for editing, empty.
    expect(labels()).toEqual(['']);
    expect((inline() as HTMLInputElement).placeholder).toBe('text to type');
    button('Save and run').click();
    // An empty text step does not count as a step.
    expect(dialog().querySelector('.problems')?.textContent).toContain('no steps');
    expect(labels()).toEqual([]);
    plus().click();
    menuItem('Delay').click();
    expect(labels()).toEqual(['0 ms']);
    button('Reset').click();
    expect(labels()).toEqual([]);
    (dialog().querySelector('button.close') as HTMLButtonElement).click();
    expect(await result).toBeUndefined();
    expect(document.querySelector('dialog')).toBeNull();
  });
});
