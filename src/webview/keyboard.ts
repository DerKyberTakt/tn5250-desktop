import { classifyKey, keyName, type Keymap } from '../shared/keymap';
import type { KeyEventInfo, TerminalHost } from '../shared/protocol';

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

/** A press of a modifier key on its own (Control, Shift, Alt, Meta). */
export function isBareModifier(k: KeyEventInfo): boolean {
  return k.key === 'Control' || k.key === 'Shift' || k.key === 'Alt' || k.key === 'Meta';
}

/**
 * Keys the terminal leaves to the host (VS Code or the desktop window).
 *
 * - A Control key on its own is a terminal key when the keymap binds it (ACS: Right Ctrl
 *   = Enter, Left Ctrl = Reset) and the host's otherwise.
 * - Alt on its own is always consumed: the terminal already takes Alt+arrow chords, and a
 *   host that sees an Alt press and release with nothing in between focuses its menu bar
 *   (VS Code's menubar does exactly that). Shift and Meta on their own are harmless and
 *   pass through.
 * - Alt+F4 closes the window.
 * - A chord with Ctrl, Alt or Meta that the keymap does not map is not the terminal's
 *   business: in VS Code it passes through (Ctrl+P, Ctrl+Shift+B, Ctrl+1 ...). The
 *   desktop app has no shortcuts behind the terminal, and the browser engine's own
 *   defaults (print, find, reload, zoom) must not fire, so it consumes them.
 * - Everything else (plain keys, mapped chords) is the terminal's.
 */
export function isPassThrough(k: KeyEventInfo, keymap: Keymap = {}, host: TerminalHost = 'vscode'): boolean {
  if (isBareModifier(k)) {
    if (k.key === 'Control') return keymap[keyName(k)] === undefined;
    return k.key !== 'Alt';
  }
  if (k.alt && !k.ctrl && !k.meta && k.key.toLowerCase() === 'f4') return true;
  if (!(k.ctrl || k.alt || k.meta)) return false;
  if (host !== 'vscode') return false;
  return classifyKey(k, keymap).kind === 'none';
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
