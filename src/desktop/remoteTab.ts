/**
 * One terminal tab in a visible window: the frame running the canvas terminal, fed by a
 * session that lives in the broker window (src/desktop/broker.ts). Keystrokes go to the
 * broker, screens come back; copy, paste, print, links and logs stay in this window. A tab
 * without a profile is the demo screen and needs no broker.
 */
import { buildDemoScreen } from '../engine/demoScreen';
import type { KeyAction } from '../shared/keymap';
import type { Macro, MacroRecorder } from '../shared/macros';
import { DEFAULT_OIA, type ConnectionStatus, type HostToWebview, type OiaState, type ScreenSnapshot, type WebviewToHost } from '../shared/protocol';
import { buildTitle, type TerminalSettings } from '../shared/settings';
import { errorText, goApp, relay, type SystemInfo } from './bridge';
import type { Credentials } from './credentials';
import { InputQueue, isSessionInput, newTabId, snapshotText, type ToWindow } from './relay';
import type { Store } from './store';

/** What a tab needs from the shell around it. */
export interface TabHost {
  readonly store: Store;
  readonly credentials: Credentials;
  readonly system: SystemInfo;
  /** The name of this window (the broker addresses it by that). */
  readonly windowName: string;
  log(line: string): void;
  changed(tab: TerminalTab): void;
  printScreen(tab: TerminalTab): void;
  notify(text: string): void;
  /** Opens the Settings tab (select = index of the session to show, -1 for the defaults). */
  openSettings(select?: number): void;
  /** The keys bound to macros (keyName form), for the page to report instead of handling. */
  macroKeys(): string[];
  /** The macro bound to a key the page reported, if any. */
  macroForKey(key: string): Macro | undefined;
  /** Plays a macro into the tab. */
  /** fromKey: the macro's shortcut key was pressed (pressed again while it runs, it stops the macro). */
  runMacro(macro: Macro, tab: TerminalTab, fromKey?: boolean): void;
}

/** A tab handed over from another window: what the broker told us about it. */
export interface AdoptedTab {
  id: string;
  letter: string;
  /** The session's profile as the broker holds it (workstation name expanded). */
  profile: TerminalSettings;
  deviceTemplate: string;
  status: ConnectionStatus;
  detail: string;
}

export class TerminalTab {
  readonly frame: HTMLIFrameElement;
  /** The broker's id for this session ('' for the demo screen). */
  readonly id: string;
  letter = '';
  readonly profile: TerminalSettings | undefined;
  status: ConnectionStatus = 'idle';
  statusDetail = '';
  title: string;
  /** The Workstation ID template this tab was opened with ('' = assigned by the host). */
  deviceTemplate = '';

  private rows = 24;
  private cols = 80;
  private keyOverlay = false;
  private lastScreen: ScreenSnapshot | undefined;
  private oia: OiaState = DEFAULT_OIA;
  /** Set while a macro is being recorded: every key and text the frame sends goes into it. */
  recorder: MacroRecorder | undefined;
  /** Inputs the frame sent before the broker acknowledged the session. */
  private pending: WebviewToHost[] | undefined = [];
  private readonly traces = new Map<string, (trace: Record<string, unknown> | undefined) => void>();
  private traceCounter = 0;
  /** Set while the tab is being handed to another window: dispose() must not close the session. */
  private handedOver = false;

  constructor(
    private readonly host: TabHost,
    profile: TerminalSettings | undefined,
    adopt?: AdoptedTab,
  ) {
    this.profile = profile;
    this.id = profile ? (adopt?.id ?? newTabId(host.windowName)) : '';
    this.title = profile ? buildTitle(profile, adopt?.letter ?? '') : 'Demo screen';

    this.frame = document.createElement('iframe');
    this.frame.className = 'terminal-frame';
    this.frame.src = 'terminal.html';
    this.frame.title = this.title;

    if (profile) {
      this.rows = profile.screenSize === '27x132' ? 27 : 24;
      this.cols = profile.screenSize === '27x132' ? 132 : 80;
      if (adopt) {
        this.opened(adopt);
        // The session is live already; the frame asks for the screen with 'ready'.
      } else {
        void relay('broker', { type: 'tab:open', tab: this.id, window: host.windowName, profile }).catch((err: unknown) => host.log(`session not opened: ${errorText(err)}`));
      }
    }
  }

  /** The broker created (or handed over) the session. */
  private opened(info: Omit<AdoptedTab, 'id'>): void {
    if (!this.profile) return;
    this.letter = info.letter;
    Object.assign(this.profile, info.profile);
    this.deviceTemplate = info.deviceTemplate;
    this.status = info.status;
    this.statusDetail = info.detail;
    this.title = buildTitle(this.profile, this.letter);
    this.frame.title = this.title;
    const pending = this.pending;
    this.pending = undefined;
    for (const m of pending ?? []) this.forward(m);
    this.host.changed(this);
  }

  /** A message from the broker about this tab. */
  receive(msg: ToWindow): void {
    switch (msg.type) {
      case 'tab:opened':
        this.opened(msg);
        break;
      case 'tab:output':
        if (msg.msg.type === 'screen') this.lastScreen = msg.msg.screen;
        if (msg.msg.type === 'oia') this.oia = msg.msg.oia;
        this.post(msg.msg);
        break;
      case 'tab:state':
        this.status = msg.status;
        this.statusDetail = msg.detail;
        this.host.changed(this);
        break;
      case 'tab:log':
        this.host.log(msg.line);
        break;
      case 'tab:notify':
        this.host.notify(msg.text);
        break;
      case 'tab:trace': {
        const done = this.traces.get(msg.request);
        this.traces.delete(msg.request);
        done?.(msg.trace);
        break;
      }
      case 'tab:gone':
        this.status = 'disconnected';
        this.statusDetail = 'session closed';
        this.host.changed(this);
        break;
      default:
        break;
    }
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  get isDemo(): boolean {
    return !this.profile;
  }

  connect(): void {
    this.forward({ type: 'reconnect' });
  }

  disconnect(): void {
    this.forward({ type: 'cancelReconnect' });
  }

  /** Connection settings saved while the tab is open (Save & Reload): new values, reconnect. */
  reload(profile: TerminalSettings): void {
    if (!this.profile) return;
    Object.assign(this.profile, profile);
    this.rows = this.profile.screenSize === '27x132' ? 27 : 24;
    this.cols = this.profile.screenSize === '27x132' ? 132 : 80;
    this.pushConfig();
    void relay('broker', { type: 'tab:reload', tab: this.id, profile: this.profile }).catch(() => undefined);
  }

  press(action: KeyAction): void {
    this.forward({ type: 'action', action });
  }

  /** Types text at the cursor, as the keyboard would. */
  type(text: string): void {
    this.forward({ type: 'text', text });
  }

  /** True while the host accepts keystrokes (connected, keyboard not locked). */
  inputAllowed(): boolean {
    return this.connected && this.oia.inputInhibited === 'none';
  }

  /** The page reported a macro key (config.macroKeys). */
  private macroKey(key: string): void {
    if (!this.profile) return;
    const macro = this.host.macroForKey(key);
    if (macro) this.host.runMacro(macro, this, true);
    else this.host.log(`no macro on ${key}`);
  }

  /** The current screen as text, from the last snapshot the broker sent. */
  screenText(): string | undefined {
    if (!this.profile) return undefined;
    return this.lastScreen ? snapshotText(this.lastScreen) : '';
  }

  /** The session's byte trace (tn5250-trace-*.json), fetched from the broker. */
  exportTrace(): Promise<Record<string, unknown> | undefined> {
    if (!this.profile) return Promise.resolve(undefined);
    const request = `trace-${++this.traceCounter}`;
    return new Promise((resolve) => {
      this.traces.set(request, resolve);
      void relay('broker', { type: 'tab:trace', tab: this.id, request }).catch(() => {
        this.traces.delete(request);
        resolve(undefined);
      });
      setTimeout(() => {
        if (this.traces.delete(request)) resolve(undefined);
      }, 5000);
    });
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
    // The page focuses its terminal element itself; a hidden frame cannot take focus at
    // load time, so an activated tab is told again.
    this.post({ type: 'focus' });
  }

  toggleKeyOverlay(): void {
    this.keyOverlay = !this.keyOverlay;
    this.pushConfig();
  }

  /** Demo screen only (no session): flips between 24x80 and 27x132. */
  toggleScreenSize(): void {
    if (this.profile) return;
    [this.rows, this.cols] = this.cols === 80 ? [27, 132] : [24, 80];
    this.pushDemoScreen();
  }

  /** The tab moves to another window: the frame goes, the session stays with the broker. */
  handOver(): void {
    this.handedOver = true;
  }

  dispose(): void {
    if (this.profile && !this.handedOver) void relay('broker', { type: 'tab:close', tab: this.id }).catch(() => undefined);
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
      this.post({ type: 'config', config: { settings, keyOverlay: this.keyOverlay, host: 'desktop', watermarkImageData, macroKeys: this.profile ? this.host.macroKeys() : [] } });
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

  /** Sends a session input to the broker, holding it until the session exists. */
  /** Keystrokes go to the broker in order, one message per tick (see InputQueue). */
  private readonly inputs = new InputQueue<WebviewToHost>(
    (msgs) => relay('broker', msgs.length === 1 ? { type: 'tab:input', tab: this.id, msg: msgs[0] as WebviewToHost } : { type: 'tab:inputs', tab: this.id, msgs }),
    (err: unknown) => this.host.log(`session input lost: ${errorText(err)}`),
  );

  private forward(msg: WebviewToHost): void {
    if (!this.profile) return;
    if (this.pending) {
      this.pending.push(msg);
      return;
    }
    this.inputs.push(msg);
  }

  /** A message from the terminal frame. */
  handle(msg: WebviewToHost): void {
    if (msg.type === 'ready') {
      this.pushConfig();
      if (this.profile) this.forward(msg);
      else this.pushDemoScreen();
      return;
    }
    if (isSessionInput(msg)) {
      if (this.recorder) {
        if (msg.type === 'text') this.recorder.text(msg.text);
        else if (msg.type === 'action') this.recorder.key(msg.action);
      }
      this.forward(msg);
      return;
    }
    switch (msg.type) {
      case 'copy':
        void goApp().ClipboardSet(msg.text);
        break;
      case 'paste':
        this.paste();
        break;
      case 'printScreen':
        this.host.printScreen(this);
        break;
      case 'macro':
        this.macroKey(msg.key);
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
      default:
        break;
    }
  }
}
