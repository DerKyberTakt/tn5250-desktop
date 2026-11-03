import { ACS_KEYMAP, keyName, type KeyAction, type Keymap } from '../shared/keymap';
import type { KeyEventInfo } from '../shared/protocol';

/** Key cap geometry in px: one key unit, and the gap between caps (a gap cell is one unit minus a gap). */
export const KEY_UNIT = 30;
export const KEY_GAP = 3;

/** The width in px of a key cap. */
export function capWidth(cap: KeyCap): number {
  return (cap.width ?? 1) * KEY_UNIT - KEY_GAP;
}

/** The natural width in px of a block of rows (its widest row), to know when the picture must shrink. */
export function blockWidth(rows: KeyRow[]): number {
  return Math.max(...rows.map((row) => row.reduce((w, cap) => w + (cap ? capWidth(cap) : KEY_UNIT - KEY_GAP), 0) + (row.length - 1) * KEY_GAP));
}

/** One key cap: physical code, what is printed on it, and its width in key units. */
export interface KeyCap {
  code: string;
  label: string;
  width?: number;
}

/** A row of key caps; `null` is a gap of one key unit. */
export type KeyRow = Array<KeyCap | null>;

const k = (code: string, label: string, width?: number): KeyCap => ({ code, label, width });

/** The main block of a US ANSI keyboard, with the function row and, above it, F13-F24 (Shift+F1 ... on most keyboards; real keys on some). */
export const MAIN_ROWS: KeyRow[] = [
  [null, null, k('F13', 'F13'), k('F14', 'F14'), k('F15', 'F15'), k('F16', 'F16'), null, k('F17', 'F17'), k('F18', 'F18'), k('F19', 'F19'), k('F20', 'F20'), null, k('F21', 'F21'), k('F22', 'F22'), k('F23', 'F23'), k('F24', 'F24')],
  [k('Escape', 'Esc'), null, k('F1', 'F1'), k('F2', 'F2'), k('F3', 'F3'), k('F4', 'F4'), null, k('F5', 'F5'), k('F6', 'F6'), k('F7', 'F7'), k('F8', 'F8'), null, k('F9', 'F9'), k('F10', 'F10'), k('F11', 'F11'), k('F12', 'F12')],
  [k('Backquote', '`'), k('Digit1', '1'), k('Digit2', '2'), k('Digit3', '3'), k('Digit4', '4'), k('Digit5', '5'), k('Digit6', '6'), k('Digit7', '7'), k('Digit8', '8'), k('Digit9', '9'), k('Digit0', '0'), k('Minus', '-'), k('Equal', '='), k('Backspace', 'Backspace', 2)],
  [k('Tab', 'Tab', 1.5), k('KeyQ', 'Q'), k('KeyW', 'W'), k('KeyE', 'E'), k('KeyR', 'R'), k('KeyT', 'T'), k('KeyY', 'Y'), k('KeyU', 'U'), k('KeyI', 'I'), k('KeyO', 'O'), k('KeyP', 'P'), k('BracketLeft', '['), k('BracketRight', ']'), k('Backslash', '\\', 1.5)],
  [k('CapsLock', 'Caps', 1.75), k('KeyA', 'A'), k('KeyS', 'S'), k('KeyD', 'D'), k('KeyF', 'F'), k('KeyG', 'G'), k('KeyH', 'H'), k('KeyJ', 'J'), k('KeyK', 'K'), k('KeyL', 'L'), k('Semicolon', ';'), k('Quote', "'"), k('Enter', 'Enter', 2.25)],
  [k('ShiftLeft', 'Shift', 2.25), k('KeyZ', 'Z'), k('KeyX', 'X'), k('KeyC', 'C'), k('KeyV', 'V'), k('KeyB', 'B'), k('KeyN', 'N'), k('KeyM', 'M'), k('Comma', ','), k('Period', '.'), k('Slash', '/'), k('ShiftRight', 'Shift', 2.75)],
  [k('ControlLeft', 'Ctrl', 1.25), k('MetaLeft', 'Win', 1.25), k('AltLeft', 'Alt', 1.25), k('Space', 'Space', 6.25), k('AltRight', 'Alt', 1.25), k('MetaRight', 'Win', 1.25), k('ContextMenu', 'Menu', 1.25), k('ControlRight', 'Ctrl', 1.25)],
];

/** The navigation cluster and arrows. */
export const NAV_ROWS: KeyRow[] = [
  [k('PrintScreen', 'PrtSc'), k('ScrollLock', 'ScrLk'), k('Pause', 'Pause')],
  [k('Insert', 'Ins'), k('Home', 'Home'), k('PageUp', 'PgUp')],
  [k('Delete', 'Del'), k('End', 'End'), k('PageDown', 'PgDn')],
  [null, null, null],
  [null, k('ArrowUp', '↑'), null],
  [k('ArrowLeft', '←'), k('ArrowDown', '↓'), k('ArrowRight', '→')],
];

/** The numeric keypad. */
export const NUMPAD_ROWS: KeyRow[] = [
  [k('NumLock', 'Num'), k('NumpadDivide', '/'), k('NumpadMultiply', '*'), k('NumpadSubtract', '-')],
  [k('Numpad7', '7'), k('Numpad8', '8'), k('Numpad9', '9'), k('NumpadAdd', '+')],
  [k('Numpad4', '4'), k('Numpad5', '5'), k('Numpad6', '6'), k('NumpadEnter', 'Enter')],
  [k('Numpad1', '1'), k('Numpad2', '2'), k('Numpad3', '3'), null],
  [k('Numpad0', '0', 2), k('NumpadDecimal', '.'), null],
];

export const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** The character a US keyboard produces for a code, unshifted and shifted. */
const CHARS: Record<string, [string, string]> = {
  Backquote: ['`', '~'],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Digit0: ['0', ')'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  NumpadDivide: ['/', '/'],
  NumpadMultiply: ['*', '*'],
  NumpadSubtract: ['-', '-'],
  NumpadAdd: ['+', '+'],
  NumpadDecimal: ['.', '.'],
};

const MOD_KEY: Record<string, string> = { ControlLeft: 'Control', ControlRight: 'Control', ShiftLeft: 'Shift', ShiftRight: 'Shift', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta' };

/** The `KeyboardEvent.key` a code produces, so `keyName` can name a chord built by clicks exactly as it names a typed one. */
export function keyFromCode(code: string, shift = false): string {
  const pair = CHARS[code];
  if (pair) return shift ? pair[1] : pair[0];
  if (MOD_KEY[code]) return MOD_KEY[code] as string;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (code === 'NumpadEnter') return 'Enter';
  if (code === 'Space') return ' ';
  return code; // F1, ArrowUp, Home, Insert, Escape, Tab, Enter, Backspace, Delete ...
}

export interface ClickedChord {
  /** Latched modifier codes (ControlLeft ...). */
  mods: Set<string>;
  /** The main key's code, or undefined when only modifiers are latched. */
  main?: string;
}

/** Whether anything is latched on the picture. */
export function isLatched(c: ClickedChord): boolean {
  return c.mods.size > 0 || c.main !== undefined;
}

/** A click on a key cap: a modifier toggles its latch, a main key replaces (or clears) the main key. */
export function toggleCap(c: ClickedChord, code: string): ClickedChord {
  const mods = new Set(c.mods);
  if (MODIFIER_CODES.has(code)) {
    if (mods.has(code)) mods.delete(code);
    else mods.add(code);
    return { mods, main: c.main };
  }
  return { mods, main: c.main === code ? undefined : code };
}

/** A physical keydown while something is latched edits the latch instead of assigning. */
export function mergePhysical(c: ClickedChord, k: KeyEventInfo): ClickedChord {
  if (MODIFIER_CODES.has(k.code)) return toggleCap(c, k.code);
  return { mods: new Set(c.mods), main: k.code };
}

/** True when the chord is a character the terminal would type (a letter, digit, symbol or Space without Ctrl, Alt or Meta). */
export function typesText(c: ClickedChord): boolean {
  if (!c.main) return false;
  if ([...c.mods].some((code) => MOD_KEY[code] !== 'Shift')) return false;
  if (c.main.startsWith('Numpad')) return false; // keypad keys are bound by code (ACS: NumpadAdd = Field +)
  return c.main in CHARS || /^(Key[A-Z]|Digit\d|Space)$/.test(c.main);
}

/** The first key ACS gives a function (Shift+F1 for pf13; the F13 key is only an alias), or undefined. */
export function primaryAcsKey(action: KeyAction): string | undefined {
  for (const [key, a] of Object.entries(ACS_KEYMAP)) if (a === action) return key;
  return undefined;
}

/**
 * The key name for a chord composed on the visual keyboard. Modifiers alone name the
 * first latched one (a bare ControlRight); otherwise the main key with the modifiers.
 */
export function chordName(c: ClickedChord): string | undefined {
  const has = (m: string): boolean => [...c.mods].some((code) => MOD_KEY[code] === m);
  if (!c.main) {
    const first = [...c.mods][0];
    return first ? keyName({ key: MOD_KEY[first] as string, code: first, ctrl: false, shift: false, alt: false, meta: false }) : undefined;
  }
  const info: KeyEventInfo = { key: keyFromCode(c.main, has('Shift')), code: c.main, ctrl: has('Control'), shift: has('Shift'), alt: has('Alt'), meta: has('Meta') };
  return keyName(info);
}

/** The tokens of a key name: 'Ctrl+Shift+F1' -> ['Ctrl', 'Shift', 'F1']. */
export function keyTokens(name: string): string[] {
  if (name === '+') return ['+'];
  return name.split('+').filter(Boolean);
}

/** Whether a binding name involves a key cap: exact token match, modifiers by family, letters by their character. */
export function nameUsesCode(name: string, code: string): boolean {
  const tokens = keyTokens(name).map((t) => t.toLowerCase());
  const mod = MOD_KEY[code];
  if (mod) {
    const short = mod === 'Control' ? 'ctrl' : mod.toLowerCase();
    return tokens.includes(short) || tokens.includes(code.toLowerCase());
  }
  const last0 = tokens[tokens.length - 1] ?? '';
  // Keypad keys are always named by their code (NumpadEnter, Numpad7), never by the character.
  if (code.startsWith('Numpad')) return last0 === code.toLowerCase();
  const plain = keyFromCode(code, false).toLowerCase();
  const shifted = keyFromCode(code, true).toLowerCase();
  const last = tokens[tokens.length - 1] ?? '';
  // 'Shift+F1' and 'F1' both use F1; a letter is named by its character; 'Ctrl+1' uses Digit1, '!' too.
  return last === code.toLowerCase() || last === plain || last === shifted || (code === 'Space' && last === 'space');
}

/** The bindings that use a key cap, as "Shift+F1 -> pf13" lines. */
export function bindingsForCode(keymap: Keymap, code: string): string[] {
  return Object.entries(keymap)
    .filter(([name]) => nameUsesCode(name, code))
    .map(([name, action]) => `${name} → ${action}`);
}
