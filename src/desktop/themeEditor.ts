import { escButton, keyButton } from './dialogs';
import { THEME_VARS, isColor, resolveTheme, type Theme, type ThemeBase } from './themes';

/**
 * The theme editor: a full page like the macro editor (ESC key top right, keycap buttons
 * at the bottom), the name and base at the top, then every colour grouped, each with a
 * colour picker and a hex field. Every change is previewed on the window behind at once;
 * ESC or Reset puts the previous look back.
 */

export interface ThemeEditorOptions {
  /** Shows the theme being edited on the app behind the editor. */
  preview(theme: Theme): void;
  /** Puts the look back as it was before the editor opened. */
  revert(): void;
  /** Names already in use (another theme may not take them). */
  taken: string[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A hex the colour input accepts (#rrggbb); other forms fall back to grey so the picker still opens. */
function pickerValue(v: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(v.trim());
  if (m) return `#${m[1]}`;
  const s = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v.trim());
  if (s) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return '#808080';
}

/** Opens the editor on a copy; resolves with the theme to save, or undefined when cancelled. */
export function themeEditorDialog(original: Theme, options: ThemeEditorOptions): Promise<Theme | undefined> {
  const theme: Theme = { name: original.name, base: original.base, vars: { ...original.vars } };
  let result: Theme | undefined;

  return new Promise((resolve) => {
    const dialog = el('dialog', 'modal macro-editor theme-editor');
    const form = el('form');
    form.method = 'dialog';

    const close = escButton(() => dialog.close());

    // --- top: name, base ---
    const top = el('div', 'top');
    const titleBox = el('div', 'title');
    const name = el('input', 'name');
    name.type = 'text';
    name.value = theme.name;
    name.placeholder = 'Theme name';
    name.setAttribute('aria-label', 'Theme name');
    name.spellcheck = false;
    name.addEventListener('input', () => {
      theme.name = name.value;
      problems.hidden = true;
    });
    titleBox.append(name);
    const side = el('div', 'side');
    const baseLabel = el('label', 'option');
    baseLabel.append(el('span', 'caption', 'Base'));
    const base = el('select', 'base');
    for (const [v, label] of [
      ['light', 'Light (system light controls)'],
      ['dark', 'Dark (system dark controls)'],
    ] as const) {
      const o = el('option', undefined, label);
      o.value = v;
      base.append(o);
    }
    base.value = theme.base;
    base.addEventListener('change', () => {
      theme.base = base.value as ThemeBase;
      options.preview(theme);
    });
    baseLabel.append(base);
    side.append(baseLabel);
    top.append(titleBox, side);

    // --- the colours, by group ---
    const stage = el('div', 'stage');
    const groups = new Map<string, HTMLElement>();
    const rows = new Map<string, { picker: HTMLInputElement; hex: HTMLInputElement }>();
    for (const v of THEME_VARS) {
      let g = groups.get(v.group);
      if (!g) {
        g = el('section', 'group');
        g.append(el('h3', undefined, v.group));
        groups.set(v.group, g);
        stage.append(g);
      }
      const row = el('label', 'swatch');
      row.append(el('span', 'label', v.label));
      const picker = el('input', 'picker');
      picker.type = 'color';
      picker.value = pickerValue(theme.vars[v.key] ?? '');
      picker.title = v.key;
      const hex = el('input', 'hex');
      hex.type = 'text';
      hex.value = theme.vars[v.key] ?? '';
      hex.spellcheck = false;
      hex.setAttribute('aria-label', `${v.label} colour`);
      const set = (value: string, fromPicker: boolean): void => {
        if (!isColor(value)) {
          hex.classList.add('bad');
          return;
        }
        hex.classList.remove('bad');
        theme.vars[v.key] = value.trim();
        if (fromPicker) hex.value = value;
        else picker.value = pickerValue(value);
        options.preview(theme);
      };
      picker.addEventListener('input', () => set(picker.value, true));
      hex.addEventListener('input', () => set(hex.value, false));
      row.append(picker, hex);
      g.append(row);
      rows.set(v.key, { picker, hex });
    }

    // --- bottom: problems, Reset, Save ---
    const problems = el('p', 'problems');
    problems.hidden = true;
    const buttons = el('div', 'buttons');
    const reset = keyButton(
      'Reset',
      'grey',
      () => {
        theme.name = original.name;
        theme.base = original.base;
        theme.vars = { ...original.vars };
        name.value = theme.name;
        base.value = theme.base;
        for (const [key, r] of rows) {
          r.hex.value = theme.vars[key] ?? '';
          r.picker.value = pickerValue(r.hex.value);
          r.hex.classList.remove('bad');
        }
        problems.hidden = true;
        options.preview(theme);
      },
      'reset',
    );
    reset.title = 'Back to the theme as it was when the editor opened';
    const save = keyButton(
      'Save',
      'blue',
      () => {
        const trimmed = theme.name.trim();
        const issues: string[] = [];
        if (!trimmed) issues.push('The theme needs a name.');
        if (options.taken.includes(trimmed) && trimmed !== original.name) issues.push(`A theme called "${trimmed}" exists already.`);
        if ([...rows.values()].some((r) => r.hex.classList.contains('bad'))) issues.push('A colour is not valid (use #rrggbb).');
        if (issues.length) {
          problems.textContent = issues.join(' ');
          problems.hidden = false;
          return;
        }
        result = resolveTheme({ ...theme, name: trimmed }).theme;
        dialog.close();
      },
      'primary',
    );
    buttons.append(reset, save);
    const bottom = el('div', 'bottom');
    bottom.append(problems, buttons);

    form.append(close, top, stage, bottom);
    form.onsubmit = (ev) => ev.preventDefault();
    form.onkeydown = (ev) => {
      if (ev.key === 'Enter' && ev.target instanceof HTMLInputElement) ev.preventDefault();
    };
    dialog.append(form);
    document.body.append(dialog);
    dialog.onclose = () => {
      dialog.remove();
      if (!result) options.revert();
      resolve(result);
    };
    dialog.showModal();
    options.preview(theme);
    name.focus();
  });
}
