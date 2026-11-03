import { describe, expect, it } from 'vitest';
import { KeyCapture } from '../../src/settings/keyCapture';
import type { KeyEventInfo } from '../../src/shared/protocol';

const k = (key: string, code: string, mods: Partial<KeyEventInfo> = {}): KeyEventInfo => ({
  key,
  code,
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods,
});

describe('KeyCapture', () => {
  it('takes a chord on the keydown of its main key', () => {
    const c = new KeyCapture();
    expect(c.keydown(k('Control', 'ControlLeft', { ctrl: true }))).toBeUndefined();
    expect(c.keydown(k('Shift', 'ShiftLeft', { ctrl: true, shift: true }))).toBeUndefined();
    expect(c.keydown(k('E', 'KeyE', { ctrl: true, shift: true }))).toBe('Ctrl+E');
    // The modifiers' key-ups afterwards assign nothing.
    expect(c.keyup(k('Shift', 'ShiftLeft', { ctrl: true }))).toBeUndefined();
    expect(c.keyup(k('Control', 'ControlLeft'))).toBeUndefined();
  });

  it('takes a bare modifier on its keyup', () => {
    const c = new KeyCapture();
    expect(c.keydown(k('Control', 'ControlRight', { ctrl: true }))).toBeUndefined();
    expect(c.keydown(k('Control', 'ControlRight', { ctrl: true }))).toBeUndefined(); // auto-repeat
    expect(c.keyup(k('Control', 'ControlRight'))).toBe('ControlRight');
    expect(c.keydown(k('Shift', 'ShiftLeft', { shift: true }))).toBeUndefined();
    expect(c.keyup(k('Shift', 'ShiftLeft'))).toBe('ShiftLeft');
  });

  it('assigns nothing when two modifiers are pressed together and released', () => {
    const c = new KeyCapture();
    c.keydown(k('Control', 'ControlLeft', { ctrl: true }));
    c.keydown(k('Alt', 'AltLeft', { ctrl: true, alt: true }));
    expect(c.keyup(k('Control', 'ControlLeft', { alt: true }))).toBeUndefined();
    expect(c.keyup(k('Alt', 'AltLeft'))).toBeUndefined();
  });

  it('names plain keys like the terminal does', () => {
    const c = new KeyCapture();
    expect(c.keydown(k('F', 'KeyF', { shift: true }))).toBe('F');
    expect(c.keydown(k('F9', 'F9', { shift: true }))).toBe('Shift+F9');
    expect(c.keydown(k('Enter', 'NumpadEnter'))).toBe('NumpadEnter');
    expect(c.keydown(k('ArrowUp', 'ArrowUp', { ctrl: true }))).toBe('Ctrl+ArrowUp');
  });

  it('reset forgets a half-pressed modifier', () => {
    const c = new KeyCapture();
    c.keydown(k('Control', 'ControlLeft', { ctrl: true }));
    c.reset();
    expect(c.keyup(k('Control', 'ControlLeft'))).toBeUndefined();
  });
});
