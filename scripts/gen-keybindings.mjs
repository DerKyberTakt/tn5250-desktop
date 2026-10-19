// Regenerates contributes.keybindings in package.json.
//
// While a terminal tab is focused, every key the terminal consumes is bound to
// the no-op command tn5250.shadowKey. VS Code dispatches webview key events
// through its keybinding service as well, so without these entries F1 would
// still open the Command Palette, F5 would start debugging, and so on.
// Keys that must keep their VS Code meaning are listed in
// src/webview/keyboard.ts (isPassThrough) and are deliberately absent here.
import { readFileSync, writeFileSync } from 'node:fs';

const WHEN = "activeWebviewPanelId == 'tn5250.terminal' && !inputFocus";
const COMMAND = 'tn5250.shadowKey';

const keys = [];
for (let i = 1; i <= 12; i++) {
  const f = `f${i}`;
  for (const mod of ['', 'shift+', 'ctrl+', 'alt+', 'ctrl+shift+', 'shift+alt+']) {
    if (mod === 'alt+' && f === 'f4') continue; // closes the window on Windows
    keys.push(mod + f);
  }
}
keys.push(
  'escape',
  'shift+escape',
  'tab',
  'shift+tab',
  'enter',
  'shift+enter',
  'ctrl+enter',
  'pageup',
  'pagedown',
  'shift+pageup',
  'shift+pagedown',
  'home',
  'end',
  'shift+home',
  'shift+end',
  'ctrl+home',
  'ctrl+end',
  'insert',
  'shift+insert',
  'ctrl+insert',
  'delete',
  'shift+delete',
  'backspace',
  'ctrl+backspace',
  'up',
  'down',
  'left',
  'right',
  'shift+up',
  'shift+down',
  'shift+left',
  'shift+right',
  'ctrl+left',
  'ctrl+right',
  'ctrl+up',
  'ctrl+down',
  'ctrl+a',
  'ctrl+c',
  'ctrl+v',
  'ctrl+x',
  'ctrl+r',
  'ctrl+=',
  'ctrl+shift+=',
  'ctrl+-',
  'ctrl+shift+-',
  'ctrl+0',
  'ctrl+numpad_add',
  'ctrl+numpad_subtract',
);

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.contributes.keybindings = keys.map((key) => ({ key, command: COMMAND, when: WHEN }));
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`wrote ${keys.length} shadow keybindings to package.json`);
