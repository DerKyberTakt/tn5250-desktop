/**
 * Small modal dialogs drawn by the shell (the OS dialogs only cover files). Every dialog has
 * the same frame: the title with an ESC keycap on its right, the body, and a row of keycaps
 * (grey = cancel or secondary, green = the primary action, red = a destructive one).
 */

import { actionButton, type ActionIconName, type ActionTone } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Field {
  label: string;
  value?: string;
  password?: boolean;
  placeholder?: string;
  /** A checkbox; its value comes back as 'true' or ''. `value: 'true'` starts it ticked. */
  checkbox?: boolean;
}

/** The face colour of a keycap button; the letters light up in the matching colour. */
export type KeyTone = 'esc' | 'grey' | 'green' | 'blue' | 'red';

/**
 * A keycap button: a raised key that drops onto its shadow on hover while its letters
 * light up one at a time (the whole word within about 300 ms, letters at most 100 ms apart).
 */
export function keyButton(label: string, tone: KeyTone, onClick: () => void, className = ''): HTMLButtonElement {
  const b = el('button', `keycap ${tone}${className ? ` ${className}` : ''}`);
  b.type = 'button';
  const chars = [...label];
  const step = chars.length > 1 ? Math.min(100, 300 / (chars.length - 1)) : 0;
  chars.forEach((ch, i) => {
    const s = el('span', undefined, ch);
    if (i) s.style.transitionDelay = `${Math.round(i * step)}ms`;
    b.append(s);
  });
  b.onclick = onClick;
  return b;
}

/** The ESC key of the dialogs, top right: closes without saving. */
export function escButton(onClick: () => void, title = 'Close without saving (Esc)'): HTMLButtonElement {
  const b = keyButton('ESC', 'esc', onClick, 'esc');
  b.title = title;
  b.setAttribute('aria-label', 'Cancel');
  return b;
}

/** Labels that destroy something get the red key: Delete, Discard, Drop changes, Overwrite, Replace, Remove. */
const DESTRUCTIVE = /^(delete|discard|drop|overwrite|replace|remove|disconnect)\b/i;

/** The tone of the primary key for its label: red when it destroys, green otherwise. */
export function primaryTone(label: string): KeyTone {
  return DESTRUCTIVE.test(label) ? 'red' : 'green';
}

/** The primary key of a form: a submit keycap (Enter in a field presses it). */
function submitKey(label: string, className = 'primary'): HTMLButtonElement {
  const b = keyButton(label, primaryTone(label), () => undefined, className);
  b.type = 'submit';
  return b;
}

/** The title row: the heading on the left, the ESC key on the right. */
function head(title: string, dialog: HTMLDialogElement, escTitle = 'Cancel (Esc)'): HTMLDivElement {
  const h = el('div', 'head');
  h.append(el('h2', undefined, title), escButton(() => dialog.close(), escTitle));
  return h;
}

/** Shows a form; resolves with the field values, or undefined when cancelled. */
export function formDialog(title: string, fields: Field[], okLabel = 'OK', note?: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form');
    form.method = 'dialog';
    form.append(head(title, dialog));
    if (note) form.append(el('p', 'note', note));
    const inputs = fields.map((f) => {
      if (f.checkbox) {
        const label = el('label', 'check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = f.value === 'true';
        label.append(box, document.createTextNode(` ${f.label}`));
        form.append(label);
        return box;
      }
      const label = el('label', undefined, f.label);
      const input = el('input');
      input.type = f.password ? 'password' : 'text';
      input.value = f.value ?? '';
      input.placeholder = f.placeholder ?? '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      label.append(input);
      form.append(label);
      return input;
    });
    const buttons = el('div', 'buttons');
    buttons.append(keyButton('Cancel', 'grey', () => dialog.close(), 'cancel'), submitKey(okLabel));
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);

    let result: string[] | undefined;
    form.onsubmit = () => {
      result = inputs.map((i) => (i.type === 'checkbox' ? (i.checked ? 'true' : '') : i.value));
    };
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    // Start in the first empty text field (the password when host and user are known).
    (inputs.find((i) => i.type !== 'checkbox' && !i.value) ?? inputs[0])?.focus();
  });
}

export async function promptDialog(title: string, label: string, options: { password?: boolean; value?: string; note?: string } = {}): Promise<string | undefined> {
  const r = await formDialog(title, [{ label, value: options.value, password: options.password }], 'OK', options.note);
  return r?.[0];
}

export function confirmDialog(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form');
    form.method = 'dialog';
    form.append(head(title, dialog), el('p', undefined, message));
    const buttons = el('div', 'buttons');
    let ok = false;
    const okKey = submitKey(okLabel);
    okKey.value = 'ok';
    buttons.append(keyButton('Cancel', 'grey', () => dialog.close(), 'cancel'), okKey);
    form.append(buttons);
    form.onsubmit = () => {
      ok = true;
    };
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(ok || dialog.returnValue === 'ok');
    };
    dialog.showModal();
    okKey.focus();
  });
}

export function messageDialog(title: string, lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form');
    form.method = 'dialog';
    form.append(head(title, dialog, 'Close (Esc)'));
    for (const l of lines) form.append(el('p', undefined, l));
    const buttons = el('div', 'buttons');
    const ok = keyButton('OK', 'green', () => undefined, 'primary');
    ok.type = 'submit';
    buttons.append(ok);
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve();
    };
    dialog.showModal();
    ok.focus();
  });
}

/** A button of the icon list dialog: `id` comes back as the action, the icon decides the look. */
export interface IconAction {
  id: string;
  /** Tooltip and accessible name. */
  label: string;
  icon: ActionIconName;
  /** Colour on hover: play is green, edit yellow, delete red. */
  tone?: ActionTone;
}

function iconButton(a: IconAction): HTMLButtonElement {
  const b = actionButton(a.icon, a.label, a.tone);
  b.dataset.action = a.id;
  return b;
}

/**
 * A list with icon buttons on each row, a row of icon buttons under the title (what the
 * bottom buttons of listDialog do) and an ESC key in the corner. Resolves with the row
 * index and the action id ({ row: -1 } for a top button), or undefined for Esc.
 */
export function iconListDialog(
  title: string,
  rows: string[],
  rowActions: IconAction[],
  topActions: IconAction[],
  empty = 'Nothing here yet.',
): Promise<{ row: number; action: string } | undefined> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal list-dialog icon-list icon-actions');
    const form = el('form');
    form.method = 'dialog';
    let result: { row: number; action: string } | undefined;
    const pick = (row: number, action: string) => (): void => {
      result = { row, action };
      dialog.close();
    };
    const tools = el('div', 'top-actions');
    for (const a of topActions) {
      const b = iconButton(a);
      b.onclick = pick(-1, a.id);
      tools.append(b);
    }
    const list = el('ul', 'list-rows');
    if (!rows.length) list.append(el('li', 'empty', empty));
    rows.forEach((text, i) => {
      const li = el('li');
      li.append(el('span', 'text', text));
      for (const a of rowActions) {
        const b = iconButton(a);
        b.onclick = pick(i, a.id);
        li.append(b);
      }
      list.append(li);
    });
    form.append(head(title, dialog, 'Close (Esc)'), tools, list);
    // Enter must not submit (and close) the form; the buttons do everything.
    form.onsubmit = (ev) => ev.preventDefault();
    // Focus starts on the form, not on a button: a button focused by script counts as
    // keyboard focus and would open with its hover ring lit. Tab reaches the buttons.
    form.tabIndex = -1;
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    form.focus();
  });
}

/**
 * A list with buttons on each row and along the bottom. Resolves with the row index
 * and the action label ({ row: -1 } for a bottom button), or undefined for Close.
 */
export function listDialog(
  title: string,
  note: string,
  rows: string[],
  rowActions: string[],
  bottomActions: string[],
  empty = 'Nothing here yet.',
): Promise<{ row: number; action: string } | undefined> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal list-dialog');
    const form = el('form');
    form.method = 'dialog';
    form.append(head(title, dialog, 'Close (Esc)'));
    if (note) form.append(el('p', 'note', note));
    let result: { row: number; action: string } | undefined;
    const pick = (row: number, action: string) => (): void => {
      result = { row, action };
      dialog.close();
    };
    const list = el('ul', 'list-rows');
    if (!rows.length) list.append(el('li', 'empty', empty));
    rows.forEach((text, i) => {
      const li = el('li');
      li.append(el('span', 'text', text));
      for (const a of rowActions) li.append(keyButton(a, primaryTone(a) === 'red' ? 'red' : 'grey', pick(i, a), 'small'));
      list.append(li);
    });
    form.append(list);
    const buttons = el('div', 'buttons');
    for (const a of bottomActions) buttons.append(keyButton(a, 'grey', pick(-1, a)));
    const close = keyButton('Close', 'green', () => undefined, 'primary');
    close.type = 'submit';
    buttons.append(close);
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    close.focus();
  });
}

export interface CheckRow {
  label: string;
  detail?: string;
  /** A short mark after the label ("replaces the saved one"). */
  tag?: string;
  /** Starts ticked unless false. */
  checked?: boolean;
}

/** A list of check boxes with All / None; resolves with the indexes ticked, or undefined when cancelled. */
export function checkListDialog(title: string, note: string, rows: CheckRow[], okLabel = 'OK'): Promise<number[] | undefined> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal list-dialog');
    const form = el('form');
    form.method = 'dialog';
    form.append(head(title, dialog));
    if (note) form.append(el('p', 'note', note));
    const list = el('ul', 'list-rows check-rows');
    const boxes: HTMLInputElement[] = [];
    for (const row of rows) {
      const li = el('li');
      const label = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = row.checked !== false;
      boxes.push(box);
      const text = el('span', 'text');
      text.append(el('span', 'label', row.label));
      if (row.tag) text.append(el('span', 'tag', row.tag));
      if (row.detail) text.append(el('span', 'detail', row.detail));
      label.append(box, text);
      li.append(label);
      list.append(li);
    }
    form.append(list);
    const buttons = el('div', 'buttons');
    const setAll = (on: boolean) => (): void => boxes.forEach((b) => (b.checked = on));
    for (const [name, on] of [['All', true], ['None', false]] as const) buttons.append(keyButton(name, 'blue', setAll(on), 'small'));
    const ok = submitKey(okLabel);
    buttons.append(keyButton('Cancel', 'grey', () => dialog.close(), 'cancel'), ok);
    form.append(buttons);
    let result: number[] | undefined;
    form.onsubmit = () => {
      result = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
    };
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    ok.focus();
  });
}

/**
 * A message with a row of keys; resolves with the label pressed, or undefined when the
 * dialog is dismissed (Esc, or the Cancel key it always has). The last button is the
 * primary one.
 */
export function choiceDialog(title: string, lines: string[], buttons: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form');
    form.method = 'dialog';
    form.append(head(title, dialog));
    for (const l of lines) form.append(el('p', undefined, l));
    const row = el('div', 'buttons');
    let result: string | undefined;
    row.append(keyButton('Cancel', 'grey', () => dialog.close(), 'cancel'));
    buttons.forEach((label, i) => {
      const last = i === buttons.length - 1;
      const tone: KeyTone = last ? primaryTone(label) : primaryTone(label) === 'red' ? 'red' : 'blue';
      const b = keyButton(
        label,
        tone,
        () => {
          result = label;
          dialog.close();
        },
        last ? 'primary' : '',
      );
      row.append(b);
    });
    form.append(row);
    form.onsubmit = (ev) => ev.preventDefault();
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    (row.lastElementChild as HTMLButtonElement | null)?.focus();
  });
}
