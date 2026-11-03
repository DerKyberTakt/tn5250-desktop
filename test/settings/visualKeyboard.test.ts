import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP, keyName } from '../../src/shared/keymap';
import { MAIN_ROWS, NAV_ROWS, NUMPAD_ROWS, bindingsForCode, chordName, keyFromCode, keyTokens, nameUsesCode } from '../../src/settings/visualKeyboard';

describe('visual keyboard', () => {
  it('names clicked chords exactly as typed ones', () => {
    expect(chordName({ mods: new Set(['ControlLeft']), main: 'KeyE' })).toBe('Ctrl+E');
    expect(chordName({ mods: new Set(['ControlLeft', 'ShiftLeft']), main: 'KeyE' })).toBe(keyName({ key: 'E', code: 'KeyE', ctrl: true, shift: true, alt: false, meta: false }));
    expect(chordName({ mods: new Set(['ShiftLeft']), main: 'F9' })).toBe('Shift+F9');
    expect(chordName({ mods: new Set(['ShiftLeft']), main: 'Digit1' })).toBe('!');
    expect(chordName({ mods: new Set(), main: 'NumpadAdd' })).toBe('NumpadAdd');
    expect(chordName({ mods: new Set(), main: 'Numpad7' })).toBe('Numpad7');
    expect(chordName({ mods: new Set(), main: 'NumpadEnter' })).toBe('NumpadEnter');
    expect(chordName({ mods: new Set(['AltLeft']), main: 'ArrowLeft' })).toBe('Alt+ArrowLeft');
    expect(chordName({ mods: new Set(), main: 'Space' })).toBe('Space');
  });

  it('names a latched modifier on its own', () => {
    expect(chordName({ mods: new Set(['ControlRight']) })).toBe('ControlRight');
    expect(chordName({ mods: new Set() })).toBeUndefined();
  });

  it('knows what every key cap produces', () => {
    for (const row of [...MAIN_ROWS, ...NAV_ROWS, ...NUMPAD_ROWS]) for (const cap of row) if (cap) expect(keyFromCode(cap.code)).toBeTruthy();
    expect(keyFromCode('KeyA')).toBe('A');
    expect(keyFromCode('Digit1', true)).toBe('!');
  });

  it('filters bindings by key cap, not by substring', () => {
    expect(keyTokens('Ctrl+Shift+F1')).toEqual(['Ctrl', 'Shift', 'F1']);
    expect(nameUsesCode('Shift+F1', 'F1')).toBe(true);
    expect(nameUsesCode('F12', 'F1')).toBe(false);
    expect(nameUsesCode('Ctrl+C', 'KeyC')).toBe(true);
    expect(nameUsesCode('Ctrl+C', 'ControlLeft')).toBe(true);
    expect(nameUsesCode('ControlRight', 'ControlRight')).toBe(true);
    expect(nameUsesCode('Ctrl+1', 'Digit1')).toBe(true);
    expect(nameUsesCode('NumpadAdd', 'NumpadAdd')).toBe(true);
    expect(nameUsesCode('Enter', 'NumpadEnter')).toBe(false);
    expect(bindingsForCode(ACS_KEYMAP, 'ControlRight')).toContain('ControlRight → enter');
    expect(bindingsForCode(ACS_KEYMAP, 'ControlRight')).toContain('Ctrl+C → copy');
    expect(bindingsForCode(ACS_KEYMAP, 'NumpadEnter')).toEqual(['NumpadEnter → fieldExit']);
    expect(bindingsForCode(ACS_KEYMAP, 'F3')).toContain('F3 → pf3');
  });
});
