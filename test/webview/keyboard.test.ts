import { describe, expect, it } from 'vitest';
import { ACS_KEYMAP } from '../../src/shared/keymap';
import { effectiveKeymap } from '../../src/shared/settings';
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
  it('keeps a bound Control key for the terminal (Right Ctrl = Enter, Left Ctrl = Reset)', () => {
    expect(isPassThrough(k('Control', 'ControlRight', { ctrl: true }), ACS_KEYMAP)).toBe(false);
    expect(isPassThrough(k('Control', 'ControlLeft', { ctrl: true }), ACS_KEYMAP)).toBe(false);
  });

  it('passes an unbound Control key, Shift and Meta through', () => {
    expect(isPassThrough(k('Control', 'ControlRight', { ctrl: true }), {})).toBe(true);
    expect(isPassThrough(k('Control', 'ControlLeft', { ctrl: true }), { ControlRight: 'enter' })).toBe(true);
    expect(isPassThrough(k('Shift', 'ShiftLeft', { shift: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('Meta', 'MetaLeft', { meta: true }), ACS_KEYMAP)).toBe(true);
  });

  it('consumes a bare Alt so the host never sees an Alt tap (menu bar focus)', () => {
    expect(isPassThrough(k('Alt', 'AltLeft', { alt: true }), ACS_KEYMAP)).toBe(false);
    expect(isPassThrough(k('Alt', 'AltRight', { alt: true }), {}, 'desktop')).toBe(false);
  });

  it('keeps Alt+F4 and unmapped chords out of the terminal in VS Code', () => {
    expect(isPassThrough(k('F4', 'F4', { alt: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('p', 'KeyP', { ctrl: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('P', 'KeyP', { ctrl: true, shift: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('B', 'KeyB', { ctrl: true, shift: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('b', 'KeyB', { ctrl: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('1', 'Digit1', { ctrl: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('Tab', 'Tab', { ctrl: true }), ACS_KEYMAP)).toBe(true);
    expect(isPassThrough(k('f', 'KeyF', { alt: true }), ACS_KEYMAP)).toBe(true);
  });

  it('consumes unmapped chords in the desktop app, except Alt+F4', () => {
    expect(isPassThrough(k('p', 'KeyP', { ctrl: true }), ACS_KEYMAP, 'desktop')).toBe(false);
    expect(isPassThrough(k('B', 'KeyB', { ctrl: true, shift: true }), ACS_KEYMAP, 'desktop')).toBe(false);
    expect(isPassThrough(k('F4', 'F4', { alt: true }), ACS_KEYMAP, 'desktop')).toBe(true);
  });

  it('gives the terminal its own keys and mapped chords in both hosts', () => {
    for (const host of ['vscode', 'desktop'] as const) {
      expect(isPassThrough(k('c', 'KeyC', { ctrl: true }), ACS_KEYMAP, host)).toBe(false);
      expect(isPassThrough(k('ArrowUp', 'ArrowUp', { ctrl: true }), ACS_KEYMAP, host)).toBe(false);
      expect(isPassThrough(k('ArrowLeft', 'ArrowLeft', { alt: true }), ACS_KEYMAP, host)).toBe(false);
      expect(isPassThrough(k('Home', 'Home', { ctrl: true }), ACS_KEYMAP, host)).toBe(false);
      expect(isPassThrough(k('F3'), ACS_KEYMAP, host)).toBe(false);
      expect(isPassThrough(k('Enter', 'Enter', { ctrl: true }), ACS_KEYMAP, host)).toBe(false);
      expect(isPassThrough(k('a', 'KeyA'), ACS_KEYMAP, host)).toBe(false);
    }
  });

  it("follows the keymap: a chord bound by the user is the terminal's, an unbound default is not", () => {
    expect(isPassThrough(k('e', 'KeyE', { ctrl: true }), { ...ACS_KEYMAP, 'Ctrl+E': 'eraseField' })).toBe(false);
    expect(isPassThrough(k('ArrowUp', 'ArrowUp', { ctrl: true }), effectiveKeymap({ 'Ctrl+ArrowUp': null }))).toBe(true);
  });
});
