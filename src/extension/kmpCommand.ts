import * as vscode from 'vscode';
import { importKmp } from '../shared/kmpImport';
import { readDefaults, readSessions, writeDefaults, writeSessions } from './settingsStore';

/** Picks a .kmp file and merges its key assignments into the defaults (-1) or a saved session. */
export async function importKmpInteractive(target: number): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import ACS keyboard map',
    canSelectMany: false,
    filters: { 'ACS keyboard map': ['kmp'], 'All files': ['*'] },
  });
  const file = picked?.[0];
  if (!file) return;
  const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
  const result = importKmp(text);
  const count = Object.keys(result.keymap).length;
  if (!count) {
    void vscode.window.showWarningMessage('TN5250: no usable key assignments found in that file.');
    return;
  }
  if (target < 0) {
    const d = readDefaults();
    await writeDefaults({ ...d, keymap: { ...d.keymap, ...result.keymap } });
  } else {
    const sessions = readSessions();
    const s = sessions[target];
    if (!s) return;
    s.keymap = { ...(s.keymap ?? {}), ...result.keymap };
    await writeSessions(sessions);
  }
  const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
  void vscode.window.showInformationMessage(`TN5250: imported ${count} key assignment(s)${skipped}.`);
}
