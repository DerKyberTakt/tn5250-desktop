import * as vscode from 'vscode';
import type { HostToSettings, SettingsToHost } from '../shared/settingsProtocol';
import { COLOR_KEYS, resolveSettings, type TerminalSettings } from '../shared/settings';
import { importKmpInteractive } from './kmpCommand';
import { setPasswordInteractive } from './secrets';
import { readDefaults, readSessions, removeSessionAt, saveSession, writeDefaults, writeSessions } from './settingsStore';
import { TerminalPanel } from './terminalPanel';

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

/** The ACS-style settings page (one per window). */
export class SettingsPanel {
  static readonly viewType = 'tn5250.settings';
  private static current: SettingsPanel | undefined;

  static show(context: vscode.ExtensionContext, output: vscode.OutputChannel, select = -1): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.select = select;
      SettingsPanel.current.panel.reveal();
      SettingsPanel.current.push();
      return;
    }
    const panel = vscode.window.createWebviewPanel(SettingsPanel.viewType, 'TN5250 Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    });
    SettingsPanel.current = new SettingsPanel(context, output, panel, select);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly panel: vscode.WebviewPanel,
    private select: number,
  ) {
    const root = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'settings.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'settings-style.css'));
    const n = nonce();
    panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${n}'; font-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${style.toString()}"><title>TN5250 Settings</title></head>
<body><div id="app"></div><script nonce="${n}" src="${script.toString()}"></script></body></html>`;

    panel.webview.onDidReceiveMessage((msg: SettingsToHost) => void this.onMessage(msg), undefined, context.subscriptions);
    panel.onDidDispose(() => {
      if (SettingsPanel.current === this) SettingsPanel.current = undefined;
    });
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('tn5250')) this.push();
      },
      undefined,
      context.subscriptions,
    );
  }

  private push(patch?: Partial<TerminalSettings>): void {
    const msg: HostToSettings = { type: 'data', defaults: readDefaults(), sessions: readSessions(), select: this.select, patch };
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: SettingsToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        break;
      case 'save':
        if (msg.target < 0) await writeDefaults(msg.values);
        else await saveSession(msg.target, msg.values);
        this.select = msg.target;
        this.push();
        void vscode.window.setStatusBarMessage('TN5250: settings saved', 2500);
        break;
      case 'addSession': {
        const sessions = readSessions();
        sessions.push({ host: '', name: 'New session' });
        await writeSessions(sessions);
        this.select = sessions.length - 1;
        this.push();
        break;
      }
      case 'removeSession': {
        const name = readSessions()[msg.index]?.name ?? 'this session';
        const ok = await vscode.window.showWarningMessage(`Remove "${name}"?`, { modal: true }, 'Remove');
        if (ok === 'Remove') {
          await removeSessionAt(msg.index);
          this.select = -1;
          this.push();
        }
        break;
      }
      case 'connect': {
        const entry = readSessions()[msg.index];
        if (entry?.host) TerminalPanel.create(this.context, this.output, resolveSettings(readDefaults(), entry));
        break;
      }
      case 'setPassword':
        await setPasswordInteractive(this.context, msg.target);
        break;
      case 'importKmp':
        await importKmpInteractive(msg.target);
        this.select = msg.target;
        this.push();
        break;
      case 'browseWatermark': {
        const picked = await vscode.window.showOpenDialog({ title: 'Watermark image', canSelectMany: false, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] } });
        if (picked?.[0]) this.push({ watermarkImage: picked[0].fsPath, watermarkType: 'image' });
        break;
      }
      case 'exportColors': {
        const target = await vscode.window.showSaveDialog({ title: 'Export colour scheme', defaultUri: vscode.Uri.file('tn5250-colors.json'), filters: { JSON: ['json'] } });
        if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(msg.values, null, 2) + '\n', 'utf8'));
        break;
      }
      case 'importColors': {
        const picked = await vscode.window.showOpenDialog({ title: 'Import colour scheme', canSelectMany: false, filters: { JSON: ['json'] } });
        if (!picked?.[0]) break;
        try {
          const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8')) as Record<string, unknown>;
          const patch: Partial<TerminalSettings> = {};
          for (const k of COLOR_KEYS) {
            const v = parsed[k];
            if (typeof v === 'string') (patch as Record<string, unknown>)[k] = v;
          }
          this.push(patch);
        } catch (err) {
          void vscode.window.showErrorMessage(`TN5250: not a colour scheme file (${err instanceof Error ? err.message : String(err)})`);
        }
        break;
      }
      case 'openJson':
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:DerKyberTakt.tn5250-terminal');
        break;
    }
  }
}
