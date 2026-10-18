import * as vscode from 'vscode';
import { readDefaults, readSessions } from './settingsStore';

/** Secret-store key for a profile's sign-on password. */
export function passwordKey(profileName: string, host: string): string {
  return `tn5250.password:${profileName || host}`;
}

export function certPassphraseKey(profileName: string, host: string): string {
  return `tn5250.certpass:${profileName || host}`;
}

export async function setCertPassphraseInteractive(context: vscode.ExtensionContext, target: number): Promise<void> {
  const name = target < 0 ? 'Defaults' : (readSessions()[target]?.name ?? readSessions()[target]?.host ?? '');
  const host = target < 0 ? readDefaults().host : (readSessions()[target]?.host ?? '');
  const value = await vscode.window.showInputBox({
    title: `TN5250: certificate passphrase for ${name}`,
    prompt: 'Passphrase of the client certificate or key. Stored in the VS Code secret store. Leave empty to remove.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const key = certPassphraseKey(target < 0 ? '' : name, host);
  if (value) await context.secrets.store(key, value);
  else await context.secrets.delete(key);
  void vscode.window.showInformationMessage(value ? 'TN5250: passphrase stored.' : 'TN5250: passphrase removed.');
}

export async function setPasswordInteractive(context: vscode.ExtensionContext, target: number): Promise<void> {
  const name = target < 0 ? 'Defaults' : (readSessions()[target]?.name ?? readSessions()[target]?.host ?? '');
  const host = target < 0 ? readDefaults().host : (readSessions()[target]?.host ?? '');
  const value = await vscode.window.showInputBox({
    title: `TN5250: sign-on password for ${name}`,
    prompt: 'Stored in the VS Code secret store. Leave empty to remove.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const key = passwordKey(target < 0 ? '' : name, host);
  if (value) await context.secrets.store(key, value);
  else await context.secrets.delete(key);
  void vscode.window.showInformationMessage(value ? 'TN5250: password stored.' : 'TN5250: password removed.');
}
