// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { themeEditorDialog } from '../../src/desktop/themeEditor';
import { BUILT_IN, THEME_VARS, type Theme } from '../../src/desktop/themes';

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

const dialog = (): HTMLDialogElement => document.querySelector('dialog.theme-editor') as HTMLDialogElement;
const button = (label: string): HTMLButtonElement => [...dialog().querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const hexOf = (key: string): HTMLInputElement => (dialog().querySelector(`input.picker[title="${key}"]`) as HTMLInputElement).nextElementSibling as HTMLInputElement;

describe('theme editor', () => {
  it('shows every variable grouped, previews each change, and saves a resolved theme', async () => {
    const preview = vi.fn<(t: Theme) => void>();
    const revert = vi.fn();
    const p = themeEditorDialog({ ...(BUILT_IN[1] as Theme), name: 'Dark (copy)', builtin: false }, { preview, revert, taken: ['Light', 'Dark'] });
    expect(dialog().querySelectorAll('.swatch')).toHaveLength(THEME_VARS.length);
    expect([...dialog().querySelectorAll('.group h3')].map((h) => h.textContent)).toEqual(['Window chrome', 'Tabs and status', 'Keycap buttons', 'Macro editor', 'Pages (settings, IFS, SQL)', 'Controls', 'Lists and hints']);
    expect(preview).toHaveBeenCalledTimes(1); // the opening preview
    const accent = hexOf('--tab-accent');
    accent.value = '#ff8800';
    accent.dispatchEvent(new Event('input'));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ vars: expect.objectContaining({ '--tab-accent': '#ff8800' }) }));
    expect((accent.previousElementSibling as HTMLInputElement).value).toBe('#ff8800');
    // A bad value is marked and not applied.
    accent.value = 'orange-ish';
    accent.dispatchEvent(new Event('input'));
    expect(accent.classList.contains('bad')).toBe(true);
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toContain('not valid');
    accent.value = '#ff8800';
    accent.dispatchEvent(new Event('input'));
    (dialog().querySelector('input.name') as HTMLInputElement).value = 'Sunset';
    dialog().querySelector('input.name')?.dispatchEvent(new Event('input'));
    button('Save').click();
    const result = await p;
    expect(result?.name).toBe('Sunset');
    expect(result?.vars['--tab-accent']).toBe('#ff8800');
    expect(result?.vars['--chrome-bg']).toBe('#2b2b2b');
    expect(revert).not.toHaveBeenCalled();
  });

  it('refuses a taken name; ESC reverts the preview and resolves undefined', async () => {
    const preview = vi.fn();
    const revert = vi.fn();
    const p = themeEditorDialog({ ...(BUILT_IN[0] as Theme), name: 'Mine', builtin: false }, { preview, revert, taken: ['Light', 'Other'] });
    (dialog().querySelector('input.name') as HTMLInputElement).value = 'Other';
    dialog().querySelector('input.name')?.dispatchEvent(new Event('input'));
    button('Save').click();
    expect(dialog().querySelector('.problems')?.textContent).toContain('exists already');
    (dialog().querySelector('button.esc') as HTMLButtonElement).click();
    expect(await p).toBeUndefined();
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('Reset puts the opening values back and previews them', () => {
    const preview = vi.fn<(t: Theme) => void>();
    void themeEditorDialog({ ...(BUILT_IN[0] as Theme), builtin: false }, { preview, revert: vi.fn(), taken: [] });
    const bg = hexOf('--chrome-bg');
    bg.value = '#123456';
    bg.dispatchEvent(new Event('input'));
    button('Reset').click();
    expect(bg.value).toBe('#ececec');
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ vars: expect.objectContaining({ '--chrome-bg': '#ececec' }) }));
  });
});
