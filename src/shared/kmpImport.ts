import type { KeyAction } from './keymap';

/**
 * Best-effort import of IBM i Access Client Solutions keyboard maps (.kmp).
 *
 * A .kmp file is an INI-style text file with a [KeyRemap] section whose lines
 * look like `S10=[fldext]`: modifier letters followed by a Java virtual key
 * code, then the 5250 function in brackets. Only entries whose key and function
 * we understand are imported; the rest are reported as skipped.
 */

/** Java KeyEvent VK codes to our key names (see keyName in keymap.ts). */
const VK: Record<number, string> = {
  8: 'Backspace',
  9: 'Tab',
  10: 'Enter',
  19: 'Pause',
  27: 'Escape',
  32: 'Space',
  33: 'PageUp',
  34: 'PageDown',
  35: 'End',
  36: 'Home',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  44: ',',
  45: '-',
  46: '.',
  47: '/',
  59: ';',
  61: '=',
  91: '[',
  92: '\\',
  93: ']',
  96: 'Numpad0',
  97: 'Numpad1',
  98: 'Numpad2',
  99: 'Numpad3',
  100: 'Numpad4',
  101: 'Numpad5',
  102: 'Numpad6',
  103: 'Numpad7',
  104: 'Numpad8',
  105: 'Numpad9',
  106: 'NumpadMultiply',
  107: 'NumpadAdd',
  109: 'NumpadSubtract',
  110: 'NumpadDecimal',
  111: 'NumpadDivide',
  127: 'Delete',
  155: 'Insert',
  192: '`',
  222: "'",
};
for (let i = 0; i < 12; i++) VK[112 + i] = `F${i + 1}`;
for (let i = 0; i < 12; i++) VK[61440 + i] = `F${i + 13}`;
for (let c = 48; c <= 57; c++) VK[c] = String.fromCharCode(c);
for (let c = 65; c <= 90; c++) VK[c] = String.fromCharCode(c);

/** HOD/ACS function names to our actions. */
const FUNCTIONS: Record<string, KeyAction> = {
  enter: 'enter',
  fldext: 'fieldExit',
  fldplus: 'fieldPlus',
  fldminus: 'fieldMinus',
  reset: 'reset',
  attn: 'attn',
  sysreq: 'sysreq',
  clear: 'clear',
  help: 'help',
  print: 'print',
  pageup: 'pageUp',
  pagedn: 'pageDown',
  pagedown: 'pageDown',
  rollup: 'pageDown',
  rolldown: 'pageUp',
  recbackspace: 'recordBackspace',
  tab: 'tab',
  backtab: 'backtab',
  home: 'home',
  newline: 'newline',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  insert: 'insert',
  delete: 'delete',
  backspace: 'backspace',
  // HOD/ACS: [eof] is End of Field (a cursor move), [eraseeof] erases.
  eof: 'endOfField',
  endfield: 'endOfField',
  eraseeof: 'eraseEof',
  eraseinput: 'eraseInput',
  dup: 'dup',
  fieldmark: 'fieldMark',
  fldmark: 'fieldMark',
};
for (let i = 1; i <= 24; i++) {
  FUNCTIONS[`pf${i}`] = `pf${i}` as KeyAction;
  FUNCTIONS[`f${i}`] = `pf${i}` as KeyAction;
}

export interface KmpImportResult {
  keymap: Record<string, KeyAction>;
  skipped: string[];
}

export function importKmp(text: string): KmpImportResult {
  const keymap: Record<string, KeyAction> = {};
  const skipped: string[] = [];
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inSection = /^\[KeyRemap\]$/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^([A-Z]*)(\d+)=\[([^\]]+)\]$/i.exec(line);
    if (!m) {
      if (!/^(keyVersion|sessionType|autoApply|codePage|XF:)/i.test(line)) skipped.push(line);
      continue;
    }
    const mods = (m[1] as string).toUpperCase();
    const base = VK[Number(m[2])];
    const action = FUNCTIONS[(m[3] as string).toLowerCase()];
    if (!base || !action) {
      skipped.push(line);
      continue;
    }
    const parts: string[] = [];
    if (mods.includes('C')) parts.push('Ctrl');
    if (mods.includes('A')) parts.push('Alt');
    if (mods.includes('S')) parts.push('Shift');
    keymap[[...parts, base].join('+')] = action;
  }
  return { keymap, skipped };
}
