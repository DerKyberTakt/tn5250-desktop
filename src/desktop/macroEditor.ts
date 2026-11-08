import { keyName, type KeyAction } from '../shared/keymap';
import { EDITOR_ACTIONS, actionName, macroProblems, type Macro, type MacroStep } from '../shared/macros';

/**
 * The macro editor: name, the key that runs it, and the steps as a list you can edit,
 * reorder and add to (type text, press a key, wait, wait for input, wait for a text,
 * ask for a value). Modelled on the macro editors of gaming keyboards: one row per
 * step, inline fields, arrows to move, a cross to remove.
 */

export type EditorAction = 'save' | 'run';

export interface EditorResult {
  macro: Macro;
  /** Save, or save and run it in the active session. */
  action: EditorAction;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const STEP_KINDS: Array<{ type: MacroStep['type']; label: string; make: () => MacroStep }> = [
  { type: 'text', label: 'Type text', make: () => ({ type: 'text', text: '' }) },
  { type: 'key', label: 'Press a key', make: () => ({ type: 'key', action: 'enter' }) },
  { type: 'waitInput', label: 'Wait for the host to accept input', make: () => ({ type: 'waitInput' }) },
  { type: 'wait', label: 'Wait (milliseconds)', make: () => ({ type: 'wait', ms: 500 }) },
  { type: 'waitText', label: 'Wait for a text on the screen', make: () => ({ type: 'waitText', text: '' }) },
  { type: 'prompt', label: 'Ask for a value and type it', make: () => ({ type: 'prompt', label: '' }) },
];

const STEP_ICONS: Record<MacroStep['type'], string> = {
  text: 'Aa',
  key: '⌨',
  wait: '⏱',
  waitInput: '⏳',
  waitText: '👁',
  prompt: '?',
};

/** A key a macro may run on: a function key, or a chord with Ctrl, Alt or Meta. */
export function macroKeyFromEvent(ev: KeyboardEvent): string | undefined {
  if (ev.key === 'Control' || ev.key === 'Shift' || ev.key === 'Alt' || ev.key === 'Meta') return undefined;
  const name = keyName({ key: ev.key, code: ev.code, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, meta: ev.metaKey });
  if (/^(Ctrl|Alt|Meta)\+/.test(name) || /^(Shift\+)?F\d{1,2}$/.test(name)) return name;
  return undefined;
}

function input(value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  i.oninput = () => onInput(i.value);
  return i;
}

function numberInput(value: number, onInput: (v: number) => void): HTMLInputElement {
  const i = el('input');
  i.type = 'number';
  i.min = '0';
  i.step = '50';
  i.value = String(value);
  i.oninput = () => onInput(Math.max(0, Number(i.value) || 0));
  return i;
}

function actionSelect(value: KeyAction, onChange: (a: KeyAction) => void): HTMLSelectElement {
  const s = el('select');
  for (const a of EDITOR_ACTIONS) {
    const o = el('option', undefined, actionName(a));
    o.value = a;
    s.append(o);
  }
  s.value = value;
  s.onchange = () => onChange(s.value as KeyAction);
  return s;
}

/** The inline editor of one step. */
function stepFields(step: MacroStep, rerender: () => void): HTMLElement {
  const box = el('span', 'fields');
  switch (step.type) {
    case 'text':
      box.append(input(step.text, 'text to type', (v) => (step.text = v)));
      break;
    case 'key':
      box.append(actionSelect(step.action, (a) => (step.action = a)));
      break;
    case 'wait':
      box.append(numberInput(step.ms, (v) => (step.ms = v)), el('span', 'unit', 'ms'));
      break;
    case 'waitInput':
      box.append(el('span', 'static', 'Wait for the host to accept input'));
      break;
    case 'waitText': {
      box.append(input(step.text, 'text that must appear', (v) => (step.text = v)));
      const t = numberInput(step.timeoutMs ?? 0, (v) => {
        if (v > 0) step.timeoutMs = v;
        else delete step.timeoutMs;
      });
      t.placeholder = 'timeout';
      t.title = 'How long to wait, in ms (0 = the default)';
      box.append(t, el('span', 'unit', 'ms'));
      break;
    }
    case 'prompt': {
      box.append(input(step.label, 'what to ask for', (v) => (step.label = v)));
      const hidden = el('label', 'check');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = step.secret === true;
      c.onchange = () => {
        if (c.checked) step.secret = true;
        else delete step.secret;
        rerender();
      };
      hidden.append(c, el('span', undefined, 'hidden'));
      box.append(hidden);
      break;
    }
  }
  return box;
}

/**
 * Opens the editor on a copy of the macro; resolves with the edited macro and whether to
 * run it, or undefined when cancelled.
 */
export function macroEditorDialog(original: Macro, others: Macro[], options: { canRun: boolean } = { canRun: false }): Promise<EditorResult | undefined> {
  const macro: Macro = { ...original, steps: original.steps.map((s) => ({ ...s })) };
  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal macro-editor');
    const form = el('form');
    form.method = 'dialog';
    form.append(el('h2', undefined, original.name ? `Macro: ${original.name}` : 'New macro'));

    const head = el('div', 'head');
    const nameLabel = el('label', undefined, 'Name');
    const name = input(macro.name, 'what the macro does', (v) => (macro.name = v));
    nameLabel.append(name);
    const keyLabel = el('label', undefined, 'Key');
    const key = el('input');
    key.type = 'text';
    key.readOnly = true;
    key.className = 'keycapture';
    const showKey = (): void => {
      key.value = macro.key || '';
      key.placeholder = 'click, then press a key combination';
    };
    showKey();
    key.onkeydown = (ev) => {
      ev.preventDefault();
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        macro.key = '';
        showKey();
        return;
      }
      if (ev.key === 'Escape') {
        key.blur();
        return;
      }
      const captured = macroKeyFromEvent(ev);
      if (captured) {
        macro.key = captured;
        showKey();
      }
    };
    keyLabel.append(key, el('span', 'hint', 'A function key, or a combination with Ctrl, Alt or Win. The macro key wins over the keyboard map. Backspace clears it.'));
    head.append(nameLabel, keyLabel);
    form.append(head);

    form.append(el('h3', undefined, 'Steps'));
    const list = el('ol', 'macro-steps');
    let dragFrom: number | undefined;
    const problems = el('p', 'problems');
    problems.hidden = true;

    const render = (): void => {
      list.replaceChildren();
      if (!macro.steps.length) list.append(el('li', 'empty', 'No steps yet: add one below, or record a macro in a session.'));
      macro.steps.forEach((step, i) => {
        const li = el('li');
        // Drag a row by its grip to reorder (the arrows do the same for the keyboard).
        li.draggable = true;
        li.ondragstart = (ev) => {
          dragFrom = i;
          li.classList.add('dragging');
          ev.dataTransfer?.setData('text/plain', String(i));
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        };
        li.ondragend = () => {
          dragFrom = undefined;
          for (const row of list.children) row.classList.remove('dragging', 'drop-before', 'drop-after');
        };
        li.ondragover = (ev) => {
          if (dragFrom === undefined) return;
          ev.preventDefault();
          const after = ev.offsetY > li.offsetHeight / 2;
          for (const row of list.children) row.classList.remove('drop-before', 'drop-after');
          li.classList.add(after ? 'drop-after' : 'drop-before');
        };
        li.ondrop = (ev) => {
          if (dragFrom === undefined) return;
          ev.preventDefault();
          const after = ev.offsetY > li.offsetHeight / 2;
          const [moved] = macro.steps.splice(dragFrom, 1);
          let to = i + (after ? 1 : 0);
          if (dragFrom < to) to -= 1;
          if (moved) macro.steps.splice(to, 0, moved);
          dragFrom = undefined;
          render();
        };
        li.append(el('span', 'grip', '⋮⋮'));
        li.append(el('span', 'icon', STEP_ICONS[step.type]));
        li.append(el('span', 'kind', STEP_KINDS.find((k) => k.type === step.type)?.label ?? step.type));
        li.append(stepFields(step, render));
        const tools = el('span', 'tools');
        const up = el('button', undefined, '↑');
        up.type = 'button';
        up.title = 'Move up';
        up.disabled = i === 0;
        up.onclick = () => {
          macro.steps.splice(i - 1, 2, step, macro.steps[i - 1] as MacroStep);
          render();
        };
        const down = el('button', undefined, '↓');
        down.type = 'button';
        down.title = 'Move down';
        down.disabled = i === macro.steps.length - 1;
        down.onclick = () => {
          macro.steps.splice(i, 2, macro.steps[i + 1] as MacroStep, step);
          render();
        };
        const remove = el('button', 'remove', '✕');
        remove.type = 'button';
        remove.title = 'Remove';
        remove.onclick = () => {
          macro.steps.splice(i, 1);
          render();
        };
        tools.append(up, down, remove);
        li.append(tools);
        list.append(li);
      });
    };
    render();
    form.append(list);

    const add = el('div', 'add-step');
    const kind = el('select');
    for (const k of STEP_KINDS) {
      const o = el('option', undefined, k.label);
      o.value = k.type;
      kind.append(o);
    }
    const addButton = el('button', undefined, 'Add step');
    addButton.type = 'button';
    addButton.onclick = () => {
      const k = STEP_KINDS.find((x) => x.type === kind.value);
      if (!k) return;
      macro.steps.push(k.make());
      render();
      const last = list.lastElementChild?.querySelector<HTMLElement>('input, select');
      last?.focus();
    };
    add.append(kind, addButton);
    form.append(add, problems);

    const buttons = el('div', 'buttons');
    let result: EditorResult | undefined;
    const finish = (action: EditorAction): void => {
      // Steps with nothing in them are a mistake, not a feature.
      macro.steps = macro.steps.filter((s) => !((s.type === 'text' || s.type === 'waitText') && !s.text));
      macro.name = macro.name.trim();
      const found = macroProblems(macro, others);
      if (found.length) {
        problems.textContent = found.join(' ');
        problems.hidden = false;
        render();
        return;
      }
      result = { macro, action };
      dialog.close();
    };
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => dialog.close();
    buttons.append(cancel);
    if (options.canRun) {
      const run = el('button', undefined, 'Save and run');
      run.type = 'button';
      run.onclick = () => finish('run');
      buttons.append(run);
    }
    const save = el('button', 'primary', 'Save');
    save.type = 'button';
    save.onclick = () => finish('save');
    buttons.append(save);
    form.append(buttons);
    // Enter in a field must not submit (and close) the form; the buttons do that.
    form.onsubmit = (ev) => ev.preventDefault();
    form.onkeydown = (ev) => {
      if (ev.key === 'Enter' && ev.target instanceof HTMLInputElement && ev.target.type === 'text' && !ev.target.readOnly) ev.preventDefault();
    };

    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    name.focus();
  });
}
