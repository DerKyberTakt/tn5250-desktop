import { buildDemoScreen } from '../engine/demoScreen';
import { SessionController } from '../extension/sessionController';
import { expandDeviceName } from '../shared/deviceName';
import type { KeyAction } from '../shared/keymap';
import { DEFAULT_OIA, type ConnectionStatus, type HostToWebview, type WebviewToHost } from '../shared/protocol';
import { buildTitle, type TerminalSettings } from '../shared/settings';
import { errorText, goApp, type SystemInfo } from './bridge';
import { GoTransport } from './goTransport';
import type { Credentials } from './credentials';
import type { Store } from './store';

/** What a tab needs from the shell around it. */
export interface TabHost {
  readonly store: Store;
  readonly credentials: Credentials;
  readonly system: SystemInfo;
  log(line: string): void;
  changed(tab: TerminalTab): void;
  printScreen(tab: TerminalTab): void;
  notify(text: string): void;
}

/** Tabs opened per device-name template, so * and = produce distinct names. */
const deviceOrdinals = new Map<string, number>();
/** Session letters in use (ACS: A, B, C ...). */
const letters = new Set<string>();

function nextLetter(): string {
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    if (!letters.has(l)) {
      letters.add(l);
      return l;
    }
  }
  return String(letters.size + 1);
}

function expandDevice(template: string, system: SystemInfo): string {
  const ordinal = deviceOrdinals.get(template) ?? 0;
  deviceOrdinals.set(template, ordinal + 1);
  return expandDeviceName(template, { computerName: system.computerName, userName: system.userName, ordinal });
}

/** One terminal tab: a frame running the canvas terminal plus (optionally) a live session. */
export class TerminalTab {
  readonly frame: HTMLIFrameElement;
  readonly letter: string;
  readonly profile: TerminalSettings | undefined;
  status: ConnectionStatus = 'idle';
  statusDetail = '';
  title: string;

  private readonly controller: SessionController | undefined;
  private readonly deviceTemplate: string;
  private rows = 24;
  private cols = 80;
  private keyOverlay = false;

  constructor(
    private readonly host: TabHost,
    profile: TerminalSettings | undefined,
  ) {
    let deviceTemplate = '';
    if (profile?.deviceName.trim()) {
      deviceTemplate = profile.deviceName.trim();
      profile = { ...profile, deviceName: expandDevice(deviceTemplate, host.system) };
    }
    this.deviceTemplate = deviceTemplate;
    this.profile = profile;
    this.letter = profile ? nextLetter() : '';
    this.title = profile ? buildTitle(profile, this.letter) : 'Demo screen';

    this.frame = document.createElement('iframe');
    this.frame.className = 'terminal-frame';
    this.frame.src = 'terminal.html';
    this.frame.title = this.title;

    if (profile) {
      this.rows = profile.screenSize === '27x132' ? 27 : 24;
      this.cols = profile.screenSize === '27x132' ? 132 : 80;
      const label = profile.name || profile.host;
      this.controller = new SessionController(
        profile,
        {
          screen: (screen, oia) => {
            this.post({ type: 'screen', screen });
            this.post({ type: 'oia', oia });
          },
          status: (status, detail, info) => {
            this.status = status;
            this.statusDetail = detail;
            this.post({ type: 'status', status, detail, info });
            host.log(`[${label}] ${status}: ${detail}`);
            host.changed(this);
          },
          alarm: () => this.post({ type: 'alarm' }),
          nextDeviceName: () => (/[*=]/.test(this.deviceTemplate) ? expandDevice(this.deviceTemplate, host.system) : undefined),
          password: async () => (await host.credentials.find(profile.signonUser, profile.host, profile.name)) || undefined,
          log: (message) => host.log(`[${label}] ${message}`),
        },
        (events) => new GoTransport(events),
      );
    }
  }

  get connected(): boolean {
    return this.controller?.connected ?? false;
  }

  get isDemo(): boolean {
    return !this.controller;
  }

  connect(): void {
    void this.controller?.connect();
  }

  disconnect(): void {
    this.controller?.disconnect();
  }

  press(action: KeyAction): void {
    this.controller?.press(action);
  }

  screenText(): string | undefined {
    return this.controller?.screenText();
  }

  exportTrace(): Record<string, unknown> | undefined {
    return this.controller?.exportTrace();
  }

  /** Copies the selection (or the whole screen) to the clipboard. */
  copy(): void {
    this.post({ type: 'copySelection' });
  }

  /** Pastes the clipboard text at the cursor, honouring the paste settings. */
  paste(): void {
    void goApp()
      .ClipboardGet()
      .then((text) => this.post({ type: 'paste', text }))
      .catch((err: unknown) => this.host.log(`clipboard: ${errorText(err)}`));
  }

  focus(): void {
    this.frame.focus();
    this.frame.contentWindow?.focus();
  }

  toggleKeyOverlay(): void {
    this.keyOverlay = !this.keyOverlay;
    this.pushConfig();
  }

  /** Demo screen only (no session): flips between 24x80 and 27x132. */
  toggleScreenSize(): void {
    if (this.controller) return;
    [this.rows, this.cols] = this.cols === 80 ? [27, 132] : [24, 80];
    this.pushDemoScreen();
  }

  dispose(): void {
    letters.delete(this.letter);
    this.controller?.dispose();
    this.frame.remove();
  }

  /** The profile's connection values with the live appearance/behaviour settings. */
  private liveSettings(): TerminalSettings {
    let settings = this.host.store.readDefaults();
    if (this.profile) {
      const p = this.profile;
      const saved = this.host.store.resolvedSessions().find((s) => s.name === p.name && s.host === p.host);
      settings = { ...(saved ?? settings), host: p.host, port: p.port, tls: p.tls, name: p.name, screenSize: p.screenSize, codePage: p.codePage, deviceName: p.deviceName };
    }
    return settings;
  }

  /** Appearance and keyboard follow the live settings; connection values stay as the tab was opened. */
  pushConfig(): void {
    const settings = this.liveSettings();
    if (this.profile) {
      const title = buildTitle(settings, this.letter);
      if (title !== this.title) {
        this.title = title;
        this.frame.title = title;
        this.host.changed(this);
      }
    }
    void this.loadWatermark(settings).then((watermarkImageData) => {
      this.post({ type: 'config', config: { settings, keyOverlay: this.keyOverlay, watermarkImageData } });
    });
  }

  private async loadWatermark(settings: TerminalSettings): Promise<string | undefined> {
    const file = settings.watermarkImage.trim();
    if (settings.watermarkType !== 'image' || !file) return undefined;
    try {
      return await goApp().ImageDataURL(file);
    } catch (err) {
      this.host.log(`watermark image not readable: ${errorText(err)}`);
      return undefined;
    }
  }

  private pushDemoScreen(): void {
    this.post({ type: 'screen', screen: buildDemoScreen(this.rows, this.cols) });
    this.post({ type: 'oia', oia: { ...DEFAULT_OIA, message: `${this.rows}x${this.cols}` } });
  }

  private post(message: HostToWebview): void {
    this.frame.contentWindow?.postMessage(message, location.origin && location.origin !== 'null' ? location.origin : '*');
  }

  handle(msg: WebviewToHost): void {
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
        void goApp().ClipboardSet(msg.text);
        break;
      case 'reconnect':
        this.controller?.reconnectNow();
        break;
      case 'cancelReconnect':
        this.controller?.disconnect();
        break;
      case 'paste':
        this.paste();
        break;
      case 'printScreen':
        this.host.printScreen(this);
        break;
      case 'openUrl':
        if (/^https?:\/\//i.test(msg.url)) void goApp().OpenURL(msg.url);
        break;
      case 'key':
        if (this.keyOverlay) {
          const m = msg.event;
          const mods = [m.ctrl && 'Ctrl', m.shift && 'Shift', m.alt && 'Alt', m.meta && 'Meta'].filter(Boolean).join('+');
          this.host.log(`key ${mods ? mods + '+' : ''}${m.key} (${m.code})`);
        }
        break;
      case 'log':
        this.host.log(msg.message);
        break;
    }
  }
}
