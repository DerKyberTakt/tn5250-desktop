import { describe, expect, it } from 'vitest';
import { keyName } from '../../src/shared/keymap';
import { KEYBOARD_LAYOUTS, MAIN_ROWS, bindingsForCode, capLabel, chordName, keyFromCode, layoutById, nameUsesCode, type KeyCap } from '../../src/settings/visualKeyboard';

const cap = (code: string): KeyCap => {
  const found = MAIN_ROWS.flat().find((c) => c && c.code === code);
  if (!found) throw new Error(`no cap ${code}`);
  return found;
};
const charCodes = MAIN_ROWS.flat()
  .filter((c): c is KeyCap => !!c && /^(Key[A-Z]|Digit\d|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(c.code))
  .map((c) => c.code);

describe('keyboard layouts for the picture', () => {
  it('US QWERTY is the default and the fallback', () => {
    expect(KEYBOARD_LAYOUTS[0]?.id).toBe('us');
    expect(layoutById('nope').id).toBe('us');
    expect(layoutById(undefined).id).toBe('us');
    expect(layoutById('dvorak').label).toBe('Dvorak');
    // The default changes nothing on the picture.
    for (const code of charCodes) expect(capLabel(cap(code))).toBe(cap(code).label);
  });

  it('every layout has each of the 26 letters on exactly one key, and no blank key', () => {
    for (const layout of KEYBOARD_LAYOUTS) {
      const plain = charCodes.map((code) => keyFromCode(code, false, layout));
      for (const ch of plain) expect(ch.trim(), `${layout.id}: blank key`).not.toBe('');
      for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
        expect(plain.filter((ch) => ch.toLowerCase() === letter).length, `${layout.id}: ${letter}`).toBe(1);
      }
    }
  });

  it('labels the caps the way the layout prints them', () => {
    const dvorak = layoutById('dvorak');
    expect(capLabel(cap('KeyO'), dvorak)).toBe('R');
    expect(capLabel(cap('KeyQ'), dvorak)).toBe("'");
    expect(capLabel(cap('Semicolon'), dvorak)).toBe('S');
    const azerty = layoutById('azerty');
    expect(capLabel(cap('KeyQ'), azerty)).toBe('A');
    expect(capLabel(cap('KeyA'), azerty)).toBe('Q');
    expect(capLabel(cap('Semicolon'), azerty)).toBe('M');
    expect(capLabel(cap('Digit1'), azerty)).toBe('&');
    const qwertz = layoutById('qwertz');
    expect(capLabel(cap('KeyY'), qwertz)).toBe('Z');
    expect(capLabel(cap('KeyZ'), qwertz)).toBe('Y');
    expect(capLabel(cap('BracketLeft'), qwertz)).toBe('Ü');
    expect(capLabel(cap('KeyP'), layoutById('colemak'))).toBe(';');
    // Keys that are not characters keep their label in every layout.
    expect(capLabel(cap('Enter'), azerty)).toBe('Enter');
    expect(capLabel(cap('F5'), dvorak)).toBe('F5');
  });

  it('puts a binding on the cap that produces its character in that layout', () => {
    const map = { 'Ctrl+R': 'reset', 'Ctrl+1': 'pf1' } as never;
    expect(bindingsForCode(map, 'KeyR')).toEqual(['Ctrl+R → reset']);
    const dvorak = layoutById('dvorak');
    expect(bindingsForCode(map, 'KeyO', dvorak)).toEqual(['Ctrl+R → reset']);
    expect(bindingsForCode(map, 'KeyR', dvorak)).toEqual([]);
    // AZERTY has the digits on the shifted level of the same keys.
    expect(nameUsesCode('Ctrl+1', 'Digit1', layoutById('azerty'))).toBe(true);
    expect(nameUsesCode('Ctrl+M', 'Semicolon', layoutById('azerty'))).toBe(true);
    expect(nameUsesCode('Ctrl+M', 'KeyM', layoutById('azerty'))).toBe(false);
  });

  it('names a chord built by clicks as the real keyboard would', () => {
    const dvorak = layoutById('dvorak');
    // On Dvorak the key at the US "O" position produces "r": Ctrl with it is Ctrl+R.
    expect(chordName({ mods: new Set(['ControlLeft']), main: 'KeyO' }, dvorak)).toBe('Ctrl+R');
    expect(chordName({ mods: new Set(['ControlLeft']), main: 'KeyO' }, dvorak)).toBe(keyName({ key: 'r', code: 'KeyO', ctrl: true, shift: false, alt: false, meta: false }));
    expect(chordName({ mods: new Set(['AltLeft']), main: 'KeyQ' }, layoutById('azerty'))).toBe('Alt+A');
    // Function keys and the keypad do not depend on the layout.
    expect(chordName({ mods: new Set(['ShiftLeft']), main: 'F1' }, dvorak)).toBe('Shift+F1');
    expect(chordName({ mods: new Set(), main: 'NumpadAdd' }, layoutById('azerty'))).toBe('NumpadAdd');
  });
});
