import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP } from '../../src/shared/keymap';
import type { KeyEventInfo } from '../../src/shared/protocol';
import { isPassThrough } from '../../src/webview/keyboard';

const k = (key: string, code = key, mods: Partial<KeyEventInfo> = {}): KeyEventInfo => ({
  key,
  code,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe('isPassThrough', () => {
  it('lets a Control key bound in the keymap reach the terminal (Right Ctrl = Enter, Left Ctrl = Reset)', () => {
    expect(isPassThrough(k('Control', 'ControlRight', { ctrl: true }), ACS_KEYMAP)).toBe(false);
    expect(isPassThrough(k('Control', 'ControlLeft', { ctrl: true }), ACS_KEYMAP)).toBe(false);
  });

  it('passes an unbound Control key and the other bare modifiers through', () => {
    expect(isPassThrough(k('Control', 'ControlRight', { ctrl: true }), {})).toBe(true);
    expect(isPassThrough(k('Control', 'ControlLeft', { ctrl: true }), { ControlRight: 'enter' })).toBe(true);
    expect(isPassThrough(k('Shift', 'ShiftLeft', { shift: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('Alt', 'AltLeft', { alt: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('Meta', 'MetaLeft', { meta: true }), ACS_KEYMAP)).toBe(true);
  });

  it('keeps the editor shortcuts and Alt+F4 out of the terminal', () => {
    expect(isPassThrough(k('p', 'KeyP', { ctrl: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('P', 'KeyP', { ctrl: true, shift: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('F4', 'F4', { alt: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('Tab', 'Tab', { ctrl: true }), ACS_KEYMAP)).toBe(true);
  });

  it('gives the terminal its own keys', () => {
    expect(isPassThrough(k('c', 'KeyC', { ctrl: true }), ACS_KEYMAP)).toBe(false);
    expect(isPassThrough(k('F3'), ACS_KEYMAP)).toBe(false);
    expect(isPassThrough(k('Enter', 'Enter', { ctrl: true }), ACS_KEYMAP)).toBe(false);
    expect(isPassThrough(k('a', 'KeyA'), ACS_KEYMAP)).toBe(false);
  });
});
