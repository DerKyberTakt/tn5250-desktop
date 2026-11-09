// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { BUILT_IN, THEME_KEYS, THEME_VARS, applyThemeVars, findTheme, isColor, parseTheme, resolveTheme, themeToJson } from '../../src/desktop/themes';

describe('themes', () => {
  it('every built-in sets every variable, with valid colours', () => {
    expect(BUILT_IN.map((t) => t.name)).toEqual(['Light', 'Dark', 'Midnight', 'Graphite']);
    for (const t of BUILT_IN) {
      for (const key of THEME_KEYS) expect(isColor(t.vars[key] ?? ''), `${t.name} ${key}`).toBe(true);
      expect(Object.keys(t.vars).length).toBe(THEME_VARS.length);
    }
    expect(BUILT_IN[0]?.vars['--chrome-bg']).toBe('#ececec');
    expect(BUILT_IN[1]?.vars['--chrome-bg']).toBe('#2b2b2b');
  });

  it('resolves a partial theme over its base and reports what it fixed', () => {
    const { theme, problems } = resolveTheme({ name: '  Ocean ', base: 'dark', vars: { '--tab-accent': '#00aaff', '--chrome-bg': 'blue-ish', '--nope': '#000' } });
    expect(theme.name).toBe('Ocean');
    expect(theme.vars['--tab-accent']).toBe('#00aaff');
    expect(theme.vars['--chrome-bg']).toBe('#2b2b2b'); // from Dark
    expect(theme.vars['--vscode-foreground']).toBe('#d4d4d4');
    expect(problems).toEqual(['--chrome-bg: "blue-ish" is not a colour', '--nope is not a theme variable']);
    expect(resolveTheme({ vars: {} }).theme).toMatchObject({ name: 'Untitled', base: 'dark' });
    expect(resolveTheme({ base: 'blue' as never, vars: {} }).problems[0]).toContain('not light or dark');
  });

  it('parses a theme file and round-trips through JSON; junk is refused', () => {
    const t = BUILT_IN[2] as (typeof BUILT_IN)[number];
    const back = parseTheme(themeToJson(t));
    expect(back?.theme.vars).toEqual(t.vars);
    expect(back?.problems).toEqual([]);
    expect(parseTheme('not json')).toBeUndefined();
    expect(parseTheme('{"name":"x"}')).toBeUndefined();
    expect(parseTheme('\uFEFF{"name":"bom","base":"light","vars":{}}')?.theme.name).toBe('bom');
  });

  it('applies and clears the variables on a root element', () => {
    const root = document.documentElement;
    applyThemeVars(root, BUILT_IN[2]);
    expect(root.style.getPropertyValue('--tab-accent')).toBe('#5865f2');
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyThemeVars(root, undefined);
    expect(root.style.getPropertyValue('--tab-accent')).toBe('');
  });

  it('finds a theme by name among the files and the built-ins', () => {
    const mine = resolveTheme({ name: 'Mine', base: 'light', vars: {} }).theme;
    expect(findTheme('Mine', [mine])?.base).toBe('light');
    expect(findTheme('Graphite', [mine])?.builtin).toBe(true);
    expect(findTheme(undefined, [mine])).toBeUndefined();
    expect(findTheme('Nope', [mine])).toBeUndefined();
  });
});
