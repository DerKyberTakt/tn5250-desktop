/** Small modal dialogs drawn by the shell (the OS dialogs only cover files). */

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
}

/** Shows a form; resolves with the field values, or undefined when cancelled. */
export function formDialog(title: string, fields: Field[], okLabel = 'OK', note?: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form');
    form.method = 'dialog';
    form.append(el('h2', undefined, title));
    if (note) form.append(el('p', 'note', note));
    const inputs = fields.map((f) => {
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
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    const ok = el('button', 'primary', okLabel);
    ok.type = 'submit';
    buttons.append(cancel, ok);
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);

    let result: string[] | undefined;
    cancel.onclick = () => dialog.close();
    form.onsubmit = () => {
      result = inputs.map((i) => i.value);
    };
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    inputs[0]?.focus();
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
    form.append(el('h2', undefined, title), el('p', undefined, message));
    const buttons = el('div', 'buttons');
    const cancel = el('button', undefined, 'Cancel');
    cancel.value = 'cancel';
    const ok = el('button', 'primary', okLabel);
    ok.value = 'ok';
    buttons.append(cancel, ok);
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok');
    };
    dialog.showModal();
    ok.focus();
  });
}

export function messageDialog(title: string, lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal');
    const form = el('form');
    form.method = 'dialog';
    form.append(el('h2', undefined, title));
    for (const l of lines) form.append(el('p', undefined, l));
    const buttons = el('div', 'buttons');
    buttons.append(el('button', 'primary', 'OK'));
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve();
    };
    dialog.showModal();
  });
}
