import * as vscode from 'vscode';
import type { HostToSettings, SettingsToHost } from '../shared/settingsProtocol';
import { COLOR_KEYS, resolveSettings, type TerminalSettings } from '../shared/settings';
import { importKmpInteractive } from './kmpCommand';
import { setCertPassphraseInteractive, setPasswordInteractive } from './secrets';
import { importFontFile, listSystemFonts } from './fonts';
import * as path from 'node:path';
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
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(context.globalStorageUri, 'fonts')],
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${n}'; font-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;">
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
    void this.buildData(patch).then((msg) => this.panel.webview.postMessage(msg));
  }

  private async buildData(patch?: Partial<TerminalSettings>): Promise<HostToSettings> {
    const defaults = readDefaults();
    const sessions = readSessions();
    const current = this.select < 0 ? defaults : resolveSettings(defaults, sessions[this.select] ?? { host: '' });
    const merged = { ...current, ...(patch ?? {}) };
    const extra = [defaults.fontFile, ...sessions.map((s) => s.fontFile ?? '')].filter(Boolean);
    const fonts = (await listSystemFonts(extra)).map((f) => ({ family: f.family, monospace: f.monospace }));
    let watermarkImageData: string | undefined;
    if (merged.watermarkImage) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(merged.watermarkImage));
        const ext = path.extname(merged.watermarkImage).toLowerCase().replace('.', '');
        const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext || 'png'}`;
        watermarkImageData = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
      } catch {
        watermarkImageData = undefined;
      }
    }
    const fontFace = merged.fontFile && merged.fontFamily
      ? { family: merged.fontFamily, url: this.panel.webview.asWebviewUri(vscode.Uri.file(merged.fontFile)).toString() }
      : undefined;
    return { type: 'data', defaults, sessions, select: this.select, patch, fonts, watermarkImageData, fontFace };
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
      case 'browseFile': {
        const pem = msg.key === 'tlsClientKey';
        const picked = await vscode.window.showOpenDialog({
          title: pem ? 'Client private key (PEM)' : 'Client certificate (PKCS#12 or PEM)',
          canSelectMany: false,
          filters: pem ? { 'PEM key': ['pem', 'key'], 'All files': ['*'] } : { Certificates: ['pfx', 'p12', 'pem', 'crt', 'cer'], 'All files': ['*'] },
        });
        if (picked?.[0]) this.push({ [msg.key]: picked[0].fsPath } as Partial<TerminalSettings>);
        break;
      }
      case 'browseFont': {
        const picked = await vscode.window.showOpenDialog({ title: 'Font file', canSelectMany: false, filters: { 'TrueType / OpenType': ['ttf', 'otf'] } });
        if (!picked?.[0]) break;
        try {
          const imported = await importFontFile(this.context, picked[0]);
          this.push({ fontFile: imported.file, fontFamily: imported.family });
        } catch (err) {
          void vscode.window.showErrorMessage(`TN5250: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'setCertPassphrase':
        await setCertPassphraseInteractive(this.context, msg.target);
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
