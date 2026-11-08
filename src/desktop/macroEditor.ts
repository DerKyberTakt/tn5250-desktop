import { keyName, type KeyAction } from '../shared/keymap';
import { EDITOR_ACTIONS, actionName, macroProblems, type Macro, type MacroStep } from '../shared/macros';

/**
 * The macro editor, modelled on the macro editors of gaming keyboards (Logitech G HUB):
 * a full-screen dark page, the name as the title, the steps on one timeline, one chip per
 * step. Keys are red keycaps, typed text a grey tile, a delay an underlined number with
 * its unit below. Click a chip to change it in place (a delay or a text becomes a field,
 * a key a list, a wait-for-text or a prompt a small card under the chip), drag it to move
 * it, Delete removes it. The + tile at the end (and the right-click menu of a chip) adds
 * a step after the selected chip, or at the end when nothing is selected.
 *
 * Delays are not recorded: on a 5250 the host sets the pace, and the recorder already
 * puts a "wait for input" after every key the host answers. A delay is a step the user
 * adds on purpose (0 ms to start, then set it).
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

/** What the + menu offers, in this order. */
export const STEP_KINDS: Array<{ type: MacroStep['type']; label: string; make: () => MacroStep }> = [
  { type: 'key', label: 'Key', make: () => ({ type: 'key', action: 'enter' }) },
  { type: 'text', label: 'Text', make: () => ({ type: 'text', text: '' }) },
  { type: 'wait', label: 'Delay', make: () => ({ type: 'wait', ms: 0 }) },
  { type: 'waitInput', label: 'Wait for input', make: () => ({ type: 'waitInput' }) },
  { type: 'waitText', label: 'Wait for a text on the screen', make: () => ({ type: 'waitText', text: '' }) },
  { type: 'prompt', label: 'Ask for a value', make: () => ({ type: 'prompt', label: '' }) },
];

const KIND_LABELS: Record<MacroStep['type'], string> = {
  text: 'Type text',
  key: 'Press a key',
  wait: 'Delay',
  waitInput: 'Wait for the host to accept input',
  waitText: 'Wait for a text on the screen',
  prompt: 'Ask for a value and type it',
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

function textInput(value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
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
  s.onchange = () => {
    if ((EDITOR_ACTIONS as string[]).includes(s.value)) onChange(s.value as KeyAction);
  };
  return s;
}

/** The fields of a step that needs a card under its chip (more than one thing to set). */
function cardFields(step: MacroStep, changed: () => void): HTMLElement {
  const box = el('div', 'fields');
  switch (step.type) {
    case 'waitText': {
      box.append(textInput(step.text, 'text that must appear', (v) => (step.text = v)));
      const t = numberInput(step.timeoutMs ?? 0, (v) => {
        if (v > 0) step.timeoutMs = v;
        else delete step.timeoutMs;
      });
      t.placeholder = 'timeout';
      t.title = 'How long to wait, in ms (0 = the default)';
      box.append(el('span', 'unit', 'for up to'), t, el('span', 'unit', 'ms'));
      break;
    }
    case 'prompt': {
      box.append(textInput(step.label, 'what to ask for', (v) => (step.label = v)));
      const hidden = el('label', 'check');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = step.secret === true;
      c.onchange = () => {
        if (c.checked) step.secret = true;
        else delete step.secret;
      };
      hidden.append(c, el('span', undefined, 'hidden (a password)'));
      box.append(hidden);
      break;
    }
    default:
      break;
  }
  box.addEventListener('input', changed);
  box.addEventListener('change', changed);
  return box;
}

/** Steps that get a card under the chip; the others edit inline or have nothing to set. */
const CARD_TYPES = new Set<MacroStep['type']>(['waitText', 'prompt']);

/**
 * Opens the editor on a copy of the macro; resolves with the edited macro and what to do
 * with it, or undefined when cancelled.
 */
export function macroEditorDialog(original: Macro, others: Macro[], options: EditorOptions = { canRun: false }): Promise<EditorResult | undefined> {
  const copy = (m: Macro): Macro => ({ ...m, steps: m.steps.map((s) => ({ ...s })) });
  let macro: Macro = copy(original);
  /** The selected chip; undefined = the end (new steps go at the end). */
  let selected: number | undefined;
  /** The chip being changed in place, if any. */
  let editing: number | undefined;
  /** Where the + menu is open: under a chip, under the end tile, or closed. */
  let menuAt: number | 'end' | undefined;
  let dragFrom: number | undefined;
  let result: EditorResult | undefined;

  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal macro-editor');
    const form = el('form');
    form.method = 'dialog';

    // --- top: close, name, shortcut key ---
    const close = el('button', 'close', '✕');
    close.type = 'button';
    close.title = 'Close without saving (Esc)';
    close.setAttribute('aria-label', 'Cancel');
    close.onclick = () => dialog.close();

    const top = el('div', 'top');
    const titleBox = el('div', 'title');
    const name = textInput(macro.name, 'Macro name', (v) => (macro.name = v));
    name.className = 'name';
    name.setAttribute('aria-label', 'Macro name');
    titleBox.append(name);

    const side = el('div', 'side');
    const keyLabel = el('label', 'option');
    const caption = el('span', 'caption', 'Shortcut key');
    const info = el('span', 'info');
    info.tabIndex = 0;
    info.setAttribute('role', 'img');
    info.setAttribute('aria-label', 'About the shortcut key');
    info.setAttribute('aria-describedby', 'macro-key-tip');
    info.append(el('span', 'glyph', 'i'));
    const tip = el('span', 'tip', 'Launch the macro with a key combination: Ctrl, Alt or Win/Command/Super with a key, or a function key. Macro keybinds are checked before the terminal keybinds. Backspace in the field removes it.');
    tip.id = 'macro-key-tip';
    tip.setAttribute('role', 'tooltip');
    info.append(tip);
    caption.append(info);
    keyLabel.append(caption);
    const keybar = el('div', 'keybar');
    const key = el('input');
    key.type = 'text';
    key.readOnly = true;
    key.className = 'keycapture';
    const clearKey = el('button', 'clear');
    clearKey.type = 'button';
    clearKey.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    clearKey.title = 'Remove the shortcut key';
    clearKey.setAttribute('aria-label', 'Remove the shortcut key');
    const showKey = (): void => {
      key.value = macro.key || '';
      key.placeholder = 'e.g. Ctrl+R';
      clearKey.hidden = !macro.key;
    };
    clearKey.onclick = () => {
      macro.key = '';
      showKey();
      key.focus();
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
    keybar.append(key, clearKey);
    keyLabel.append(keybar);
    side.append(keyLabel);
    top.append(titleBox, side);

    // --- middle: the timeline ---
    const stage = el('div', 'stage');
    const timeline = el('ol', 'macro-timeline');
    stage.append(timeline);

    // --- bottom: problems and buttons ---
    const problems = el('p', 'problems');
    problems.hidden = true;

    const insertAt = (): number => (selected === undefined ? macro.steps.length : Math.min(selected + 1, macro.steps.length));

    const render = (): void => renderTimeline();

    const select = (i: number | undefined): void => {
      selected = i;
      editing = undefined;
      menuAt = undefined;
      render();
    };

    const focusChip = (i: number | undefined): void => {
      const target = i === undefined ? timeline.querySelector<HTMLElement>('li.chip.end') : timeline.querySelector<HTMLElement>(`li.chip[data-index="${i}"]`);
      target?.focus();
    };

    const move = (from: number, to: number): void => {
      if (from === to || from < 0 || from >= macro.steps.length || to < 0 || to >= macro.steps.length) return;
      const [moved] = macro.steps.splice(from, 1);
      if (moved) macro.steps.splice(to, 0, moved);
      select(to);
      focusChip(to);
    };

    const removeAt = (i: number): void => {
      macro.steps.splice(i, 1);
      const next = macro.steps.length ? Math.min(i, macro.steps.length - 1) : undefined;
      select(next);
      focusChip(next);
    };

    const addStep = (step: MacroStep): void => {
      const at = insertAt();
      macro.steps.splice(at, 0, step);
      selected = at;
      menuAt = undefined;
      // A new chip opens for editing straight away, unless there is nothing to set.
      editing = step.type === 'waitInput' ? undefined : at;
      render();
      if (editing === undefined) focusChip(at);
    };

    const startEdit = (i: number): void => {
      if (macro.steps[i]?.type === 'waitInput') return;
      selected = i;
      editing = i;
      menuAt = undefined;
      render();
    };

    const endEdit = (): void => {
      if (editing === undefined) return;
      const i = editing;
      editing = undefined;
      render();
      focusChip(i);
    };

    const recordFromHere = (): void => {
      result = { macro, action: 'record', insertAt: insertAt() };
      dialog.close();
    };

    // Clicking outside an open card or menu closes it.
    const outside = (ev: MouseEvent): void => {
      if (editing === undefined && menuAt === undefined) return;
      const t = ev.target as Node | null;
      if (t && (timeline.querySelector('.card')?.contains(t) || timeline.querySelector('.add-menu')?.contains(t) || timeline.querySelector('.inline')?.contains(t))) return;
      if (editing !== undefined && t && timeline.querySelector(`li.chip[data-index="${editing}"]`)?.contains(t)) return;
      editing = undefined;
      menuAt = undefined;
      render();
    };
    document.addEventListener('mousedown', outside, true);

    /** The + menu under a chip (or the end tile): the step kinds, Record from here, Remove. */
    const addMenu = (at: number | 'end'): HTMLElement => {
      const menu = el('ul', 'add-menu');
      menu.setAttribute('role', 'menu');
      const item = (label: string, cls: string, onClick: () => void): void => {
        const li = el('li');
        const b = el('button', cls, label);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.onclick = (ev) => {
          ev.stopPropagation();
          onClick();
        };
        li.append(b);
        menu.append(li);
      };
      for (const k of STEP_KINDS) item(k.label, `kind ${k.type}`, () => addStep(k.make()));
      if (options.canRecord) item('Record from here', 'record', recordFromHere);
      if (at !== 'end') item('Remove', 'remove', () => removeAt(at));
      return menu;
    };

    /** The editor that replaces a chip's label while it is being changed. */
    const inlineEditor = (step: MacroStep, i: number): HTMLElement[] => {
      const finishKeys = (field: HTMLElement, revert: () => void): void => {
        field.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === 'Tab') {
            ev.preventDefault();
            endEdit();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            revert();
            endEdit();
          }
          ev.stopPropagation();
        });
        field.addEventListener('blur', () => {
          // A blur because the whole chip was redrawn is not the user leaving the field.
          if (editing === i) endEdit();
        });
      };
      switch (step.type) {
        case 'text': {
          const was = step.text;
          const f = textInput(step.text, 'text to type', (v) => {
            step.text = v;
            f.size = Math.max(6, v.length + 1);
          });
          f.className = 'inline';
          f.size = Math.max(6, step.text.length + 1);
          finishKeys(f, () => (step.text = was));
          return [f];
        }
        case 'wait': {
          const was = step.ms;
          const f = numberInput(step.ms, (v) => (step.ms = v));
          f.className = 'inline num';
          finishKeys(f, () => (step.ms = was));
          return [f, el('span', 'unit', 'ms')];
        }
        case 'key': {
          const was = step.action;
          const s = actionSelect(step.action, (a) => {
            step.action = a;
            endEdit();
          });
          s.className = 'inline';
          finishKeys(s, () => (step.action = was));
          return [s];
        }
        default:
          return [];
      }
    };

    /** The step each chip shows, to slide chips from where they were to where they go. */
    const stepOf = new WeakMap<Element, MacroStep>();
    const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    /** Moves the dragged step while the drag is still going: the other chips shuffle out of the way. */
    const liveMove = (to: number): void => {
      if (dragFrom === undefined || to === dragFrom || to < 0 || to >= macro.steps.length) return;
      const [moved] = macro.steps.splice(dragFrom, 1);
      if (moved) macro.steps.splice(to, 0, moved);
      dragFrom = to;
      selected = to;
      render();
    };

    /** The grab: where in the chip the pointer took hold, where the pointer is, the chip's resting place. */
    let grab: { dx: number; dy: number; x: number; y: number; base?: DOMRect } | undefined;
    /** A click right after a drag is the drag's release, not a click. */
    let swallowClick = false;

    /** Keeps the dragged chip under the pointer (its resting place is where the layout put it). */
    const followPointer = (): void => {
      if (dragFrom === undefined || !grab) return;
      const li = timeline.querySelector<HTMLElement>(`li.chip[data-index="${dragFrom}"]`);
      if (!li) return;
      if (!grab.base) {
        li.style.transform = '';
        grab.base = li.getBoundingClientRect();
      }
      li.style.transition = 'none';
      li.style.transform = `translate(${grab.x - grab.dx - grab.base.left}px, ${grab.y - grab.dy - grab.base.top}px)`;
    };

    /** The place the pointer is over: before or after the chip under it, or last over the + tile. */
    const dropTargetAt = (x: number, y: number): number | undefined => {
      for (const li of timeline.querySelectorAll<HTMLElement>('li.chip')) {
        const idx = li.dataset.index === undefined ? undefined : Number(li.dataset.index);
        if (idx === dragFrom) continue;
        // Layout positions, not the animated ones (transforms are left out of offset*).
        const r = timeline.getBoundingClientRect();
        const left = r.left + li.offsetLeft - timeline.offsetLeft;
        const top = r.top + li.offsetTop - timeline.offsetTop;
        if (y < top || y > top + li.offsetHeight || x < left || x > left + li.offsetWidth) continue;
        if (idx === undefined) return macro.steps.length - 1; // the + tile
        let to = x < left + li.offsetWidth / 2 ? idx : idx + 1;
        if (dragFrom !== undefined && dragFrom < to) to -= 1;
        return to;
      }
      return undefined;
    };

    const onPointerMove = (ev: PointerEvent): void => {
      if (!grab) return;
      grab.x = ev.clientX;
      grab.y = ev.clientY;
      if (dragFrom === undefined) return;
      ev.preventDefault();
      const to = dropTargetAt(ev.clientX, ev.clientY);
      if (to !== undefined && to !== dragFrom) {
        grab.base = undefined;
        liveMove(to);
      }
      followPointer();
    };

    const endDrag = (): void => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      dialog.classList.remove('dragging-chip');
      const was = dragFrom;
      grab = undefined;
      dragFrom = undefined;
      if (was !== undefined) {
        swallowClick = true;
        render(); // slides the chip from under the pointer into its slot
        focusChip(was);
      }
    };

    /** pointerdown on a chip: a drag starts once the pointer has moved a few pixels. */
    const armDrag = (ev: PointerEvent, i: number): void => {
      if (ev.button !== 0 || editing === i) return;
      if (ev.target instanceof HTMLElement && ev.target.closest('.card, .add-menu, .inline')) return;
      const li = ev.currentTarget as HTMLElement;
      const rect = li.getBoundingClientRect();
      const start = { x: ev.clientX, y: ev.clientY };
      const begin = (mv: PointerEvent): void => {
        if (Math.abs(mv.clientX - start.x) < 4 && Math.abs(mv.clientY - start.y) < 4) return;
        document.removeEventListener('pointermove', begin);
        document.removeEventListener('pointerup', cancel);
        dragFrom = i;
        editing = undefined;
        menuAt = undefined;
        selected = i;
        grab = { dx: start.x - rect.left, dy: start.y - rect.top, x: mv.clientX, y: mv.clientY };
        dialog.classList.add('dragging-chip');
        render();
        followPointer();
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', endDrag);
        document.addEventListener('pointercancel', endDrag);
      };
      const cancel = (): void => {
        document.removeEventListener('pointermove', begin);
        document.removeEventListener('pointerup', cancel);
      };
      document.addEventListener('pointermove', begin);
      document.addEventListener('pointerup', cancel);
    };

    function renderTimeline(): void {
      // FLIP: remember where every chip is, redraw, then slide each from its old place to the new one.
      const before = new Map<MacroStep, DOMRect>();
      for (const old of timeline.querySelectorAll('li.chip[data-index]')) {
        const st = stepOf.get(old);
        if (st) before.set(st, old.getBoundingClientRect());
      }
      timeline.replaceChildren();
      macro.steps.forEach((step, i) => {
        if (i > 0) {
          const arrow = el('li', 'arrow', '→');
          arrow.setAttribute('aria-hidden', 'true');
          timeline.append(arrow);
        }
        const li = el('li', `chip ${step.type}${i === selected ? ' selected' : ''}${i === editing ? ' editing' : ''}${menuAt === i ? ' menu-open' : ''}${dragFrom === i ? ' dragging' : ''}`);
        stepOf.set(li, step);
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.dataset.index = String(i);
        li.title = `${KIND_LABELS[step.type]}: ${chipLabel(step)}. Click to change, drag to move, Delete to remove, right-click for more.`;
        const label = el('span', 'label', step.type === 'wait' ? String(step.ms) : chipLabel(step));
        if (i === editing && !CARD_TYPES.has(step.type)) {
          li.append(...inlineEditor(step, i));
        } else {
          li.append(label);
          if (step.type === 'wait') li.append(el('span', 'unit', 'ms'));
        }
        if (i === editing && CARD_TYPES.has(step.type)) {
          const card = el('div', 'card');
          card.append(el('div', 'kind', KIND_LABELS[step.type]), cardFields(step, () => (label.textContent = chipLabel(step))));
          const done = el('button', 'primary small', 'Done');
          done.type = 'button';
          done.onclick = (ev) => {
            ev.stopPropagation();
            endEdit();
          };
          card.append(done);
          card.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' || (ev.key === 'Enter' && ev.target instanceof HTMLInputElement && ev.target.type !== 'checkbox')) {
              ev.preventDefault();
              ev.stopPropagation();
              endEdit();
            }
          });
          li.append(card);
        }
        if (menuAt === i) li.append(addMenu(i));
        li.addEventListener('click', (ev) => {
          if (swallowClick) {
            swallowClick = false;
            return;
          }
          if (ev.target instanceof HTMLElement && ev.target.closest('.card, .add-menu, .inline')) return;
          if (editing === i) return;
          if (step.type === 'waitInput') select(i);
          else startEdit(i);
        });
        li.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          selected = i;
          editing = undefined;
          menuAt = i;
          render();
        });
        li.addEventListener('keydown', (ev) => {
          if (ev.target !== li) return;
          if (ev.key === 'Delete' || ev.key === 'Backspace') {
            ev.preventDefault();
            removeAt(i);
          } else if (ev.key === 'Enter' || ev.key === 'F2') {
            ev.preventDefault();
            startEdit(i);
          } else if (ev.key === ' ') {
            ev.preventDefault();
            select(i);
          } else if (ev.key === 'ArrowLeft' && ev.altKey) {
            ev.preventDefault();
            move(i, i - 1);
          } else if (ev.key === 'ArrowRight' && ev.altKey) {
            ev.preventDefault();
            move(i, i + 1);
          } else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
            ev.preventDefault();
            selected = i;
            menuAt = i;
            render();
          }
        });
        // Drag a chip anywhere on the timeline with the pointer: the others shuffle aside as
        // you go (Alt+arrows do the same for the keyboard). Not the browser's drag-and-drop:
        // that one flashes its own cursors while the row is redrawn.
        li.addEventListener('pointerdown', (ev) => armDrag(ev, i));
        timeline.append(li);
      });
      // The + tile: adds after the selected chip (at the end when nothing is selected);
      // drag a chip over it to make it the last one.
      const end = el('li', `chip end${selected === undefined && macro.steps.length ? ' selected' : ''}${menuAt === 'end' ? ' open' : ''}`);
      end.tabIndex = 0;
      end.setAttribute('role', 'button');
      end.setAttribute('aria-label', 'Add a step');
      end.title = selected === undefined ? 'Add a step at the end' : `Add a step after step ${selected + 1} (click the + with nothing selected to add at the end)`;
      end.append(el('span', 'label', '+'));
      if (menuAt === 'end') end.append(addMenu('end'));
      end.addEventListener('click', (ev) => {
        if (ev.target instanceof HTMLElement && ev.target.closest('.add-menu')) return;
        editing = undefined;
        menuAt = menuAt === 'end' ? undefined : 'end';
        render();
        if (menuAt === 'end') timeline.querySelector<HTMLElement>('.add-menu button')?.focus();
      });
      end.addEventListener('keydown', (ev) => {
        if (ev.target !== end) return;
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          end.click();
        } else if (ev.key === 'Escape' && menuAt === 'end') {
          ev.preventDefault();
          ev.stopPropagation();
          menuAt = undefined;
          render();
          focusChip(undefined);
        }
      });
      timeline.append(end);
      if (!macro.steps.length) timeline.append(el('li', 'empty', 'No steps yet. Press + to add one, or record in a session.'));
      // A menu that was just opened on a chip gets the keyboard.
      if (typeof menuAt === 'number') timeline.querySelector<HTMLElement>('.add-menu button')?.focus();
      // An inline field that was just opened gets the keyboard and its text selected.
      if (editing !== undefined) {
        const f = timeline.querySelector<HTMLInputElement | HTMLSelectElement>('.inline, .card input');
        f?.focus();
        if (f instanceof HTMLInputElement && f.type === 'text') f.select();
      }
      // Slide every chip that changed place from where it was (the shuffle). The dragged one
      // stays under the pointer instead.
      if (before.size && !reducedMotion()) {
        for (const li of timeline.querySelectorAll<HTMLElement>('li.chip[data-index]')) {
          if (Number(li.dataset.index) === dragFrom) continue;
          const st = stepOf.get(li);
          const from = st && before.get(st);
          if (!from) continue;
          const now = li.getBoundingClientRect();
          const dx = from.left - now.left;
          const dy = from.top - now.top;
          if (!dx && !dy) continue;
          li.style.transition = 'none';
          li.style.transform = `translate(${dx}px, ${dy}px)`;
          requestAnimationFrame(() => {
            li.style.transition = 'transform 180ms ease';
            li.style.transform = '';
            li.addEventListener('transitionend', () => (li.style.transition = ''), { once: true });
          });
        }
      }
    }
    const buttons = el('div', 'buttons');
    const finish = (action: 'save' | 'run'): void => {
      // Steps with nothing in them are a mistake, not a feature.
      macro.steps = macro.steps.filter((s) => !((s.type === 'text' || s.type === 'waitText') && !s.text));
      macro.name = macro.name.trim();
      name.value = macro.name;
      const found = macroProblems(macro, others);
      if (found.length) {
        problems.textContent = found.join(' ');
        problems.hidden = false;
        if (selected !== undefined && selected >= macro.steps.length) selected = undefined;
        editing = undefined;
        menuAt = undefined;
        render();
        return;
      }
      result = { macro, action };
      dialog.close();
    };
    const reset = el('button', 'reset', 'Reset');
    reset.type = 'button';
    reset.title = 'Back to the macro as it was when the editor opened';
    reset.onclick = () => {
      macro = copy(original);
      name.value = macro.name;
      showKey();
      problems.hidden = true;
      select(undefined);
    };
    buttons.append(reset);
    if (options.canRun) {
      const run = el('button', 'run', 'Save and run');
      run.type = 'button';
      run.onclick = () => finish('run');
      buttons.append(run);
    }
    const save = el('button', 'primary', 'Save');
    save.type = 'button';
    save.onclick = () => finish('save');
    buttons.append(save);

    const bottom = el('div', 'bottom');
    bottom.append(problems, buttons);
    form.append(close, top, stage, bottom);

    // Enter in a field must not submit (and close) the form; the buttons do that.
    form.onsubmit = (ev) => ev.preventDefault();
    form.onkeydown = (ev) => {
      if (ev.key === 'Enter' && ev.target instanceof HTMLInputElement && ev.target.type !== 'checkbox' && !ev.target.readOnly) ev.preventDefault();
    };
    // Esc closes an open card or menu first, the editor second.
    dialog.addEventListener('cancel', (ev) => {
      if (editing !== undefined || menuAt !== undefined) {
        ev.preventDefault();
        const i = editing ?? (typeof menuAt === 'number' ? menuAt : undefined);
        editing = undefined;
        menuAt = undefined;
        render();
        focusChip(i);
      }
    });

    render();
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      document.removeEventListener('mousedown', outside, true);
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    name.focus();
  });
}
