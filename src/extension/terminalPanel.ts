import * as os from 'node:os';
import * as vscode from 'vscode';
import { expandDeviceName } from '../shared/deviceName';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { DEFAULT_OIA } from '../shared/protocol';
import { SETTINGS_DEFAULTS, buildTitle, type TerminalSettings } from '../shared/settings';
import * as path from 'node:path';
import { buildDemoScreen } from '../engine/demoScreen';
import { SessionController } from './sessionController';
import { readDefaults, resolvedSessions } from './settingsStore';
import { passwordKey } from './secrets';
import { buildWebviewHtml } from './webviewHtml';

interface PanelState {
  profile?: TerminalSettings;
}

function isProfile(value: unknown): value is TerminalSettings {
  const p = value as TerminalSettings;
  return typeof p === 'object' && p !== null && typeof p.host === 'string' && typeof p.port === 'number';
}

/** One 5250 terminal tab: a webview plus (optionally) a live session. */
export class TerminalPanel {
  static readonly viewType = 'tn5250.terminal';
  static active: TerminalPanel | undefined;
  static onActiveChanged: (() => void) | undefined;

  private rows = 24;
  private cols = 80;
  private keyOverlay: boolean;
  private controller: SessionController | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Tabs opened per device-name template, so * and = produce distinct names. */
  private static readonly deviceOrdinals = new Map<string, number>();
  /** Session letters in use (ACS: A, B, C ...). */
  private static readonly letters = new Set<string>();
  static readonly open = new Set<TerminalPanel>();

  /** Expands a workstation template with the next free ordinal for that template. */
  static expandDevice(template: string): string {
    const ordinal = TerminalPanel.deviceOrdinals.get(template) ?? 0;
    TerminalPanel.deviceOrdinals.set(template, ordinal + 1);
    let userName: string;
    try {
      userName = os.userInfo().username;
    } catch {
      userName = '';
    }
    return expandDeviceName(template, { computerName: os.hostname(), userName, ordinal });
  }

  private static nextLetter(): string {
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i);
      if (!TerminalPanel.letters.has(l)) {
        TerminalPanel.letters.add(l);
        return l;
      }
    }
    return String(TerminalPanel.letters.size + 1);
  }

  static create(context: vscode.ExtensionContext, output: vscode.OutputChannel, profile?: TerminalSettings): TerminalPanel {
    let deviceTemplate = '';
    if (profile?.deviceName.trim()) {
      deviceTemplate = profile.deviceName.trim();
      profile = { ...profile, deviceName: TerminalPanel.expandDevice(deviceTemplate) };
    }
    const letter = profile ? TerminalPanel.nextLetter() : '';
    const panel = vscode.window.createWebviewPanel(
      TerminalPanel.viewType,
      profile ? buildTitle(profile, letter) : 'TN5250',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: profile ? !profile.switchToNewTab : false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    return new TerminalPanel(context, output, panel, profile, letter, deviceTemplate);
  }

  static restore(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    panel: vscode.WebviewPanel,
    state: unknown,
  ): TerminalPanel {
    const profile = (state as PanelState | undefined)?.profile;
    const p = isProfile(profile) ? { ...SETTINGS_DEFAULTS, ...profile } : undefined;
    return new TerminalPanel(context, output, panel, p, p ? TerminalPanel.nextLetter() : '', '');
  }

  private static setActive(panel: TerminalPanel | undefined): void {
    TerminalPanel.active = panel;
    TerminalPanel.onActiveChanged?.();
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly panel: vscode.WebviewPanel,
    readonly profile: TerminalSettings | undefined,
    private readonly letter: string,
    private readonly deviceTemplate: string,
  ) {
    TerminalPanel.open.add(this);
    this.keyOverlay = vscode.workspace.getConfiguration('tn5250').get<boolean>('debug.keyOverlay', false);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    };
    panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri);

    if (profile) {
      this.rows = profile.screenSize === '27x132' ? 27 : 24;
      this.cols = profile.screenSize === '27x132' ? 132 : 80;
      const label = profile.name || profile.host;
      this.controller = new SessionController(profile, {
        screen: (screen, oia) => {
          this.post({ type: 'screen', screen });
          this.post({ type: 'oia', oia });
        },
        status: (status, detail) => {
          this.post({ type: 'status', status, detail });
          this.output.appendLine(`[${label}] ${status}: ${detail}`);
          TerminalPanel.onActiveChanged?.();
        },
        alarm: () => this.post({ type: 'alarm' }),
        nextDeviceName: () => (this.deviceTemplate && /[*=]/.test(this.deviceTemplate) ? TerminalPanel.expandDevice(this.deviceTemplate) : undefined),
        password: async () => (await context.secrets.get(passwordKey(profile.name, profile.host))) ?? (await context.secrets.get(passwordKey('', profile.host))),
        log: (message) => this.output.appendLine(`[${label}] ${message}`),
      });
    }

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) TerminalPanel.setActive(this);
        else if (TerminalPanel.active === this) TerminalPanel.setActive(undefined);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tn5250')) {
          this.keyOverlay = vscode.workspace.getConfiguration('tn5250').get<boolean>('debug.keyOverlay', false);
          this.pushConfig();
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    context.subscriptions.push(panel);
    if (panel.active) TerminalPanel.setActive(this);
  }

  get title(): string {
    return this.panel.title;
  }

  get sessionLetter(): string {
    return this.letter;
  }

  private refreshTitle(): void {
    if (this.profile) this.panel.title = buildTitle(this.liveSettings(), this.letter);
  }

  /** The profile's connection values with the live appearance/behavior settings. */
  private liveSettings(): TerminalSettings {
    let settings = readDefaults();
    if (this.profile) {
      const saved = resolvedSessions().find((s) => s.name === this.profile?.name && s.host === this.profile?.host);
      const live = saved ?? settings;
      settings = { ...live, host: this.profile.host, port: this.profile.port, tls: this.profile.tls, name: this.profile.name,
        screenSize: this.profile.screenSize, codePage: this.profile.codePage, deviceName: this.profile.deviceName };
    }
    return settings;
  }

  get connected(): boolean {
    return this.controller?.connected ?? false;
  }

  connect(): void {
    void this.controller?.connect();
  }

  disconnect(): void {
    this.controller?.disconnect();
  }

  screenText(): string | undefined {
    return this.controller?.screenText();
  }

  exportTrace(): Record<string, unknown> | undefined {
    return this.controller?.exportTrace();
  }

  /** Demo screen only (no session): flips between 24x80 and 27x132. */
  toggleScreenSize(): void {
    if (this.controller) return;
    if (this.cols === 80) {
      this.rows = 27;
      this.cols = 132;
    } else {
      this.rows = 24;
      this.cols = 80;
    }
    this.pushDemoScreen();
  }

  toggleKeyOverlay(): void {
    this.keyOverlay = !this.keyOverlay;
    this.pushConfig();
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  /** Appearance and keyboard follow the live settings; connection values stay as the tab was opened. */
  private pushConfig(): void {
    const settings = this.liveSettings();
    this.refreshTitle();
    void this.loadWatermark(settings).then((watermarkImageData) => {
      this.post({ type: 'config', config: { settings, keyOverlay: this.keyOverlay, watermarkImageData } });
    });
  }

  private async loadWatermark(settings: TerminalSettings): Promise<string | undefined> {
    const file = settings.watermarkImage.trim();
    if (settings.watermarkType !== 'image' || !file) return undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      const ext = path.extname(file).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext || 'png'}`;
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch (err) {
      this.output.appendLine(`watermark image not readable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private pushDemoScreen(): void {
    this.post({ type: 'screen', screen: buildDemoScreen(this.rows, this.cols) });
    this.post({ type: 'oia', oia: { ...DEFAULT_OIA, message: `${this.rows}x${this.cols}` } });
  }

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.pushConfig();
        if (this.controller) {
          this.controller.publish();
          if (this.profile?.autoConnect !== false) void this.controller.connect();
        } else {
          this.pushDemoScreen();
        }
        break;
      case 'action':
        this.controller?.press(msg.action);
        break;
      case 'text':
        this.controller?.type(msg.text);
        break;
      case 'click':
        this.controller?.setCursor(msg.row, msg.col);
        break;
      case 'copy':
        void vscode.env.clipboard.writeText(msg.text);
        break;
      case 'printScreen':
        void vscode.commands.executeCommand('tn5250.printScreen');
        break;
      case 'openUrl':
        if (/^https?:\/\//i.test(msg.url)) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'key':
        if (this.keyOverlay) {
          const m = msg.event;
          const mods = [m.ctrl && 'Ctrl', m.shift && 'Shift', m.alt && 'Alt', m.meta && 'Meta'].filter(Boolean).join('+');
          this.output.appendLine(`key ${mods ? mods + '+' : ''}${m.key} (${m.code})`);
        }
        break;
      case 'log':
        this.output.appendLine(msg.message);
        break;
    }
  }

  private dispose(): void {
    TerminalPanel.open.delete(this);
    TerminalPanel.letters.delete(this.letter);
    if (TerminalPanel.active === this) TerminalPanel.setActive(undefined);
    this.controller?.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
