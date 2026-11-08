import { keyName, type KeyAction } from '../shared/keymap';
import { EDITOR_ACTIONS, actionName, macroProblems, type Macro, type MacroStep } from '../shared/macros';

/**
 * The macro editor: name, the key that runs it, and the steps on a timeline you work
 * like the macro editors of gaming keyboards. One chip per step (a key, a typed text, a
 * delay, a wait); click a chip to change it in the panel below, drag it to move it,
 * Delete to remove it. New steps, delays and a recording go in after the selected chip
 * (at the end when nothing is selected).
 *
 * Delays are not recorded: on a 5250 the host sets the pace, and the recorder already
 * puts a "wait for input" after every key the host answers. A delay is a step the user
 * adds on purpose (Add delay, 0 ms to start, then set it).
 */

export type EditorAction = 'save' | 'run' | 'record';

export interface EditorResult {
  macro: Macro;
  /** Save; save and run it in the active session; or record more steps into it (not saved yet). */
  action: EditorAction;
  /** For 'record': where the recorded steps go (index in macro.steps). */
  insertAt?: number;
}

export interface EditorOptions {
  /** A live session is active: offer Save and run. */
  canRun: boolean;
  /** A live session is active and nothing is recording: offer Record from here. */
  canRecord?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** What Add step offers; a delay has its own button. */
const STEP_KINDS: Array<{ type: MacroStep['type']; label: string; make: () => MacroStep }> = [
  { type: 'text', label: 'Type text', make: () => ({ type: 'text', text: '' }) },
  { type: 'key', label: 'Press a key', make: () => ({ type: 'key', action: 'enter' }) },
  { type: 'waitInput', label: 'Wait for the host to accept input', make: () => ({ type: 'waitInput' }) },
  { type: 'waitText', label: 'Wait for a text on the screen', make: () => ({ type: 'waitText', text: '' }) },
  { type: 'prompt', label: 'Ask for a value and type it', make: () => ({ type: 'prompt', label: '' }) },
];

const KIND_LABELS: Record<MacroStep['type'], string> = {
  text: 'Type text',
  key: 'Press a key',
  wait: 'Delay',
  waitInput: 'Wait for the host to accept input',
  waitText: 'Wait for a text on the screen',
  prompt: 'Ask for a value and type it',
};

const STEP_ICONS: Record<MacroStep['type'], string> = {
  text: 'Aa',
  key: '⌨',
  wait: '⏱',
  waitInput: '⏳',
  waitText: '👁',
  prompt: '?',
};

const excerpt = (s: string, max = 18): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The short text on a chip. */
export function chipLabel(step: MacroStep): string {
  switch (step.type) {
    case 'text':
      return step.text ? `"${excerpt(step.text)}"` : 'text…';
    case 'key':
      return actionName(step.action);
    case 'wait':
      return `${step.ms} ms`;
    case 'waitInput':
      return 'wait for input';
    case 'waitText':
      return step.text ? `until "${excerpt(step.text, 14)}"` : 'until text…';
    case 'prompt':
      return `ask: ${step.label ? excerpt(step.label, 14) : '…'}`;
  }
}

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

/** The fields of one step, for the panel under the timeline. */
function stepFields(step: MacroStep, changed: () => void): HTMLElement {
  const box = el('div', 'fields');
  const note = (text: string): HTMLElement => el('p', 'note', text);
  switch (step.type) {
    case 'text':
      box.append(input(step.text, 'text to type', (v) => (step.text = v)));
      break;
    case 'key':
      box.append(actionSelect(step.action, (a) => (step.action = a)));
      break;
    case 'wait':
      box.append(numberInput(step.ms, (v) => (step.ms = v)), el('span', 'unit', 'ms'));
      box.append(note('A pause before the next step. The host sets the pace through "wait for input"; a delay is for screens that keep drawing after they accept input.'));
      break;
    case 'waitInput':
      box.append(el('span', 'static', 'Goes on when the keyboard is unlocked again. The recorder puts one after every key the host answers.'));
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
        changed();
      };
      hidden.append(c, el('span', undefined, 'hidden (a password)'));
      box.append(hidden);
      break;
    }
  }
  box.addEventListener('input', changed);
  box.addEventListener('change', changed);
  return box;
}

/**
 * Opens the editor on a copy of the macro; resolves with the edited macro and what to do
 * with it, or undefined when cancelled.
 */
export function macroEditorDialog(original: Macro, others: Macro[], options: EditorOptions = { canRun: false }): Promise<EditorResult | undefined> {
  const copy = (m: Macro): Macro => ({ ...m, steps: m.steps.map((s) => ({ ...s })) });
  let macro: Macro = copy(original);
  /** The selected chip; undefined = nothing (new steps go at the end). */
  let selected: number | undefined;
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

    const stepsHead = el('h3', undefined, 'Steps');
    stepsHead.append(el('span', 'hint', 'Click a step to change it, drag it to move it, Delete removes it. New steps go after the selected one.'));
    form.append(stepsHead);

    const timeline = el('ol', 'macro-timeline');
    const panel = el('div', 'step-panel');
    const problems = el('p', 'problems');
    problems.hidden = true;
    let dragFrom: number | undefined;

    const insertAt = (): number => (selected === undefined ? macro.steps.length : Math.min(selected + 1, macro.steps.length));

    const renderPanel = (): void => {
      panel.replaceChildren();
      const step = selected === undefined ? undefined : macro.steps[selected];
      if (!step) {
        panel.append(el('p', 'muted', macro.steps.length ? 'Select a step to change it. New steps go at the end.' : 'No steps yet: add one, add a delay, or record in a session.'));
        return;
      }
      const title = el('div', 'kind');
      title.append(el('span', 'icon', STEP_ICONS[step.type]), el('span', undefined, `Step ${(selected ?? 0) + 1}: ${KIND_LABELS[step.type]}`));
      panel.append(title, stepFields(step, renderTimeline));
    };

    const select = (i: number | undefined): void => {
      selected = i;
      renderTimeline();
      renderPanel();
    };

    const move = (from: number, to: number): void => {
      if (from === to || from < 0 || from >= macro.steps.length || to < 0 || to >= macro.steps.length) return;
      const [moved] = macro.steps.splice(from, 1);
      if (moved) macro.steps.splice(to, 0, moved);
      select(to);
    };

    const removeAt = (i: number): void => {
      macro.steps.splice(i, 1);
      select(macro.steps.length ? Math.min(i, macro.steps.length - 1) : undefined);
    };

    const addStep = (step: MacroStep): void => {
      const at = insertAt();
      macro.steps.splice(at, 0, step);
      select(at);
      panel.querySelector<HTMLElement>('input, select')?.focus();
    };

    function renderTimeline(): void {
      timeline.replaceChildren();
      macro.steps.forEach((step, i) => {
        const li = el('li', `chip ${step.type}${i === selected ? ' selected' : ''}`);
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.dataset.index = String(i);
        li.title = `${KIND_LABELS[step.type]}. Click to change, drag to move, Delete to remove.`;
        li.append(el('span', 'icon', STEP_ICONS[step.type]), el('span', 'label', chipLabel(step)));
        li.addEventListener('click', () => select(i));
        li.addEventListener('keydown', (ev) => {
          if (ev.key === 'Delete' || ev.key === 'Backspace') {
            ev.preventDefault();
            removeAt(i);
          } else if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            select(i);
          } else if (ev.key === 'ArrowLeft' && ev.altKey) {
            ev.preventDefault();
            move(i, i - 1);
          } else if (ev.key === 'ArrowRight' && ev.altKey) {
            ev.preventDefault();
            move(i, i + 1);
          }
        });
        // Drag a chip anywhere on the timeline (Alt+arrows do the same for the keyboard).
        li.draggable = true;
        li.addEventListener('dragstart', (ev) => {
          dragFrom = i;
          li.classList.add('dragging');
          ev.dataTransfer?.setData('text/plain', String(i));
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        });
        li.addEventListener('dragend', () => {
          dragFrom = undefined;
          for (const c of timeline.children) c.classList.remove('dragging', 'drop-before', 'drop-after');
        });
        li.addEventListener('dragover', (ev) => {
          if (dragFrom === undefined) return;
          ev.preventDefault();
          const after = ev.offsetX > li.offsetWidth / 2;
          for (const c of timeline.children) c.classList.remove('drop-before', 'drop-after');
          li.classList.add(after ? 'drop-after' : 'drop-before');
        });
        li.addEventListener('drop', (ev) => {
          if (dragFrom === undefined) return;
          ev.preventDefault();
          const after = ev.offsetX > li.offsetWidth / 2;
          let to = i + (after ? 1 : 0);
          if (dragFrom < to) to -= 1;
          const from = dragFrom;
          dragFrom = undefined;
          move(from, to);
        });
        timeline.append(li);
      });
      // The end marker: select it to put new steps at the end; drop a chip on it to move it last.
      const end = el('li', `chip end${selected === undefined && macro.steps.length ? ' selected' : ''}`, '+');
      end.tabIndex = 0;
      end.setAttribute('role', 'button');
      end.title = 'New steps go at the end';
      end.addEventListener('click', () => select(undefined));
      end.addEventListener('dragover', (ev) => {
        if (dragFrom === undefined) return;
        ev.preventDefault();
        end.classList.add('drop-before');
      });
      end.addEventListener('dragleave', () => end.classList.remove('drop-before'));
      end.addEventListener('drop', (ev) => {
        if (dragFrom === undefined) return;
        ev.preventDefault();
        const from = dragFrom;
        dragFrom = undefined;
        move(from, macro.steps.length - 1);
      });
      timeline.append(end);
    }

    form.append(timeline);

    const tools = el('div', 'step-tools');
    const kind = el('select');
    for (const k of STEP_KINDS) {
      const o = el('option', undefined, k.label);
      o.value = k.type;
      kind.append(o);
    }
    const addButton = el('button', undefined, 'Add step');
    addButton.type = 'button';
    addButton.title = 'Adds the chosen step after the selected one';
    addButton.onclick = () => {
      const k = STEP_KINDS.find((x) => x.type === kind.value);
      if (k) addStep(k.make());
    };
    const delayButton = el('button', 'delay', 'Add delay');
    delayButton.type = 'button';
    delayButton.title = 'Adds a 0 ms pause after the selected step; set it in the panel, drag it where it belongs';
    delayButton.onclick = () => addStep({ type: 'wait', ms: 0 });
    tools.append(kind, addButton, delayButton);
    let result: EditorResult | undefined;
    if (options.canRecord) {
      const rec = el('button', 'record', 'Record from here');
      rec.type = 'button';
      rec.title = 'Closes the editor and records in the active session; what you type and press goes in after the selected step';
      rec.onclick = () => {
        result = { macro, action: 'record', insertAt: insertAt() };
        dialog.close();
      };
      tools.append(rec);
    }
    tools.append(el('span', 'spacer'));
    const left = el('button', undefined, '◀');
    left.type = 'button';
    left.title = 'Move the selected step left';
    left.onclick = () => {
      if (selected !== undefined) move(selected, selected - 1);
    };
    const right = el('button', undefined, '▶');
    right.type = 'button';
    right.title = 'Move the selected step right';
    right.onclick = () => {
      if (selected !== undefined) move(selected, selected + 1);
    };
    const remove = el('button', 'remove', 'Remove');
    remove.type = 'button';
    remove.title = 'Removes the selected step (Delete)';
    remove.onclick = () => {
      if (selected !== undefined) removeAt(selected);
    };
    tools.append(left, right, remove);
    form.append(tools, panel, problems);

    const buttons = el('div', 'buttons');
    const finish = (action: 'save' | 'run'): void => {
      // Steps with nothing in them are a mistake, not a feature.
      macro.steps = macro.steps.filter((s) => !((s.type === 'text' || s.type === 'waitText') && !s.text));
      macro.name = macro.name.trim();
      const found = macroProblems(macro, others);
      if (found.length) {
        problems.textContent = found.join(' ');
        problems.hidden = false;
        if (selected !== undefined && selected >= macro.steps.length) selected = undefined;
        renderTimeline();
        renderPanel();
        return;
      }
      result = { macro, action };
      dialog.close();
    };
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => dialog.close();
    const reset = el('button', undefined, 'Reset');
    reset.type = 'button';
    reset.title = 'Back to the macro as it was when the editor opened';
    reset.onclick = () => {
      macro = copy(original);
      name.value = macro.name;
      showKey();
      problems.hidden = true;
      select(undefined);
    };
    buttons.append(cancel, reset);
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
      if (ev.key === 'Enter' && ev.target instanceof HTMLInputElement && ev.target.type !== 'checkbox' && !ev.target.readOnly) ev.preventDefault();
    };

    renderTimeline();
    renderPanel();
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
