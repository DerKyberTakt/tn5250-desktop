import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP, keyName } from '../../src/shared/keymap';
import { MAIN_ROWS, NAV_ROWS, NUMPAD_ROWS, bindingsForCode, blockWidth, chordName, isLatched, keyFromCode, keyTokens, mergePhysical, nameUsesCode, primaryAcsKey, toggleCap, typesText } from '../../src/settings/visualKeyboard';

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

  it('builds the latch from clicks and from keys typed while something is latched', () => {
    const k = (key: string, code: string) => ({ key, code, ctrl: false, shift: false, alt: false, meta: false });
    let c = toggleCap({ mods: new Set() }, 'ControlLeft');
    expect(isLatched(c)).toBe(true);
    c = mergePhysical(c, k('F1', 'F1'));
    expect(chordName(c)).toBe('Ctrl+F1');
    c = mergePhysical(c, k('Shift', 'ShiftLeft'));
    expect(chordName(c)).toBe('Ctrl+Shift+F1');
    c = mergePhysical(c, k('Shift', 'ShiftLeft')); // typed again: toggles off
    expect(chordName(c)).toBe('Ctrl+F1');
    c = mergePhysical(c, k('F2', 'F2')); // a second main key replaces the first
    expect(chordName(c)).toBe('Ctrl+F2');
    c = toggleCap(c, 'F2'); // clicking the main key again clears it
    expect(chordName(c)).toBe('ControlLeft');
    expect(isLatched({ mods: new Set() })).toBe(false);
  });

  it('refuses chords the terminal would type as text', () => {
    expect(typesText({ mods: new Set(), main: 'KeyA' })).toBe(true);
    expect(typesText({ mods: new Set(['ShiftLeft']), main: 'KeyA' })).toBe(true);
    expect(typesText({ mods: new Set(), main: 'Digit1' })).toBe(true);
    expect(typesText({ mods: new Set(), main: 'Space' })).toBe(true);
    expect(typesText({ mods: new Set(['ControlLeft']), main: 'KeyA' })).toBe(false);
    expect(typesText({ mods: new Set(['AltLeft']), main: 'Digit1' })).toBe(false);
    expect(typesText({ mods: new Set(), main: 'NumpadAdd' })).toBe(false); // ACS binds the keypad + to Field +
    expect(typesText({ mods: new Set(), main: 'F1' })).toBe(false);
    expect(typesText({ mods: new Set(['ControlRight']) })).toBe(false);
  });

  it('knows the primary ACS key of a function, not its aliases', () => {
    expect(primaryAcsKey('pf13')).toBe('Shift+F1');
    expect(primaryAcsKey('enter')).toBe('Enter'); // ControlRight is the alias
    expect(primaryAcsKey('reset')).toBe('ControlLeft');
  });

  it('measures the main block so the picture can shrink when the page is narrower', () => {
    const w = blockWidth(MAIN_ROWS);
    expect(w).toBeGreaterThan(400);
    expect(w).toBeLessThan(520);
    expect(blockWidth(NUMPAD_ROWS)).toBe(4 * 27 + 3 * 3);
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
