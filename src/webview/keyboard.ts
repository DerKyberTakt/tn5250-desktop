import type { KeyEventInfo } from '../shared/protocol';

/**
 * Keys that stay with VS Code even while a terminal tab has focus: window and
 * editor navigation, the command palette, sidebar toggles and chords. Every
 * other key is consumed by the terminal (and shadowed in package.json so the
 * default VS Code binding does not fire as well).
 */
const PASS_THROUGH_CTRL = new Set([
  'p', // Quick Open; with Shift = Command Palette
  'b', // toggle sidebar
  'j', // toggle panel
  '`', // toggle terminal
  'w', // close editor
  'k', // chord lead
  'n', // new file
  'o', // open
  ',', // settings
  'tab', // editor switcher
  'pageup',
  'pagedown',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

const PASS_THROUGH_CTRL_SHIFT = new Set(['p', 'e', 'f', 'g', 'd', 'x', 'm', 'n', 'tab', '`']);

export function toKeyEventInfo(e: KeyboardEvent): KeyEventInfo {
  return {
    key: e.key,
    code: e.code,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

export function isPassThrough(k: KeyEventInfo): boolean {
  const key = k.key.toLowerCase();
  // Bare modifier presses never reach the host as 5250 actions.
  if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return true;
  // Alt+F4 closes the window on Windows; Alt alone opens the menu bar.
  if (k.alt && !k.ctrl && !k.meta && (key === 'f4' || key === 'alt')) return true;
  const primary = k.ctrl || k.meta;
  if (!primary) return false;
  if (k.shift) return PASS_THROUGH_CTRL_SHIFT.has(key);
  return PASS_THROUGH_CTRL.has(key);
}

export type ZoomAction = 'in' | 'out' | 'reset';

/** Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0, including the numeric keypad. */
export function zoomActionFor(k: KeyEventInfo): ZoomAction | undefined {
  if (!(k.ctrl || k.meta) || k.alt) return undefined;
  switch (k.key) {
    case '=':
    case '+':
      return 'in';
    case '-':
    case '_':
      return 'out';
    case '0':
      return 'reset';
    default:
      return undefined;
  }
}

export function describeKey(k: KeyEventInfo): string {
  const mods = [k.ctrl && 'Ctrl', k.shift && 'Shift', k.alt && 'Alt', k.meta && 'Meta'].filter(Boolean);
  const name = k.key === ' ' ? 'Space' : k.key;
  return [...mods, name].join('+');
}
