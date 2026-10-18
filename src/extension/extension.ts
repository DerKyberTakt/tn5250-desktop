import * as vscode from 'vscode';
import { TerminalPanel } from './terminalPanel';
import { SettingsPanel } from './settingsPanel';
import { SessionItem, SessionsProvider } from './sessionsView';
import { readDefaults, readSessions, removeSessionAt, resolvedSessions, writeSessions } from './settingsStore';
import { importKmpInteractive } from './kmpCommand';
import { setPasswordInteractive } from './secrets';

const LAST_SESSION_KEY = 'tn5250.lastSession';

function parseHostInput(input: string, defaultPort: number): { host: string; port: number } | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) return undefined;
  const host = (m[1] as string).replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

async function saveTrace(): Promise<void> {
  const panel = TerminalPanel.active;
  const trace = panel?.exportTrace();
  if (!panel || !trace) {
    void vscode.window.showInformationMessage('TN5250: focus a connected terminal tab first.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Save TN5250 session trace',
    defaultUri: vscode.Uri.file(`tn5250-trace-${panel.title.replace(/[^\w.-]+/g, '_')}.json`),
    filters: { JSON: ['json'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(trace, null, 1) + '\n', 'utf8'));
  void vscode.window.showInformationMessage(`TN5250: trace saved to ${target.fsPath}. It contains screen contents; share it only with people allowed to see them.`);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('TN5250');
  context.subscriptions.push(output);

  const sessions = new SessionsProvider(context);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('tn5250.sessions', sessions));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'tn5250.connectPrevious';
  context.subscriptions.push(status);
  TerminalPanel.onActiveChanged = () => {
    const p = TerminalPanel.active;
    if (p) {
      status.text = `$(terminal) ${p.title}${p.connected ? '' : ' (disconnected)'}`;
      status.tooltip = 'TN5250 terminal';
      status.show();
    } else {
      status.hide();
    }
  };

  const openSession = (index: number): void => {
    const profile = resolvedSessions()[index];
    if (!profile) return;
    void context.globalState.update(LAST_SESSION_KEY, profile.name);
    TerminalPanel.create(context, output, profile);
  };

  const register = (command: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('tn5250.newConnection', async () => {
    const defaultPort = readDefaults().port;
    const input = await vscode.window.showInputBox({
      title: 'TN5250: New Connection',
      prompt: 'IBM i host name or address, optionally with :port. The rest is edited in Settings.',
      placeHolder: `myibmi  or  myibmi:${defaultPort}`,
      ignoreFocusOut: true,
      validateInput: (v) => (parseHostInput(v, defaultPort) ? undefined : 'Enter host or host:port'),
    });
    const parsed = input ? parseHostInput(input, defaultPort) : undefined;
    if (!parsed) return;
    const list = readSessions();
    list.push({ host: parsed.host, port: parsed.port, name: parsed.host });
    await writeSessions(list);
    sessions.refresh();
    SettingsPanel.show(context, output, list.length - 1);
  });
  register('tn5250.sortSessions', async () => {
    const cfg = vscode.workspace.getConfiguration('tn5250');
    const next = cfg.get<string>('sessionsSort', 'manual') === 'name' ? 'manual' : 'name';
    await cfg.update('sessionsSort', next, vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(`TN5250: connections sorted ${next === 'name' ? 'by name' : 'in saved order'}`, 2500);
  });
  register('tn5250.refreshSessions', () => sessions.refresh());
  register('tn5250.connectPrevious', () => {
    const list = resolvedSessions();
    const last = context.globalState.get<string>(LAST_SESSION_KEY);
    const index = Math.max(0, list.findIndex((s) => s.name === last));
    if (!list.length) {
      void vscode.commands.executeCommand('tn5250.newConnection');
      return;
    }
    openSession(index);
  });
  register('tn5250.connectSession', (item: SessionItem) => {
    if (item?.profile) openSession(item.index);
  });
  register('tn5250.editSession', (item: SessionItem) => SettingsPanel.show(context, output, item?.index ?? -1));
  register('tn5250.duplicateSession', async (item: SessionItem) => {
    const list = readSessions();
    const src = list[item?.index ?? -1];
    if (!src) return;
    const copy = { ...src, name: `${src.name ?? src.host} (copy)` };
    list.splice((item?.index ?? 0) + 1, 0, copy);
    await writeSessions(list);
    sessions.refresh();
    SettingsPanel.show(context, output, (item?.index ?? 0) + 1);
  });
  register('tn5250.removeSession', async (item: SessionItem) => {
    if (!item?.profile) return;
    const ok = await vscode.window.showWarningMessage(`Remove connection "${item.profile.name}"?`, { modal: true }, 'Remove');
    if (ok === 'Remove') await removeSessionAt(item.index);
    sessions.refresh();
  });
  register('tn5250.openSettings', () => SettingsPanel.show(context, output, -1));
  register('tn5250.newTab', () => {
    const p = TerminalPanel.active?.profile;
    if (p) TerminalPanel.create(context, output, p);
    else void vscode.commands.executeCommand('tn5250.connectPrevious');
  });
  register('tn5250.disconnectAll', async () => {
    const open = [...TerminalPanel.open].filter((p) => p.connected);
    if (!open.length) return;
    if (open.length > 1 && readDefaults().warnOnCloseMultiple) {
      const ok = await vscode.window.showWarningMessage(`Disconnect ${open.length} sessions?`, { modal: true }, 'Disconnect');
      if (ok !== 'Disconnect') return;
    }
    for (const p of open) p.disconnect();
  });
  register('tn5250.importKmp', () => importKmpInteractive(-1));
  register('tn5250.setPassword', () => setPasswordInteractive(context, -1));
  register('tn5250.printScreen', async () => {
    const text = TerminalPanel.active?.screenText();
    if (text === undefined) {
      void vscode.window.showInformationMessage('TN5250: focus a connected terminal tab first.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  register('tn5250.demoScreen', () => TerminalPanel.create(context, output));
  register('tn5250.disconnect', () => TerminalPanel.active?.disconnect());
  register('tn5250.reconnect', () => TerminalPanel.active?.connect());
  register('tn5250.saveTrace', saveTrace);
  register('tn5250.toggleScreenSize', () => TerminalPanel.active?.toggleScreenSize());
  register('tn5250.toggleKeyDebug', () => TerminalPanel.active?.toggleKeyOverlay());
  // Bound to every key the terminal consumes (see contributes.keybindings) so
  // the default VS Code binding for that key stays quiet while a terminal tab
  // is focused. The webview has already handled the key by the time this runs.
  register('tn5250.shadowKey', () => undefined);

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(TerminalPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Thenable<void> {
        TerminalPanel.restore(context, output, panel, state);
        return Promise.resolve();
      },
    }),
  );
}

export function deactivate(): void {
  // Panels are disposed through context.subscriptions.
}
