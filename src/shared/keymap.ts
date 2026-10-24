import type { KeyEventInfo } from './protocol';

/** Named 5250 keyboard functions (the right-hand side of a keymap). */
export type KeyAction =
  | 'enter'
  | 'fieldExit'
  | 'fieldPlus'
  | 'fieldMinus'
  | 'tab'
  | 'backtab'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'newline'
  | 'backspace'
  | 'delete'
  | 'insert'
  | 'endOfField'
  | 'eraseEof'
  | 'eraseInput'
  | 'dup'
  | 'fieldMark'
  | 'reset'
  | 'attn'
  | 'sysreq'
  | 'clear'
  | 'help'
  | 'pageUp'
  | 'pageDown'
  | 'print'
  | 'recordBackspace'
  | 'printScreen'
  | 'pf1'
  | 'pf2'
  | 'pf3'
  | 'pf4'
  | 'pf5'
  | 'pf6'
  | 'pf7'
  | 'pf8'
  | 'pf9'
  | 'pf10'
  | 'pf11'
  | 'pf12'
  | 'pf13'
  | 'pf14'
  | 'pf15'
  | 'pf16'
  | 'pf17'
  | 'pf18'
  | 'pf19'
  | 'pf20'
  | 'pf21'
  | 'pf22'
  | 'pf23'
  | 'pf24';

/** Physical key name -> action. Key names come from `keyName`. */
export type Keymap = Record<string, KeyAction>;

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/**
 * Normalizes a key event to a name such as "F3", "Shift+F3", "Ctrl+Enter",
 * "NumpadEnter" or "ControlLeft". Letters and symbols use the produced
 * character; keypad and modifier keys use the physical code so the mapping
 * does not depend on NumLock or on the modifier side.
 */
export function keyName(k: KeyEventInfo): string {
  let base: string;
  if (MODIFIER_KEYS.has(k.key)) {
    base = k.code || k.key;
  } else if (k.code.startsWith('Numpad')) {
    // Digits and operators keep the physical code (Numpad1, NumpadAdd) whatever NumLock
    // says; with NumLock off the keypad's End, Home and arrows get their own names
    // (NumpadEnd ...) so they can be bound separately, as ACS does.
    base = k.key.length > 1 ? `Numpad${k.key}` : k.code;
  } else if (k.key === ' ') {
    base = 'Space';
  } else {
    base = k.key.length === 1 ? k.key.toUpperCase() : k.key;
  }
  const mods: string[] = [];
  if (k.ctrl && k.key !== 'Control') mods.push('Ctrl');
  if (k.alt && k.key !== 'Alt') mods.push('Alt');
  if (k.meta && k.key !== 'Meta') mods.push('Meta');
  // Shift is only meaningful for non-character keys; "A" already encodes it.
  if (k.shift && k.key !== 'Shift' && (k.key.length !== 1 || k.code.startsWith('Numpad'))) mods.push('Shift');
  return [...mods, base].join('+');
}

/** A plain character that should be typed into the field. */
export function isTextKey(k: KeyEventInfo): boolean {
  return k.key.length === 1 && !k.ctrl && !k.alt && !k.meta;
}

export function resolveAction(k: KeyEventInfo, keymap: Keymap): KeyAction | undefined {
  return keymap[keyName(k)];
}

export type KeyResult = { kind: 'action'; action: KeyAction } | { kind: 'text'; text: string } | { kind: 'none' };

/**
 * What a key press does. The keymap wins over typing: keypad "+" and "-" produce
 * the characters "+" and "-" but are mapped by their physical code (NumpadAdd =
 * Field+, NumpadSubtract = Field-), as are characters remapped from a .kmp file.
 * Unmapped printable keys (letters, digits, keypad digits) are typed.
 */
export function classifyKey(k: KeyEventInfo, keymap: Keymap): KeyResult {
  const action = resolveAction(k, keymap);
  if (action) return { kind: 'action', action };
  if (isTextKey(k)) return { kind: 'text', text: k.key };
  return { kind: 'none' };
}

/** Keyboard layout modeled on IBM i Access Client Solutions defaults. */
export const ACS_KEYMAP: Keymap = {
  Enter: 'enter',
  ControlRight: 'enter',
  ControlLeft: 'reset',
  NumpadEnter: 'fieldExit',
  'Shift+Enter': 'fieldExit',
  'Ctrl+Enter': 'fieldExit',
  NumpadAdd: 'fieldPlus',
  NumpadSubtract: 'fieldMinus',
  Tab: 'tab',
  'Shift+Tab': 'backtab',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  NumpadHome: 'home',
  End: 'endOfField',
  NumpadEnd: 'endOfField',
  'Ctrl+End': 'eraseEof',
  Insert: 'insert',
  Delete: 'delete',
  Backspace: 'backspace',
  Escape: 'attn',
  'Shift+Escape': 'sysreq',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  'Shift+Insert': 'dup',
  'Shift+Home': 'fieldMark',
  'Alt+End': 'eraseInput',
  'Alt+NumpadEnd': 'eraseInput',
  Pause: 'clear',
  'Ctrl+Pause': 'print',
  PrintScreen: 'printScreen',
  'Ctrl+Alt+P': 'printScreen',
  'Alt+F1': 'help',
  F1: 'pf1',
  F2: 'pf2',
  F3: 'pf3',
  F4: 'pf4',
  F5: 'pf5',
  F6: 'pf6',
  F7: 'pf7',
  F8: 'pf8',
  F9: 'pf9',
  F10: 'pf10',
  F11: 'pf11',
  F12: 'pf12',
  'Shift+F1': 'pf13',
  'Shift+F2': 'pf14',
  'Shift+F3': 'pf15',
  'Shift+F4': 'pf16',
  'Shift+F5': 'pf17',
  'Shift+F6': 'pf18',
  'Shift+F7': 'pf19',
  'Shift+F8': 'pf20',
  'Shift+F9': 'pf21',
  'Shift+F10': 'pf22',
  'Shift+F11': 'pf23',
  'Shift+F12': 'pf24',
  F13: 'pf13',
  F14: 'pf14',
  F15: 'pf15',
  F16: 'pf16',
  F17: 'pf17',
  F18: 'pf18',
  F19: 'pf19',
  F20: 'pf20',
  F21: 'pf21',
  F22: 'pf22',
  F23: 'pf23',
  F24: 'pf24',
};
