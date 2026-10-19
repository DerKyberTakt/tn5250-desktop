import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP, classifyKey, isTextKey, keyName, resolveAction } from '../../src/shared/keymap';
import type { KeyEventInfo } from '../../src/shared/protocol';

const k = (key: string, code = key, mods: Partial<KeyEventInfo> = {}): KeyEventInfo => ({
  key,
  code,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe('keyName', () => {
  it('names plain and modified keys', () => {
    expect(keyName(k('F3'))).toBe('F3');
    expect(keyName(k('F3', 'F3', { shift: true }))).toBe('Shift+F3');
    expect(keyName(k('Enter', 'Enter', { ctrl: true }))).toBe('Ctrl+Enter');
    expect(keyName(k('Enter', 'NumpadEnter'))).toBe('NumpadEnter');
    expect(keyName(k('+', 'NumpadAdd'))).toBe('NumpadAdd');
    expect(keyName(k('Control', 'ControlLeft', { ctrl: true }))).toBe('ControlLeft');
    expect(keyName(k('Control', 'ControlRight', { ctrl: true }))).toBe('ControlRight');
    expect(keyName(k(' ', 'Space'))).toBe('Space');
    expect(keyName(k('a', 'KeyA'))).toBe('A');
    expect(keyName(k('A', 'KeyA', { shift: true }))).toBe('A');
    expect(keyName(k('End', 'End', { alt: true }))).toBe('Alt+End');
  });
});

describe('ACS keymap', () => {
  it('resolves the core 5250 functions', () => {
    expect(resolveAction(k('Enter'), ACS_KEYMAP)).toBe('enter');
    expect(resolveAction(k('Control', 'ControlRight', { ctrl: true }), ACS_KEYMAP)).toBe('enter');
    expect(resolveAction(k('Control', 'ControlLeft', { ctrl: true }), ACS_KEYMAP)).toBe('reset');
    expect(resolveAction(k('Enter', 'NumpadEnter'), ACS_KEYMAP)).toBe('fieldExit');
    expect(resolveAction(k('Enter', 'Enter', { shift: true }), ACS_KEYMAP)).toBe('fieldExit');
    expect(resolveAction(k('F1'), ACS_KEYMAP)).toBe('pf1');
    expect(resolveAction(k('F12'), ACS_KEYMAP)).toBe('pf12');
    expect(resolveAction(k('F1', 'F1', { shift: true }), ACS_KEYMAP)).toBe('pf13');
    expect(resolveAction(k('Escape'), ACS_KEYMAP)).toBe('attn');
    expect(resolveAction(k('Escape', 'Escape', { shift: true }), ACS_KEYMAP)).toBe('sysreq');
    expect(resolveAction(k('PageDown'), ACS_KEYMAP)).toBe('pageDown');
    expect(resolveAction(k('Tab', 'Tab', { shift: true }), ACS_KEYMAP)).toBe('backtab');
    expect(resolveAction(k('x', 'KeyX', { ctrl: true }), ACS_KEYMAP)).toBeUndefined();
  });

  it('classifies text keys', () => {
    expect(isTextKey(k('a', 'KeyA'))).toBe(true);
    expect(isTextKey(k('5', 'Numpad5'))).toBe(true);
    expect(isTextKey(k('a', 'KeyA', { ctrl: true }))).toBe(false);
    expect(isTextKey(k('Enter'))).toBe(false);
  });

  it('lets the keymap win over typing (10-key)', () => {
    // Keypad + and - produce "+" / "-" but are Field+ / Field- (NumLock on or off).
    expect(classifyKey(k('+', 'NumpadAdd'), ACS_KEYMAP)).toEqual({ kind: 'action', action: 'fieldPlus' });
    expect(classifyKey(k('-', 'NumpadSubtract'), ACS_KEYMAP)).toEqual({ kind: 'action', action: 'fieldMinus' });
    expect(classifyKey(k('Enter', 'NumpadEnter'), ACS_KEYMAP)).toEqual({ kind: 'action', action: 'fieldExit' });
    expect(classifyKey(k('Enter', 'Enter'), ACS_KEYMAP)).toEqual({ kind: 'action', action: 'enter' });
    // Keypad digits and the main-row + / - are still typed.
    expect(classifyKey(k('5', 'Numpad5'), ACS_KEYMAP)).toEqual({ kind: 'text', text: '5' });
    expect(classifyKey(k('.', 'NumpadDecimal'), ACS_KEYMAP)).toEqual({ kind: 'text', text: '.' });
    expect(classifyKey(k('+', 'Equal', { shift: true }), ACS_KEYMAP)).toEqual({ kind: 'text', text: '+' });
    expect(classifyKey(k('-', 'Minus'), ACS_KEYMAP)).toEqual({ kind: 'text', text: '-' });
    expect(classifyKey(k('x', 'KeyX', { ctrl: true }), ACS_KEYMAP)).toEqual({ kind: 'none' });
  });
});
