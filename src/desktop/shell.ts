import type { KeyAction } from '../shared/keymap';
import type { WebviewToHost } from '../shared/protocol';
import { resolveSettings, type TerminalSettings } from '../shared/settings';
import type { SettingsToHost } from '../shared/settingsProtocol';
import { brokerIsReady, errorText, goApp, onLaunchArgs, onRelay, relay, relayNow, wailsRuntime, type SqlConnectRequest, type SystemInfo, type UpdateInfo } from './bridge';
import { Credentials } from './credentials';
import { checkListDialog, choiceDialog, confirmDialog, formDialog, iconListDialog, listDialog, messageDialog, promptDialog } from './dialogs';
import { APP_ICON, ICONS, type IconName } from './icons';
import { placeAround, play, reducedMotion, snapshot } from './flip';
import { IfsTab, type IfsHost } from './ifsTab';
import { installTitleBar, type TitleBar } from './titlebar';
import { BUILT_IN, applyThemeVars, findTheme, parseTheme, themeToJson, type Theme } from './themes';
import { themeEditorDialog } from './themeEditor';
import { IfsViewTab, type IfsViewHost } from './ifsViewTab';
import { SettingsTab } from './settingsTab';
import { ConsoleTab, type ConsoleHost, type ConsoleMode } from './consoleTab';
import { SqlTab, type SqlHost } from './sqlTab';
import { Store, type AppTheme } from './store';
import { MAIN_WINDOW, windowNameFromUrl, type RegistryEntry, type ToWindow } from './relay';
import { TerminalTab, type TabHost } from './remoteTab';
import { buildTree, tabsBadge } from './sessionTree';
import { TabDrag, reorder, type Point } from './tabDrag';
import { ACS_EMULATOR_DIR, HOD_FILTERS, importMessage, importRows, mergeImported, nothingImported, readProfiles, unreadableNote, type FoundSession } from './importConnections';
import { watchRecording, MacroRecorder, describeStep, macrosFromJson, macrosToJson, mergeMacros, newMacroId, runMacro, type Macro, type MacroTarget } from '../shared/macros';
import { macroEditorDialog } from './macroEditor';

const APP_NAME = 'TN5250 Terminal';
const PROJECT_URL = 'https://github.com/DerKyberTakt/tn5250-desktop';
const LOG_LIMIT = 1000;
/** While the app stays open, look for a new release once a day. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Entry =
  | { kind: 'terminal'; tab: TerminalTab; button: HTMLElement }
  | { kind: 'settings'; tab: SettingsTab; button: HTMLElement }
  | { kind: 'ifs'; tab: IfsTab; button: HTMLElement }
  | { kind: 'ifsview'; tab: IfsViewTab; button: HTMLElement }
  | { kind: 'sql'; tab: SqlTab; button: HTMLElement }
  | { kind: 'console'; tab: ConsoleTab; button: HTMLElement };

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "host", "host:port" or "[v6]:port". */
export function parseHostInput(input: string, defaultPort: number): { host: string; port: number } | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) return undefined;
  const host = (m[1] as string).replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

class Shell implements TabHost, IfsHost, IfsViewHost, SqlHost, ConsoleHost {
  readonly store = new Store();
  readonly credentials = new Credentials(this.store);
  system: SystemInfo = { computerName: '', userName: '', platform: '' };
  /** This window's name; the broker addresses it by that (main, or win-N). */
  readonly windowName = windowNameFromUrl(location.search);
  /** Every session in every window, as the broker reports it. */
  private registry: RegistryEntry[] = [];

  private entries: Entry[] = [];
  private active: Entry | undefined;
  private readonly drag = new TabDrag<Entry>({
    bar: byId<HTMLDivElement>('tabbar'),
    buttonOf: (e) => e.button,
    items: () => this.entries,
    detachable: (e) => e.kind === 'terminal' && !e.tab.isDemo,
    windows: () => goApp().WindowList().then((w) => w ?? []),
    windowName: windowNameFromUrl(location.search),
    onLiveReorder: (e, to) => this.liveReorder(e, to),
    onReorder: (e, to) => this.reorderTab(e, to),
    onDetach: (e, origin) => void this.detachTab(e, origin),
    onMerge: (e, window, at) => void this.mergeTab(e, window, at),
    splash: (p, kind) => this.splash(p, kind),
    ghost: {
      prepare: () => void goApp().GhostPrepare().catch(() => undefined),
      show: (label, x, y) => void goApp().GhostShow(label, Math.round(x), Math.round(y)).catch((err: unknown) => this.log(`ghost: ${errorText(err)}`)),
      // At most one move per frame: the binding call is cheap but not free.
      move: (x, y) => {
        this.ghostAt = { x, y };
        if (this.ghostFrame) return;
        this.ghostFrame = requestAnimationFrame(() => {
          this.ghostFrame = undefined;
          if (this.ghostAt) void goApp().GhostMove(Math.round(this.ghostAt.x), Math.round(this.ghostAt.y)).catch(() => undefined);
        });
      },
      hide: () => {
        this.ghostAt = undefined;
        void goApp().GhostHide().catch(() => undefined);
      },
    },
    log: (line) => this.log(line),
  });
  private ghostAt: Point | undefined;
  private ghostFrame: number | undefined;
  private selectedSession = -1;
  /** The administrator's session selected in the panel (by name), when no own session is. */
  private selectedManaged = '';
  private readonly logLines: string[] = [];
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly tabbar = byId<HTMLDivElement>('tabbar');
  /** The page's own title bar when the window is frameless; undefined with a system frame. */
  private titleBar: TitleBar | undefined;
  /** The user's and the administrator's theme files (built-ins are in themes.ts). */
  private themes: Theme[] = [];
  private readonly frames = byId<HTMLElement>('frames');
  private readonly empty = byId<HTMLDivElement>('empty');
  private readonly sidebar = byId<HTMLElement>('sidebar');
  private toolbarItems: Array<{ button: HTMLButtonElement; enabled?: () => boolean; pressed?: () => boolean }> = [];
  private updateButton?: HTMLButtonElement;
  private updateInfo?: UpdateInfo;
  private updating = false;
  private readonly sessionList = byId<HTMLUListElement>('sessions');
  private readonly logEl = byId<HTMLPreElement>('log');
  private readonly logPane = byId<HTMLElement>('logpane');
  private readonly statusBar = byId<HTMLElement>('statusbar');
  private readonly statusText = byId<HTMLButtonElement>('status-text');
  private readonly statusRight = byId<HTMLSpanElement>('status-right');
  private readonly statusRec = byId<HTMLSpanElement>('status-rec');
  /** The tab a macro is being recorded in. */
  private recordingTab: TerminalTab | undefined;
  /** Stops the forgotten-recording guard (reminder every 5 min, end after 5 idle min). */
  private recordingWatch: (() => void) | undefined;
  /** Record from here: the macro being edited and where the recorded steps go. */
  private recordInto: { macro: Macro; insertAt: number } | undefined;
  /** The macro playing right now, and how to stop it. */
  private macroRun: { macro: Macro; tab: TerminalTab; stop: AbortController; byKey: boolean } | undefined;

  async start(): Promise<void> {
    try {
      await this.store.load();
      await this.loadThemes();
    } catch (err) {
      this.log(`settings file not readable, starting with defaults: ${errorText(err)}`);
    }
    if (this.store.managedError) this.log(`company settings file ${this.store.managedError} (Help > Settings File Location)`);
    try {
      this.system = await goApp().SystemInfo();
    } catch (err) {
      this.log(`system info: ${errorText(err)}`);
    }
    this.applyTheme();
    this.store.onChange(() => this.storeChanged(true));
    this.buildMenus();
    void this.installTitleBar();
    this.buildToolbar();
    this.bindSidebar();
    this.statusText.addEventListener('click', () => this.toggleLog());
    byId<HTMLButtonElement>('log-close').addEventListener('click', () => this.toggleLog(false));
    this.renderSessions();
    window.addEventListener('message', (ev) => this.onFrameMessage(ev));
    try {
      onRelay((msg) => this.onRelay(msg as ToWindow));
      void relayNow('broker', { type: 'window:hello', window: this.windowName }).catch(() => undefined);
    } catch {
      // not running inside the app
    }
    try {
      // Files dropped on the window go to the IFS browser tab that is showing.
      wailsRuntime().OnFileDrop((_x, _y, paths) => {
        if (this.active?.kind === 'ifs') void this.active.tab.upload(paths);
        else this.notify('Open Tools > Integrated File System to upload files by dropping them');
      }, false);
    } catch {
      // not running inside the app
    }
    document.addEventListener('keydown', (ev) => this.onShellKey(ev));
    this.refresh();
    await this.openFromCommandLine();
    void this.quietUpdateCheck();
    setInterval(() => void this.quietUpdateCheck(), UPDATE_CHECK_INTERVAL_MS);
  }

  // --- updates (app_update.go: GitHub Releases, verified against SHA256SUMS) ---

  /** Startup / daily check: only lights up the toolbar button, never interrupts. */
  private async quietUpdateCheck(): Promise<void> {
    if (!this.store.checkForUpdates || this.updating) return;
    try {
      this.updateInfo = await goApp().UpdateCheck();
      this.updateToolbar();
    } catch (err) {
      this.log(`update check: ${errorText(err)}`);
    }
  }

  private async checkForUpdates(): Promise<void> {
    if (this.updating) return;
    const title = 'Check for Updates';
    let info: UpdateInfo;
    try {
      this.notify('Checking for updates…');
      info = await goApp().UpdateCheck();
    } catch (err) {
      await messageDialog(title, [`Could not check for updates: ${errorText(err)}`, `${PROJECT_URL}/releases`]);
      return;
    }
    this.updateInfo = info;
    this.updateToolbar();
    this.refresh();
    if (!info.latest) {
      await messageDialog(title, [`No release has been published yet. You have version ${info.current}.`]);
      return;
    }
    if (!info.available) {
      await messageDialog(title, [`You have the latest version (${info.current}).`]);
      return;
    }
    const latest = versionOf(info.latest);
    if (info.mode === 'manual') {
      const open = await confirmDialog(`Version ${latest} is available`, `You have ${info.current}. ${info.reason ?? ''}`, 'Open release page');
      if (open) void goApp().OpenURL(info.page);
      return;
    }
    const sessions = this.entries.filter((e) => e.kind === 'terminal' && e.tab.connected).length;
    const warning = sessions ? ` ${sessions} open session${sessions > 1 ? 's' : ''} will be disconnected.` : '';
    const ok = await confirmDialog(
      `Version ${latest} is available`,
      `You have ${info.current}. ${APP_NAME} downloads the update from GitHub, checks it against the release's SHA256SUMS and restarts.${warning} What's new: ${info.page}`,
      'Update now',
    );
    if (!ok) return;
    this.updating = true;
    let off: (() => void) | undefined;
    try {
      off = wailsRuntime().EventsOn('update:progress', (p) => {
        const { done, total } = p as { done: number; total: number };
        const d = Number(done);
        const t = Number(total);
        this.notify(t > 0 ? `Downloading ${latest}… ${Math.floor((d * 100) / t)}%` : `Downloading ${latest}… ${(d / 1048576).toFixed(1)} MB`);
      });
      this.notify(`Downloading ${latest}…`);
      await goApp().UpdateInstall(info.latest);
      this.notify(`Restarting with ${latest}…`);
    } catch (err) {
      this.updating = false;
      await messageDialog('Update failed', [errorText(err), `You can download ${latest} from ${info.page}`]);
    } finally {
      off?.();
    }
  }

  /** `tn5250-terminal [--tls] host[:port]` opens an ad-hoc session (port 992 implies TLS); `--demo` opens the demo screen. */
  private async openFromCommandLine(): Promise<void> {
    let args: string[];
    try {
      args = await goApp().LaunchArgs();
      // A second launch of the exe hands its command line to this window.
      onLaunchArgs((more) => this.openFromArgs(more));
    } catch {
      return;
    }
    this.openFromArgs(args);
  }

  /** `tn5250-terminal [--tls] [--demo] host[:port]` opens that session. */
  private openFromArgs(args: string[]): void {
    if (args.includes('--demo')) this.openDemo();
    const tls = args.includes('--tls');
    const hostArg = args.find((a) => !a.startsWith('-'));
    if (!hostArg) return;
    const target = parseHostInput(hostArg, tls ? 992 : this.store.readDefaults().port);
    if (target) this.openSession(this.store.adHocSettings(target.host, target.port, tls || target.port === 992));
    else this.notify(`Not a host name: ${hostArg}`);
  }

  // --- TabHost ---

  log(line: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.logLines.push(`${stamp}  ${line}`);
    if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
    if (this.logOpen) {
      this.logEl.textContent = this.logLines.join('\n');
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  private get logOpen(): boolean {
    return this.logPane.classList.contains('open');
  }

  changed(tab: TerminalTab | IfsTab | IfsViewTab | SqlTab | ConsoleTab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (entry) this.renderTabButton(entry);
    if (this.active?.tab === tab) this.refresh();
    else this.syncSettingsTabs();
  }

  /** Settings pages show which open tabs a save would reload; tell them about every tab change. */
  private syncSettingsTabs(): void {
    for (const e of this.entries) if (e.kind === 'settings') e.tab.sendOpenTabs();
  }

  notify(text: string): void {
    this.log(text);
    this.statusText.textContent = text;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    // refresh() leaves the text alone while a notice is showing; clear the timer first or
    // the notice stays forever (the "Opened https://..." that never went away).
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.refresh();
    }, 5000);
  }

  printScreen(tab: TerminalTab): void {
    const text = tab.screenText();
    if (text === undefined) return;
    byId<HTMLPreElement>('print-area').textContent = text;
    window.print();
  }

  // --- sessions ---

  openSession(profile: TerminalSettings): void {
    const tab = new TerminalTab(this, profile);
    this.sidebar.hidden = true;
    this.addEntry({ kind: 'terminal', tab, button: el('div') }, profile.switchToNewTab || !this.active);
    // Only saved sessions count for "Connect to Previous"; quick connects and command-line hosts do not.
    const saved = this.store.resolvedSessions().some((s) => s.name === profile.name && s.host === profile.host);
    if (saved && profile.name) void this.store.setLastSession(profile.name).catch(() => undefined);
  }

  /** Tools > Integrated File System: signs on to the file server of the active (or selected) session's host. */
  /**
   * Opens an IFS browser. The password comes from the credential store when one is
   * saved (Remember password, or the session's bypass sign-on password); otherwise
   * a sign-on dialog asks. A refused sign-on never retries a stored password: the
   * remembered one is forgotten and the dialog shows why (the host may disable the
   * profile after the next failed attempt).
   */
  private async openIfs(retry?: { host: string; user: string; reason: string }): Promise<void> {
    const t = this.activeTerminal();
    const defaults = this.store.readDefaults();
    const base = t?.profile ?? this.pickedSession() ?? this.store.resolvedSessions()[0] ?? defaults;
    const last = this.store.ifsLast;
    let host = retry?.host ?? (base.host || last?.host || '');
    let user = retry?.user ?? (base.signonUser.trim() || (last?.host === host ? last.user : '') || '');
    let password = '';
    let fromStore = false;
    let remember = true;
    if (!retry && host && user) {
      password = await this.credentials.find(user, host, sameName(base, host));
      fromStore = !!password;
    }
    if (!host || !user || !password) {
      const values = await formDialog(
        'Integrated File System',
        [
          { label: 'Host', value: host, placeholder: 'myibmi.example.com' },
          { label: 'User profile', value: user },
          { label: 'Password', password: true },
          { label: 'Remember password (Windows Credential Manager)', checkbox: true, value: 'true' },
        ],
        'Connect',
        retry
          ? `${retry.reason}. Enter the password again.`
          : 'Signs on to the IBM i file server, as ACS does. A remembered password is kept in the operating system credential store, never in the settings file.',
      );
      if (!values) return;
      [host = '', user = '', password = ''] = values.slice(0, 3).map((v) => v.trim());
      remember = values[3] === 'true';
      fromStore = false;
      if (!host || !user || !password) {
        this.notify('Host, user profile and password are all needed');
        return;
      }
    }
    const sameHost = host === base.host;
    const typed = !fromStore;
    const tab = new IfsTab(
      this,
      {
        host,
        tls: sameHost ? base.tls : false,
        trustAnyCertificate: sameHost ? !base.verifyCertificate : false,
        user,
        password,
        timeoutMs: base.connectTimeoutSeconds * 1000,
      },
      (error) => {
        if (!error) {
          void this.store.setIfsLast(host, user);
          if (typed && remember) void this.credentials.save(user, host, password).catch(() => this.notify('Could not save the password'));
          return;
        }
        const reason = errorText(error);
        if (!/sign-on refused/i.test(reason)) return; // network problems: the tab offers Retry
        // Refused: never retry the same password. Forget a remembered one and ask again.
        if (fromStore) void this.credentials.remove(user, host, sameName(base, host));
        void this.close(entry);
        const why = fromStore
          ? `The saved password was refused and has been removed (${reason})`
          : `Sign-on refused (${reason.replace(/^sign-on refused:\s*/i, '')})`;
        void this.openIfs({ host, user, reason: why });
      },
    );
    // The sign-on callback runs after start(), so it can refer to this entry.
    const entry: Entry = { kind: 'ifs', tab, button: el('div') };
    this.addEntry(entry, true);
    void tab.start();
  }

  /** A file of an IFS browser, in its own tab (the same file twice just activates the tab). */
  openViewer(from: IfsTab, path: string, info: { size: number; modified: string }): void {
    const open = this.entries.find((e) => e.kind === 'ifsview' && e.tab.path === path && e.tab.sessionId === from.sessionId);
    if (open) {
      this.activate(open);
      return;
    }
    const tab = new IfsViewTab(this, from.sessionId, path, info);
    this.addEntry({ kind: 'ifsview', tab, button: el('div') }, true);
    void tab.load();
  }

  /** Tools > Saved Passwords: the USER@host passwords in the credential store. */
  private async managePasswords(): Promise<void> {
    for (;;) {
      const list = this.credentials.list();
      const choice = await listDialog(
        'Saved Passwords',
        'One password per user profile and host, kept in the operating system credential store (never in the settings file). Used by bypass sign-on, the IFS browser and the other tools.',
        list.map((c) => `${c.user}@${c.host}`),
        ['Change…', 'Remove'],
        ['Add…'],
        'No passwords saved yet.',
      );
      if (!choice) return;
      const c = choice.row >= 0 ? list[choice.row] : undefined;
      if (choice.action === 'Remove' && c) {
        if (await confirmDialog('Remove password', `Remove the saved password for ${c.user}@${c.host}?`, 'Remove')) await this.credentials.remove(c.user, c.host);
        continue;
      }
      const values = await formDialog(
        c ? `Change password for ${c.user}@${c.host}` : 'Add a password',
        [
          { label: 'Host', value: c?.host ?? '' },
          { label: 'User profile', value: c?.user ?? '' },
          { label: 'Password', password: true },
        ],
        'Save',
      );
      if (!values) continue;
      const [host = '', user = '', password = ''] = values.map((v) => v.trim());
      if (!host || !user || !password) {
        this.notify('Host, user profile and password are all needed');
        continue;
      }
      await this.credentials.save(user, host, password);
      if (c && (c.host !== host.toLowerCase() || c.user !== user.toUpperCase())) await this.credentials.remove(c.user, c.host);
    }
  }

  /**
   * Opens a Run SQL Scripts tab for the active session's host (or the selected / first
   * saved one), signing on with the saved password or asking once; a working typed
   * password is remembered when the box is ticked.
   */
  private async openSql(): Promise<void> {
    const s = await this.signonFor('Run SQL Scripts', 'Signs on to the IBM i database server, as ACS does.');
    if (!s) return;
    const tab = new SqlTab(this, s.request, s.onSignon);
    this.addEntry({ kind: 'sql', tab, button: el('div') }, true);
    void tab.start();
  }

  private async openConsole(mode: ConsoleMode): Promise<void> {
    const s = await this.signonFor(mode === 'qsh' ? 'QSH Console' : 'CL Console', 'Signs on to the IBM i remote command server, as ACS does.');
    if (!s) return;
    const tab = new ConsoleTab(this, s.request, mode, s.onSignon);
    this.addEntry({ kind: 'console', tab, button: el('div') }, true);
    void tab.start();
  }

  /**
   * Host, user and password for a host-server tool: the active session's (or the
   * selected / first saved one's) with the saved password, else a sign-on dialog. The
   * returned callback remembers a working typed password and forgets a refused saved one.
   */
  private async signonFor(title: string, note: string): Promise<{ request: SqlConnectRequest; onSignon: (error?: unknown) => void } | undefined> {
    const t = this.activeTerminal();
    const defaults = this.store.readDefaults();
    const base = t?.profile ?? this.pickedSession() ?? this.store.resolvedSessions()[0] ?? defaults;
    let host = base.host || this.store.ifsLast?.host || '';
    let user = base.signonUser.trim() || (this.store.ifsLast?.host === host ? this.store.ifsLast.user : '');
    let password = host && user ? await this.credentials.find(user, host, sameName(base, host)) : '';
    let remember = true;
    const typed = !password;
    if (!host || !user || !password) {
      const values = await formDialog(
        title,
        [
          { label: 'Host', value: host, placeholder: 'myibmi.example.com' },
          { label: 'User profile', value: user },
          { label: 'Password', password: true },
          { label: 'Remember password (Windows Credential Manager)', checkbox: true, value: 'true' },
        ],
        'Connect',
        `${note} A remembered password is kept in the operating system credential store, never in the settings file.`,
      );
      if (!values) return undefined;
      [host = '', user = '', password = ''] = values.slice(0, 3).map((v) => v.trim());
      remember = values[3] === 'true';
      if (!host || !user || !password) {
        this.notify('Host, user profile and password are all needed');
        return undefined;
      }
    }
    const sameHost = host === base.host;
    const request: SqlConnectRequest = {
      host,
      tls: sameHost ? base.tls : false,
      trustAnyCertificate: sameHost ? !base.verifyCertificate : false,
      user,
      password,
      timeoutMs: base.connectTimeoutSeconds * 1000,
      naming: 'sql',
      defaultSchema: '',
    };
    const onSignon = (error?: unknown): void => {
      if (!error) {
        void this.store.setIfsLast(host, user);
        if (typed && remember) void this.credentials.save(user, host, password).catch(() => this.notify('Could not save the password'));
        return;
      }
      if (!typed && /sign-on refused/i.test(errorText(error))) void this.credentials.remove(user, host, sameName(base, host));
    };
    return { request, onSignon };
  }

  private openDemo(): void {
    this.addEntry({ kind: 'terminal', tab: new TerminalTab(this, undefined), button: el('div') }, true);
  }

  openSettings(select = -1): void {
    const existing = this.entries.find((e) => e.kind === 'settings');
    if (existing && existing.kind === 'settings') {
      existing.tab.show(select);
      this.activate(existing);
      return;
    }
    this.addEntry({ kind: 'settings', tab: new SettingsTab(this, select), button: el('div') }, true);
  }

  private addEntry(entry: Entry, activate: boolean): void {
    this.entries.push(entry);
    this.syncSettingsTabs();
    entry.button.className = 'tab';
    entry.button.setAttribute('role', 'tab');
    entry.button.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        void this.close(entry);
      } else if (ev.button === 0) {
        ev.preventDefault(); // keep keyboard focus in the terminal frame
        this.activate(entry);
      }
    });
    this.tabbar.append(entry.button);
    if (entry.tab.frame instanceof HTMLIFrameElement) entry.tab.frame.addEventListener('load', () => this.applyThemeTo(entry.tab.frame));
    this.frames.append(entry.tab.frame);
    this.renderTabButton(entry);
    this.drag.attach(entry);
    if (activate) this.activate(entry);
    else this.refresh();
  }

  /**
   * A tab dragged past another one: the order changes right away and the other tabs slide
   * into their new places (FLIP); the dragged one stays under the pointer.
   */
  private liveReorder(entry: Entry, to: number): void {
    const from = this.entries.indexOf(entry);
    if (from < 0) return;
    const others = this.entries.filter((e) => e !== entry).map((e) => [e, e.button] as const);
    const before = snapshot(others);
    this.entries = reorder(this.entries, from, to);
    // The dragged button holds the pointer capture: the others move around it, it stays put.
    placeAround(this.tabbar, entry.button, this.entries.map((e) => e.button));
    play(others, before, entry);
  }

  /** A tab dropped within the bar: the order is already as shown; the rest of the app learns about it. */
  private reorderTab(entry: Entry, to: number): void {
    if (this.entries.indexOf(entry) !== to) this.liveReorder(entry, to);
    this.syncSettingsTabs();
  }

  /** Water-drop rings at a client point: the pointer crossing the edge, or a tab landing. */
  private splash(p: Point, kind: 'leave' | 'enter' | 'land'): void {
    if (reducedMotion()) return;
    const s = el('div', `splash ${kind}`);
    s.style.left = `${p.x}px`;
    s.style.top = `${p.y}px`;
    s.append(el('span'), el('span'), el('span'));
    document.body.append(s);
    setTimeout(() => s.remove(), 1000);
  }

  /** A screen point in this window's client coordinates (the frame's size is estimated). */
  private clientFromScreen(p: Point): Point {
    const frameX = (window.outerWidth - window.innerWidth) / 2;
    const frameY = window.outerHeight - window.innerHeight - frameX;
    return { x: p.x - window.screenX - frameX, y: p.y - window.screenY - frameY };
  }

  /** A tab dropped outside every window: a new window opens there and takes the session. */
  private async detachTab(entry: Entry, origin: Point): Promise<void> {
    const name = `win-${Date.now().toString(36)}`;
    try {
      await goApp().WindowOpen(name, APP_NAME, origin.x, origin.y, window.outerWidth, window.outerHeight);
    } catch (err) {
      this.notify(`Could not open a window: ${errorText(err)}`);
      return;
    }
    await this.moveTab(entry, name);
  }

  /** A tab dropped on another window of the app: that window takes the session and splashes where it landed. */
  private async mergeTab(entry: Entry, window: string, at?: Point): Promise<void> {
    await this.moveTab(entry, window, at);
    void goApp().WindowFocus(window).catch(() => undefined);
  }

  /** The tab a window just adopted lands like a drop: the blob relaxes into a tab, the bar ripples. */
  private dropIn(entry: Entry): void {
    entry.button.classList.add('drop-in');
    const ripple = el('span', 'ripple');
    entry.button.append(ripple);
    setTimeout(() => {
      entry.button.classList.remove('drop-in');
      ripple.remove();
    }, 700);
  }

  private renderTabButton(entry: Entry): void {
    const b = entry.button;
    b.replaceChildren();
    if (entry.kind === 'terminal') {
      const dot = el('span', `dot ${entry.tab.status}`);
      dot.title = entry.tab.statusDetail || entry.tab.status;
      b.append(dot);
    }
    const label = el('span', 'label', entry.tab.title);
    b.title = entry.tab.title;
    const close = el('button', 'close', '×');
    close.title = 'Close';
    close.addEventListener('mousedown', (ev) => ev.stopPropagation());
    close.addEventListener('click', () => void this.close(entry));
    b.append(label, close);
    b.classList.toggle('active', entry === this.active);
    b.setAttribute('aria-selected', String(entry === this.active));
  }

  private activate(entry: Entry): void {
    const previous = this.active;
    this.active = entry;
    for (const e of this.entries) {
      e.tab.frame.classList.toggle('active', e === entry);
      e.button.classList.toggle('active', e === entry);
      e.button.setAttribute('aria-selected', String(e === entry));
    }
    if (previous !== entry) entry.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.refresh();
    entry.tab.focus();
  }

  private async close(entry: Entry): Promise<void> {
    if (entry.kind === 'terminal' && entry.tab.connected) {
      const ok = await confirmDialog('Close session', `Disconnect and close "${entry.tab.title}"?`, 'Close');
      if (!ok) return;
    }
    if (entry.kind === 'sql' && entry.tab.isDirty) {
      const ok = await confirmDialog('Close script', 'The script has unsaved changes. Close anyway?', 'Close');
      if (!ok) return;
    }
    if (entry.kind === 'ifsview' && entry.tab.isDirty) {
      const ok = await confirmDialog('Close file', `${entry.tab.title.replace(/^● /, '')} has changes that are not saved to the host. Close anyway?`, 'Close');
      if (!ok) return;
    }
    this.removeEntry(entry);
  }

  /** Takes a tab out of this window (closed, or handed to another window). */
  private removeEntry(entry: Entry): void {
    const i = this.entries.indexOf(entry);
    if (i < 0) return;
    this.entries.splice(i, 1);
    entry.tab.dispose();
    entry.button.remove();
    this.drag.detach(entry);
    if (this.active === entry) {
      this.active = undefined;
      const next = this.entries[Math.min(i, this.entries.length - 1)];
      if (next) this.activate(next);
    }
    if (!this.entries.length) this.sidebar.hidden = false;
    this.refresh();
    this.focusActive();
  }

  /** Frameless window: the page draws the title bar around the menu bar (titlebar.ts). */
  private async installTitleBar(): Promise<void> {
    let info: { custom: boolean; platform: string };
    try {
      info = await goApp().FrameInfo();
    } catch {
      return; // tests, or an older host
    }
    const rt = wailsRuntime();
    this.titleBar = installTitleBar(byId<HTMLElement>('titlebar'), byId<HTMLElement>('menubar'), APP_ICON, info, {
      minimise: () => rt.WindowMinimise(),
      toggleMaximise: () => rt.WindowToggleMaximise(),
      close: () => rt.WindowClose(),
      isMaximised: () => rt.WindowIsMaximised(),
      onMaximised: (cb) => {
        rt.EventsOn('common:WindowMaximise', () => cb(true));
        rt.EventsOn('common:WindowUnMaximise', () => cb(false));
      },
    });
    this.titleBar?.setTitle(document.title);
  }

  /** View > Appearance: System / Light / Dark takes any theme off. */
  private async pickAppearance(theme: AppTheme): Promise<void> {
    await this.store.setThemeName(undefined);
    await this.store.setAppTheme(theme);
    this.applyTheme();
  }

  /** The theme in use, if any: a built-in or one of the files. */
  private get activeTheme(): Theme | undefined {
    return findTheme(this.store.themeName, this.themes);
  }

  private async loadThemes(): Promise<void> {
    try {
      const files = await goApp().ThemesList();
      this.themes = files.flatMap((f) => {
        const parsed = parseTheme(f.json);
        if (!parsed) {
          this.log(`theme file ${f.name}.json is not a theme`);
          return [];
        }
        for (const p of parsed.problems) this.log(`theme ${f.name}: ${p}`);
        return [{ ...parsed.theme, name: f.name, managed: f.managed }];
      });
    } catch (err) {
      this.log(`themes not loaded: ${errorText(err)}`);
    }
  }

  /**
   * View > Appearance / Theme: the theme's variables on the shell page and on every frame
   * (they share theme.css); with no theme, data-theme alone decides light or dark.
   */
  private applyTheme(): void {
    this.paintTheme(this.activeTheme);
  }

  private paintTheme(theme: Theme | undefined): void {
    this.paintThemeOn(document, theme);
    for (const e of this.entries) this.applyThemeTo(e.tab.frame, theme);
  }

  private paintThemeOn(doc: Document, theme: Theme | undefined): void {
    applyThemeVars(doc.documentElement, theme);
    if (!theme) setTheme(doc, this.store.appTheme);
  }

  private applyThemeTo(frame: HTMLElement, theme: Theme | undefined = this.activeTheme): void {
    if (!(frame instanceof HTMLIFrameElement)) return;
    try {
      const doc = frame.contentDocument;
      if (doc) this.paintThemeOn(doc, theme);
    } catch {
      // a frame of another origin (none today)
    }
  }

  /** View > Theme…: the list of themes with use / edit / delete, New, Import and Export on top. */
  private async themesDialog(): Promise<void> {
    for (;;) {
      await this.loadThemes();
      const all = [...BUILT_IN, ...this.themes];
      const current = this.store.themeName;
      const pick = await iconListDialog(
        'Themes',
        all.map((t) => `${t.name}   ${t.base}${t.builtin ? '   (built in)' : t.managed ? '   (company)' : ''}${t.name === current ? '   ✓ in use' : ''}`),
        [
          { id: 'use', label: 'Use this theme', icon: 'eye', tone: 'green' },
          { id: 'edit', label: 'Edit (a built-in or company theme is copied first)', icon: 'pencil', tone: 'yellow' },
          { id: 'delete', label: 'Delete', icon: 'trash', tone: 'red' },
        ],
        [
          { id: 'new', label: 'New theme (from the one in use)', icon: 'newPage', tone: 'blue' },
          { id: 'import', label: 'Import a theme file…', icon: 'importFile', tone: 'blue' },
          { id: 'export', label: 'Export the theme in use…', icon: 'exportFile', tone: 'blue' },
          { id: 'none', label: 'No theme: View > Appearance decides light or dark', icon: 'refresh', tone: 'blue' },
        ],
        'No themes yet.',
      );
      if (!pick) return;
      if (pick.row < 0) {
        if (pick.action === 'new') await this.editTheme({ ...(this.activeTheme ?? (BUILT_IN[1] as Theme)), name: 'My theme', builtin: false, managed: false });
        else if (pick.action === 'import') await this.importTheme();
        else if (pick.action === 'export') await this.exportTheme();
        else if (pick.action === 'none') {
          await this.store.setThemeName(undefined);
          this.applyTheme();
        }
        continue;
      }
      const t = all[pick.row];
      if (!t) continue;
      if (pick.action === 'use') {
        await this.store.setThemeName(t.name);
        this.applyTheme();
        this.notify(`Theme "${t.name}"`);
        return;
      }
      if (pick.action === 'edit') {
        if (t.builtin || t.managed) await this.editTheme({ ...t, name: `${t.name} (copy)`, builtin: false, managed: false });
        else await this.editTheme(t);
        continue;
      }
      if (pick.action === 'delete') {
        if (t.builtin || t.managed) {
          this.notify(t.builtin ? 'Built-in themes cannot be deleted' : 'Company themes are the administrator\'s');
          continue;
        }
        if (await confirmDialog('Delete theme', `Delete "${t.name}"?`, 'Delete')) {
          await goApp().ThemeDelete(t.name);
          if (current === t.name) {
            await this.store.setThemeName(undefined);
            this.applyTheme();
          }
        }
      }
    }
  }

  /** The colour editor, previewing on this window; a save writes the file and uses the theme. */
  private async editTheme(theme: Theme): Promise<void> {
    const taken = [...BUILT_IN, ...this.themes].map((t) => t.name).filter((n) => n !== theme.name);
    const result = await themeEditorDialog(theme, { preview: (t) => this.paintTheme(t), revert: () => this.applyTheme(), taken });
    if (!result) return;
    try {
      if (result.name !== theme.name && !theme.builtin && this.themes.some((t) => t.name === theme.name)) await goApp().ThemeDelete(theme.name);
      await goApp().ThemeSave(result.name, themeToJson(result));
      await this.loadThemes();
      await this.store.setThemeName(result.name);
      this.applyTheme();
      this.notify(`Theme "${result.name}" saved`);
    } catch (err) {
      this.notify(`Theme not saved: ${errorText(err)}`);
      this.applyTheme();
    }
  }

  private async importTheme(): Promise<void> {
    const app = goApp();
    const file = await app.PickFile('Import a theme', [{ name: 'Theme', patterns: '*.json' }, { name: 'All files', patterns: '*.*' }]);
    if (!file) return;
    const parsed = parseTheme(await app.ReadTextFile(file));
    if (!parsed) {
      await messageDialog('Import theme', ['That file is not a theme (it needs "vars" with colour variables).']);
      return;
    }
    const name = parsed.theme.name;
    await app.ThemeSave(name, themeToJson(parsed.theme));
    await this.loadThemes();
    this.notify(`Theme "${name}" imported${parsed.problems.length ? ` (${parsed.problems.length} value(s) replaced from the base)` : ''}`);
  }

  private async exportTheme(): Promise<void> {
    const t = this.activeTheme;
    if (!t) {
      this.notify('No theme is in use; pick one first');
      return;
    }
    const saved = await goApp().SaveTextFile('Export theme', `${t.name}.json`, themeToJson(t), [{ name: 'Theme', patterns: '*.json' }]);
    if (saved) this.notify(`Theme "${t.name}" exported`);
  }

  /** Keyboard focus back to the active tab (after menus, dialogs, closing tabs, hiding the panel). */
  private focusActive(): void {
    this.active?.tab.focus();
  }

  private activeTerminal(): TerminalTab | undefined {
    return this.active?.kind === 'terminal' ? this.active.tab : undefined;
  }

  private terminals(): TerminalTab[] {
    return this.entries.flatMap((e) => (e.kind === 'terminal' ? [e.tab] : []));
  }

  /** SettingsHost: the open terminal tabs with a session, for Save & Reload. */
  openTerminals(): Array<{ tab: TerminalTab; profile: TerminalSettings; deviceTemplate: string }> {
    return this.terminals().flatMap((tab) => (tab.profile ? [{ tab, profile: tab.profile, deviceTemplate: tab.deviceTemplate }] : []));
  }

  private refresh(): void {
    this.empty.hidden = this.entries.length > 0;
    // One tab needs no tab bar (the window title names it); it appears with the second tab,
    // or as soon as there is another window to drag the tab to.
    const windows = new Set(this.registry.map((t) => t.window)).add(this.windowName);
    this.tabbar.hidden = this.entries.length === 0 || (this.entries.length < 2 && windows.size < 2);
    const t = this.activeTerminal();
    const title = this.active ? `${this.active.tab.title} - ${APP_NAME}` : APP_NAME;
    document.title = title;
    this.titleBar?.setTitle(title);
    try {
      wailsRuntime().WindowSetTitle(title);
    } catch {
      // not running inside the app (tests)
    }
    if (!this.statusTimer) {
      this.statusText.textContent = t ? (t.isDemo ? 'Demo screen' : `${t.status}${t.statusDetail ? ': ' + t.statusDetail : ''}`) : 'Ready';
    }
    this.updateToolbar();
    const n = this.terminals().filter((x) => x.connected).length;
    this.statusRight.textContent = n ? `${n} connected` : '';
    this.syncSettingsTabs();
  }

  /** The session selected in the Connections panel, the user's own or the administrator's. */
  private pickedSession(): TerminalSettings | undefined {
    if (this.selectedSession >= 0) {
      const s = this.store.readSessions()[this.selectedSession];
      return s ? resolveSettings(this.store.readDefaults(), s) : undefined;
    }
    return this.selectedManaged ? this.store.managedSessions().find((s) => s.name === this.selectedManaged) : undefined;
  }

  private savedProfile(tab: TerminalTab): TerminalSettings | undefined {
    const p = tab.profile;
    if (!p) return undefined;
    return this.store.resolvedSessions().find((s) => s.name === p.name && s.host === p.host);
  }

  private duplicate(): void {
    const t = this.activeTerminal();
    if (!t?.profile) return;
    // A saved session re-expands its workstation template; an ad-hoc one reuses its values.
    this.openSession(this.savedProfile(t) ?? { ...t.profile, deviceName: '' });
  }

  private connectPrevious(): void {
    const last = this.store.lastSession;
    const profile = last ? this.store.resolvedSessions().find((s) => s.name === last) : undefined;
    if (profile) this.openSession(profile);
    else this.notify('No previous session yet');
  }

  // --- macros ---

  macroKeys(): string[] {
    return this.store.macros.map((m) => m.key).filter(Boolean);
  }

  macroForKey(key: string): Macro | undefined {
    return this.store.macros.find((m) => m.key === key);
  }

  runMacro(macro: Macro, tab: TerminalTab, fromKey = false): void {
    if (this.macroRun) {
      if (fromKey && this.macroRun.tab === tab) {
        // The shortcut pressed again while a macro runs in this session: stop it, unlock the
        // keyboard (Reset) and wipe what it typed (Erase Input).
        const running = this.macroRun;
        running.byKey = true;
        running.stop.abort();
        tab.press('reset');
        tab.press('eraseInput');
        this.notify(`Macro "${running.macro.name}" stopped by its key; input fields cleared`);
        return;
      }
      this.notify(`Macro "${this.macroRun.macro.name}" is still running (Actions > Stop Macro)`);
      return;
    }
    if (this.recordingTab === tab) {
      this.notify('Stop the recording before running a macro in this session');
      return;
    }
    const stop = new AbortController();
    const run = { macro, tab, stop, byKey: false };
    this.macroRun = run;
    this.notify(`Running macro "${macro.name}"…`);
    this.updateToolbar();
    const target: MacroTarget = {
      type: (text) => tab.type(text),
      press: (action) => tab.press(action),
      inputAllowed: () => tab.inputAllowed(),
      screenText: () => tab.screenText() ?? '',
      prompt: (label, secret) => promptDialog(`Macro "${macro.name}"`, label || 'Value', { password: secret }),
    };
    void runMacro(macro, target, { signal: stop.signal })
      .then((r) => {
        if (r.ok) this.notify(`Macro "${macro.name}" done`);
        else if (r.reason === 'stopped' && run.byKey) {
          // Already said so when the key stopped it.
        } else {
          const step = macro.steps[r.step];
          this.notify(`Macro "${macro.name}" stopped at step ${r.step + 1}${step ? ` (${describeStep(step)})` : ''}: ${r.reason}`);
        }
      })
      .catch((err: unknown) => this.notify(`Macro "${macro.name}" failed: ${errorText(err)}`))
      .finally(() => {
        this.macroRun = undefined;
        this.updateToolbar();
        tab.focus();
      });
  }

  private stopMacro(): void {
    this.macroRun?.stop.abort();
  }

  private startRecording(): void {
    const tab = this.activeTerminal();
    if (!tab || tab.isDemo || this.recordingTab) return;
    tab.recorder = new MacroRecorder();
    this.recordingTab = tab;
    this.recordingWatch = watchRecording(tab.recorder, {
      onIdle: () => {
        this.notify('Recording stopped: nothing typed for 5 minutes');
        void this.stopRecording();
      },
      onReminder: (minutes) => this.notify(`Still recording a macro (${minutes} min). Actions > Stop Recording when done.`),
    });
    this.statusRec.hidden = false;
    this.notify('Recording: what you type and press goes into the macro. Actions > Stop Recording (or the record button) when done.');
    this.updateToolbar();
    tab.focus();
  }

  private async stopRecording(): Promise<void> {
    const tab = this.recordingTab;
    if (!tab) return;
    const steps = tab.recorder?.finish() ?? [];
    tab.recorder = undefined;
    this.recordingTab = undefined;
    this.recordingWatch?.();
    this.recordingWatch = undefined;
    this.statusRec.hidden = true;
    this.updateToolbar();
    const into = this.recordInto;
    this.recordInto = undefined;
    if (into) {
      // Record from here: back into the editor with the new steps at the chosen place.
      if (!steps.length) this.notify('Nothing recorded');
      const at = Math.min(into.insertAt, into.macro.steps.length);
      await this.editMacro({ ...into.macro, steps: [...into.macro.steps.slice(0, at), ...steps, ...into.macro.steps.slice(at)] });
      return;
    }
    if (!steps.length) {
      this.notify('Nothing recorded');
      return;
    }
    await this.editMacro({ id: newMacroId(), name: '', key: '', steps });
  }

  /** Opens the editor; saves the result, and runs it when asked. */
  private async editMacro(macro: Macro): Promise<void> {
    const active = this.activeTerminal();
    const canRun = !!active && !active.isDemo;
    const result = await macroEditorDialog(macro, this.store.macros, { canRun, canRecord: canRun && !this.recordingTab });
    if (!result) return;
    if (result.action === 'record') {
      this.recordInto = { macro: result.macro, insertAt: result.insertAt ?? result.macro.steps.length };
      this.startRecording();
      return;
    }
    await this.store.saveMacro(result.macro);
    this.notify(`Macro "${result.macro.name}" saved${result.macro.key ? ` (${result.macro.key})` : ''}`);
    const tab = this.activeTerminal();
    if (result.action === 'run' && tab && !tab.isDemo) this.runMacro(result.macro, tab);
  }

  private macroRow(m: Macro): string {
    const company = this.store.isManagedMacro(m.id) ? '   (company)' : '';
    return `${m.name}${m.key ? `   [${m.key}]` : ''}   ${m.steps.length} step${m.steps.length === 1 ? '' : 's'}${company}`;
  }

  /** Actions > Macros: the list with play / pencil / trash on each row, New, Record, Import and Export on top. */
  private async macrosDialog(): Promise<void> {
    for (;;) {
      const macros = this.store.macros;
      const pick = await iconListDialog(
        'Macros',
        macros.map((m) => this.macroRow(m)),
        [
          { id: 'run', label: 'Run in the active session', icon: 'play', tone: 'green' },
          { id: 'edit', label: 'Edit', icon: 'pencil', tone: 'yellow' },
          { id: 'delete', label: 'Delete', icon: 'trash', tone: 'red' },
        ],
        [
          { id: 'new', label: 'New macro', icon: 'newPage', tone: 'blue' },
          { id: 'record', label: 'Record a macro in the active session', icon: 'record', tone: 'red' },
          { id: 'import', label: 'Import macros from a file…', icon: 'importFile', tone: 'blue' },
          { id: 'export', label: 'Export all macros to a file…', icon: 'exportFile', tone: 'blue' },
        ],
        'No macros yet. Record one, or build it step by step with New.',
      );
      if (!pick) return;
      if (pick.row < 0) {
        if (pick.action === 'new') await this.editMacro({ id: newMacroId(), name: '', key: '', steps: [] });
        else if (pick.action === 'import') await this.importMacros();
        else if (pick.action === 'export') await this.exportMacros(macros);
        else {
          this.startRecording();
          return;
        }
        continue;
      }
      const m = macros[pick.row];
      if (!m) continue;
      if (pick.action === 'run') {
        const tab = this.activeTerminal();
        if (tab && !tab.isDemo) this.runMacro(m, tab);
        else this.notify('Open a session first');
        return;
      }
      if (this.store.isManagedMacro(m.id)) {
        // Company macros come from the administrator's file: run them, or take a copy to change.
        const choice = await choiceDialog(
          `Company macro: ${m.name}`,
          ['Your administrator maintains this macro in the machine-wide settings file; it cannot be changed or deleted here.', 'A copy of your own can be changed; it needs a key of its own.'],
          ['Copy to my macros', 'Close'],
        );
        if (choice === 'Copy to my macros') await this.editMacro({ ...m, id: newMacroId(), name: `${m.name} (copy)`, key: '', steps: m.steps.map((s) => ({ ...s })) });
        continue;
      }
      if (pick.action === 'edit') await this.editMacro(m);
      if (pick.action === 'delete' && (await confirmDialog('Delete macro', `Delete "${m.name}"?`, 'Delete'))) {
        await this.store.removeMacro(m.id);
      }
    }
  }

  /** Writes every macro to a .json file the VS Code extension and other installs can import. */
  private async exportMacros(macros: Macro[]): Promise<void> {
    if (!macros.length) {
      this.notify('No macros to export');
      return;
    }
    const saved = await goApp().SaveTextFile('Export macros', 'tn5250-macros.json', macrosToJson(macros), [{ name: 'TN5250 macros', patterns: '*.json' }]);
    if (saved) this.notify(`${macros.length} macro${macros.length === 1 ? '' : 's'} exported`);
  }

  /** Reads a macros .json file: the same id replaces, a key another macro has is dropped. */
  private async importMacros(): Promise<void> {
    const app = goApp();
    const file = await app.PickFile('Import macros', [{ name: 'TN5250 macros', patterns: '*.json' }, { name: 'All files', patterns: '*.*' }]);
    if (!file) return;
    const incoming = macrosFromJson(await app.ReadTextFile(file));
    if (!incoming) {
      await messageDialog('Import macros', ['That file is not a macros export.']);
      return;
    }
    const r = mergeMacros(this.store.macros, incoming);
    await this.store.replaceMacros(r.macros);
    const dropped = r.keysDropped.length ? ` The key of ${r.keysDropped.join(', ')} was already taken and was left off.` : '';
    this.notify(`${r.added} macro${r.added === 1 ? '' : 's'} added, ${r.replaced} replaced.${dropped}`);
  }

  /** Actions > Run Macro: pick one for the active session. */
  private async runMacroDialog(): Promise<void> {
    const tab = this.activeTerminal();
    if (!tab || tab.isDemo) return;
    const macros = this.store.macros;
    const pick = await listDialog('Run Macro', '', macros.map((m) => this.macroRow(m)), ['Run'], [], 'No macros yet.');
    const m = pick && pick.row >= 0 ? macros[pick.row] : undefined;
    if (m) this.runMacro(m, tab);
  }

  /**
   * File > Import Connections: ACS 5250 session profiles (.hod) from the ACS folder or files
   * the user picks, into the saved sessions (shared readers in src/shared). A connection
   * already saved is updated in place; passwords are never read.
   */
  async importConnections(): Promise<void> {
    const app = goApp();
    const inAcs = await app.ListFiles(ACS_EMULATOR_DIR, '.hod').catch((): string[] => []);
    let files: string[];
    if (inAcs.length) {
      const pick = await listDialog(
        'Import Connections',
        'Only 5250 display sessions are imported; printer, 3270 and VT profiles are left out. Passwords are never read.',
        [`ACS session profiles: ${inAcs.length} in Documents\\IBM\\iAccessClient\\Emulator`, 'Choose .hod files…'],
        ['Select'],
        [],
      );
      if (!pick) return;
      files = pick.row === 0 ? inAcs : await app.PickFilesIn('Import ACS session profiles', HOD_FILTERS, ACS_EMULATOR_DIR);
    } else {
      files = await app.PickFilesIn('Import ACS session profiles', HOD_FILTERS, ACS_EMULATOR_DIR);
    }
    if (!files.length) return;
    const found = await readProfiles(files, (p) => app.ReadTextFile(p));
    if (!found.sessions.length) {
      this.notify(`No 5250 display sessions found.${unreadableNote(found.unreadable)}`);
      return;
    }
    const saved = this.store.readSessions();
    const rows = importRows(found.sessions, saved).map((r) => ({ label: r.label, detail: r.detail, tag: r.replaces ? 'replaces the saved one' : undefined }));
    const chosen = await checkListDialog(
      'Import Connections',
      "Select the connections to import. One already saved is updated in place: the profile's values win, what you set only here (a trusted certificate, bypass sign-on) stays.",
      rows,
      'Import',
    );
    if (!chosen?.length) return;
    // Nothing already saved changes without a word: ask first, and keep the old list for Undo.
    const incoming = chosen.map((i) => (found.sessions[i] as FoundSession).session);
    const alreadySaved = rows.filter((r, i) => r.tag && chosen.includes(i)).length;
    let updateSaved = true;
    if (alreadySaved) {
      const one = alreadySaved === 1;
      const answer = await choiceDialog(
        'Import Connections',
        [`${alreadySaved} of the selected connections ${one ? 'is' : 'are'} already saved.`, "Update: the profile's values win; a trusted certificate, demo mode and bypass sign-on stay. Keep: only the new connections are added, nothing already saved changes. Undo is offered afterwards."],
        ['Cancel', one ? 'Keep it as it is' : 'Keep them as they are', one ? 'Update it from the profile' : 'Update them from the profiles'],
      );
      if (!answer || answer === 'Cancel') return;
      updateSaved = answer.startsWith('Update');
    }
    const merged = mergeImported(saved, incoming, { updateSaved });
    if (!merged.touched.length) {
      this.notify(nothingImported(merged));
      return;
    }
    await this.store.writeSessions(merged.sessions);
    const message = importMessage(merged, found.unreadable);
    this.notify(message);
    const next = await choiceDialog('Import Connections', [message], ['Undo', 'Close', 'Open Settings']);
    if (next === 'Undo') {
      await this.store.writeSessions(saved);
      this.notify('Import undone, the connections are as they were.');
      return;
    }
    const first = merged.touched[0];
    if (next === 'Open Settings' && first !== undefined) this.openSettings(first);
  }

  private async newConnection(): Promise<void> {
    const d = this.store.readDefaults();
    const values = await formDialog('New connection', [
      { label: 'Host (host or host:port)', placeholder: 'myibmi.example.com' },
      { label: 'Session name (optional, saves the session)' },
    ], 'Connect');
    if (!values) return;
    const [hostText = '', name = ''] = values;
    const target = parseHostInput(hostText, d.port);
    if (!target) {
      this.notify('Enter a host name or host:port');
      return;
    }
    const profile = this.store.adHocSettings(target.host, target.port, target.port === 992 || d.tls);
    if (name.trim()) {
      profile.name = name.trim();
      await this.store.saveSession(-1, profile);
    }
    this.openSession(profile);
  }

  private quickConnect(): void {
    const input = byId<HTMLInputElement>('quick-host');
    const tls = byId<HTMLInputElement>('quick-tls').checked;
    const target = parseHostInput(input.value, tls ? 992 : this.store.readDefaults().port);
    if (!target) {
      this.notify('Enter a host name or host:port');
      input.focus();
      return;
    }
    this.openSession(this.store.adHocSettings(target.host, target.port, tls || target.port === 992));
  }

  private bindSidebar(): void {
    byId<HTMLFormElement>('quick').addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.quickConnect();
    });
    byId<HTMLButtonElement>('side-new').addEventListener('click', () => {
      this.openSettings(-1);
      const tab = this.entries.find((e) => e.kind === 'settings');
      if (tab?.kind === 'settings') void tab.tab.handle({ type: 'addSession' });
    });
    byId<HTMLButtonElement>('side-previous').addEventListener('click', () => this.connectPrevious());
  }

  /** The Connections tree: saved sessions with their open tabs (in every window) as children. */
  private renderSessions(): void {
    const defaults = this.store.readDefaults();
    const sessions = this.store.readSessions().map((s) => resolveSettings(defaults, s));
    const managed = this.store.managedSessions();
    // One tree so open tabs of the administrator's sessions group under them too.
    const tree = buildTree([...sessions, ...managed], this.registry);
    this.sessionList.replaceChildren();
    if (!sessions.length && !managed.length && !tree.others.length) {
      this.sessionList.append(el('li', 'none', 'No saved sessions'));
      return;
    }
    for (const row of tree.rows.filter((r) => r.index < sessions.length)) {
      const r = row.profile;
      const i = row.index;
      const li = el('li', i === this.selectedSession ? 'selected' : undefined, r.name || r.host || '(no host)');
      const badge = tabsBadge(row);
      if (badge) li.prepend(el('span', 'badge', badge));
      li.append(el('small', undefined, r.host ? `${r.host}:${r.port}${r.tls ? ' TLS' : ''}` : 'not configured'));
      li.title = 'Double-click to connect, right-click to edit';
      li.addEventListener('click', () => {
        this.selectedSession = i;
        this.selectedManaged = '';
        this.renderSessions();
      });
      li.addEventListener('dblclick', () => {
        if (r.host) this.openSession(r);
        else this.openSettings(i);
      });
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.openSettings(i);
      });
      if (row.tabs.length) li.append(this.renderChildren(row.tabs));
      this.sessionList.append(li);
    }
    const company = tree.rows.filter((r) => r.index >= sessions.length);
    if (company.length) {
      const head = el('li', 'group', 'Company connections');
      head.title = 'Set by your administrator in the machine-wide settings file';
      this.sessionList.append(head);
    }
    for (const row of company) {
      const r = row.profile;
      const li = el('li', this.selectedSession < 0 && r.name === this.selectedManaged ? 'selected managed' : 'managed', r.name || r.host);
      li.prepend(el('span', 'lock', '\u{1F512}'));
      const badge = tabsBadge(row);
      if (badge) li.prepend(el('span', 'badge', badge));
      li.append(el('small', undefined, `${r.host}:${r.port}${r.tls ? ' TLS' : ''}`));
      li.title = 'Set by your administrator. Double-click to connect, right-click for options';
      li.addEventListener('click', () => {
        this.selectedSession = -1;
        this.selectedManaged = r.name;
        this.renderSessions();
      });
      li.addEventListener('dblclick', () => this.openSession(r));
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        void this.managedSessionMenu(r);
      });
      if (row.tabs.length) li.append(this.renderChildren(row.tabs));
      this.sessionList.append(li);
    }
    if (tree.others.length) {
      const li = el('li', 'group', 'Other connections');
      li.append(this.renderChildren(tree.others));
      this.sessionList.append(li);
    }
  }

  /** Right-click on one of the administrator's sessions: connect, or take a copy of your own. */
  private async managedSessionMenu(r: TerminalSettings): Promise<void> {
    const choice = await choiceDialog(
      `Company connection: ${r.name}`,
      [
        `${r.host}:${r.port}${r.tls ? ' TLS' : ''}, ${r.screenSize}, code page ${r.codePage}`,
        'Your administrator maintains this connection in the machine-wide settings file; it cannot be changed here. A copy in your own connections can be, and it then takes the place of this one in your list.',
      ],
      ['Connect', 'Copy to my connections', 'Close'],
    );
    if (choice === 'Connect') this.openSession(r);
    else if (choice === 'Copy to my connections') {
      await this.store.saveSession(-1, r);
      this.selectedManaged = '';
      this.openSettings(this.store.readSessions().length - 1);
    }
  }

  private renderChildren(tabs: RegistryEntry[]): HTMLUListElement {
    const ul = el('ul', 'children');
    for (const t of tabs) {
      const here = t.window === this.windowName;
      const li = el('li', here ? 'child here' : 'child');
      const dot = el('span', `dot ${t.status}`);
      dot.title = t.status;
      li.append(dot, el('span', 'label', t.title));
      if (!here) li.append(el('span', 'where', 'other window'));
      li.title = here ? 'Click to show this tab' : 'Click to bring its window to the front';
      const stop = (ev: Event): void => ev.stopPropagation();
      li.addEventListener('dblclick', stop);
      li.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      li.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.showTab(t);
      });
      ul.append(li);
    }
    return ul;
  }

  /** Brings a session's tab to the front, in this window or in the window that has it. */
  private showTab(t: RegistryEntry): void {
    if (t.window === this.windowName) {
      const entry = this.entries.find((e) => e.kind === 'terminal' && e.tab.id === t.tab);
      if (entry) this.activate(entry);
      return;
    }
    void goApp()
      .WindowFocus(t.window)
      .then(() => relayNow(t.window, { type: 'tab:activate', tab: t.tab }))
      .catch((err: unknown) => this.notify(`Could not switch windows: ${errorText(err)}`));
  }

  // --- frames ---

  /** A message from the broker: for one of our tabs, a dialog to show, or the app-wide registry. */
  /**
   * The settings changed, here (saved = true: tell the broker, which tells the other
   * windows) or in another window (reloaded from the file): apply them everywhere.
   */
  private storeChanged(saved: boolean): void {
    void this.loadThemes().then(() => this.applyTheme());
    for (const e of this.entries) {
      if (e.kind === 'terminal') e.tab.pushConfig();
      else if (e.kind === 'settings') e.tab.push();
    }
    this.renderSessions();
    // The broker keeps its own copy of the settings (bypass sign-on, passwords, PC commands).
    if (saved) void relay('broker', { type: 'store:changed', window: this.windowName }).catch(() => undefined);
  }

  private onRelay(msg: ToWindow): void {
    if (msg.type === 'broker:ready') {
      brokerIsReady();
      return;
    }
    if (msg.type === 'store:changed') {
      void this.store
        .load()
        .then(() => this.storeChanged(false))
        .catch((err: unknown) => this.log(`settings not reloaded: ${errorText(err)}`));
      return;
    }
    if (msg.type === 'registry') {
      brokerIsReady();
      this.registry = msg.tabs;
      this.renderSessions();
      this.refresh();
      return;
    }
    if (msg.type === 'tab:activate') {
      const entry = this.entries.find((e) => e.kind === 'terminal' && e.tab.id === msg.tab);
      if (entry) this.activate(entry);
      return;
    }
    if (msg.type === 'ui:ask') {
      void this.askFromBroker(msg);
      return;
    }
    const entry = this.entries.find((e) => e.kind === 'terminal' && e.tab.id === msg.tab);
    if (entry?.kind === 'terminal') {
      entry.tab.receive(msg);
    } else if (msg.type === 'tab:opened') {
      // A session handed to this window from another one: adopt it as a tab.
      const tab = new TerminalTab(this, msg.profile, { id: msg.tab, letter: msg.letter, profile: msg.profile, deviceTemplate: msg.deviceTemplate, status: msg.status, detail: msg.detail });
      this.sidebar.hidden = true;
      const adopted: Entry = { kind: 'terminal', tab, button: el('div') };
      this.addEntry(adopted, true);
      this.dropIn(adopted);
      // Rings where it landed: the drop point when the move carried one, else the tab itself.
      const r = adopted.button.getBoundingClientRect();
      this.splash(msg.at ? this.clientFromScreen(msg.at) : { x: r.left + r.width / 2, y: r.top + r.height / 2 }, 'land');
    }
  }

  /** Opens another shell window; its page says hello to the broker when it has loaded. */
  private async newWindow(): Promise<string> {
    const name = `win-${Date.now().toString(36)}`;
    await goApp().WindowOpen(name, APP_NAME, -1, -1, 0, 0);
    return name;
  }

  /** The active session leaves for a new window; the broker keeps it connected throughout. */
  private async moveActiveToNewWindow(): Promise<void> {
    const entry = this.active;
    if (entry?.kind !== 'terminal' || entry.tab.isDemo) return;
    let name: string;
    try {
      name = await this.newWindow();
    } catch (err) {
      this.notify(`Could not open a window: ${errorText(err)}`);
      return;
    }
    await this.moveTab(entry, name);
  }

  /** The active session joins the main window (Window menu, from a detached window). */
  private async mergeActiveIntoMain(): Promise<void> {
    const entry = this.active;
    if (entry?.kind !== 'terminal' || entry.tab.isDemo || this.windowName === MAIN_WINDOW) return;
    await this.moveTab(entry, MAIN_WINDOW);
    void goApp().WindowFocus(MAIN_WINDOW).catch(() => undefined);
  }

  /**
   * Hands a terminal tab to another window: the broker re-homes the session and that
   * window adopts it. A detached window that gave away its last tab closes.
   */
  private async moveTab(entry: Entry, window: string, at?: Point): Promise<void> {
    if (entry.kind !== 'terminal' || !entry.tab.profile) return;
    entry.tab.handOver();
    try {
      await relay('broker', { type: 'tab:move', tab: entry.tab.id, window, ...(at ? { at } : {}) });
    } catch (err) {
      this.notify(`Could not move the tab: ${errorText(err)}`);
      return;
    }
    this.removeEntry(entry);
    if (this.windowName !== MAIN_WINDOW && !this.entries.length) void goApp().WindowClose(this.windowName).catch(() => undefined);
  }

  /** A yes/no question the broker needs answered by the user of this window. */
  private async askFromBroker(msg: Extract<ToWindow, { type: 'ui:ask' }>): Promise<void> {
    const ok = await confirmDialog(msg.title, msg.text, msg.ok);
    void relay('broker', { type: 'ui:answer', request: msg.request, ok }).catch(() => undefined);
    if (ok && msg.then === 'openSettings') {
      const entry = this.entries.find((e) => e.kind === 'terminal' && e.tab.id === msg.tab);
      const p = entry?.kind === 'terminal' ? entry.tab.profile : undefined;
      const index = p ? this.store.readSessions().findIndex((s) => s.name === p.name && s.host === p.host) : -1;
      this.openSettings(index);
    }
  }

  /** Sessions open in every window (for the Connections panel). */
  sessionsEverywhere(): RegistryEntry[] {
    return this.registry;
  }

  private onFrameMessage(ev: MessageEvent): void {
    const data = ev.data as { tn5250Frame?: boolean; message?: unknown } | undefined;
    if (!data?.tn5250Frame || typeof data.message !== 'object' || data.message === null) return;
    const entry = this.entries.find((e) => (e.kind === 'terminal' || e.kind === 'settings') && e.tab.frame.contentWindow === ev.source);
    if (!entry) return;
    const message = data.message as { type?: unknown };
    if (typeof message.type !== 'string') return;
    if (entry.kind === 'terminal') entry.tab.handle(message as WebviewToHost);
    else if (entry.kind === 'settings') void entry.tab.handle(message as SettingsToHost);
  }

  /** Shortcuts that work while focus is in the shell (menus, sidebar), not inside a terminal. */
  private onShellKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    if (document.querySelector('.menu.open')) this.closeMenus();
    else if (this.logOpen) this.toggleLog(false);
  }

  // --- toolbar ---

  /** Shows or hides the connections panel (quick connect and saved sessions). */
  private toggleConnections(show = this.sidebar.hidden): void {
    this.sidebar.hidden = !show;
    if (show) byId<HTMLInputElement>('quick-host').focus();
    else this.focusActive();
    this.updateToolbar();
  }

  private buildToolbar(): void {
    type Tool = { icon: IconName; title: string; run: () => void; enabled?: () => boolean; pressed?: () => boolean } | '|';
    const t = (): TerminalTab | undefined => this.activeTerminal();
    const live = (): boolean => !!t() && !t()?.isDemo;
    const on = (): boolean => !!t()?.connected;
    const tools: Tool[] = [
      { icon: 'connections', title: 'Connections: show or hide quick connect and saved sessions', run: () => this.toggleConnections(), pressed: () => !this.sidebar.hidden },
      { icon: 'newSession', title: 'New connection…', run: () => void this.newConnection() },
      '|',
      { icon: 'copy', title: 'Copy (selection, or the whole screen)', run: () => t()?.copy(), enabled: () => !!t() },
      { icon: 'paste', title: 'Paste', run: () => t()?.paste(), enabled: on },
      { icon: 'print', title: 'Print screen', run: () => t() && this.printScreen(t() as TerminalTab), enabled: live },
      '|',
      { icon: 'connect', title: 'Connect / reconnect', run: () => t()?.connect(), enabled: () => live() && !on() },
      { icon: 'disconnect', title: 'Disconnect', run: () => t()?.disconnect(), enabled: on },
      '|',
      { icon: 'attn', title: 'Attention', run: () => t()?.press('attn'), enabled: on },
      { icon: 'sysreq', title: 'System request', run: () => t()?.press('sysreq'), enabled: on },
      { icon: 'reset', title: 'Reset', run: () => t()?.press('reset'), enabled: on },
      '|',
      { icon: 'record', title: 'Record a macro (click again to stop)', run: () => (this.recordingTab ? void this.stopRecording() : this.startRecording()), enabled: () => live() || !!this.recordingTab, pressed: () => !!this.recordingTab },
      { icon: 'macro', title: 'Macros', run: () => void this.macrosDialog() },
      '|',
      { icon: 'ifs', title: 'Integrated File System', run: () => void this.openIfs() },
      { icon: 'sql', title: 'Run SQL Scripts', run: () => void this.openSql() },
      { icon: 'console', title: 'Console: CL commands and Qshell', run: () => void this.openConsole('cl') },
      { icon: 'settings', title: 'Settings', run: () => this.openSettings(-1) },
      { icon: 'help', title: `About ${APP_NAME}`, run: () => void this.about() },
      { icon: 'update', title: 'Check for updates', run: () => void this.checkForUpdates() },
    ];
    const bar = byId<HTMLDivElement>('toolbar');
    for (const tool of tools) {
      if (tool === '|') {
        bar.append(el('span', 'sep'));
        continue;
      }
      const b = el('button', `tool tool-${tool.icon}`);
      b.type = 'button';
      b.title = tool.title;
      b.setAttribute('aria-label', tool.title);
      b.innerHTML = ICONS[tool.icon];
      // Keep keyboard focus in the terminal: a toolbar click must not steal it.
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', () => {
        tool.run();
        if (tool.icon !== 'connections') this.active?.tab.focus();
      });
      bar.append(b);
      if (tool.icon === 'update') this.updateButton = b;
      this.toolbarItems.push({ button: b, enabled: tool.enabled, pressed: tool.pressed });
    }
  }

  private updateToolbar(): void {
    for (const item of this.toolbarItems) {
      item.button.disabled = item.enabled ? !item.enabled() : false;
      if (item.pressed) item.button.setAttribute('aria-pressed', String(item.pressed()));
    }
    const u = this.updateInfo;
    if (this.updateButton) {
      const available = !!u?.available;
      this.updateButton.classList.toggle('update-available', available);
      this.updateButton.title = available ? `Update available: ${versionOf(u.latest)} (you have ${u.current})` : 'Check for updates';
      this.updateButton.setAttribute('aria-label', this.updateButton.title);
    }
  }

  // --- menus ---

  private closeMenus(): void {
    for (const m of document.querySelectorAll('.menu.open')) m.classList.remove('open');
  }

  private buildMenus(): void {
    type Item = { label: string; run: () => void; enabled?: () => boolean; checked?: () => boolean } | '-';
    const t = (): TerminalTab | undefined => this.activeTerminal();
    const live = (): boolean => !!t() && !t()?.isDemo;
    const press = (action: KeyAction) => (): void => t()?.press(action);
    const menus: Array<{ label: string; items: Item[] }> = [
      {
        label: 'File',
        items: [
          { label: 'New Connection…', run: () => void this.newConnection() },
          { label: 'Import Connections…', run: () => void this.importConnections().catch((err: unknown) => this.notify(`Import failed: ${errorText(err)}`)) },
          { label: 'Connect to Previous', run: () => this.connectPrevious(), enabled: () => !!this.store.lastSession },
          '-',
          { label: 'Settings…', run: () => this.openSettings(-1) },
          '-',
          { label: 'Print Screen…', run: () => t() && this.printScreen(t() as TerminalTab), enabled: live },
          { label: 'Save Screen As…', run: () => void this.saveScreen(), enabled: live },
          { label: 'Save Trace…', run: () => void this.saveTrace(), enabled: live },
          '-',
          { label: 'Exit', run: () => void this.exit() },
        ],
      },
      {
        label: 'Edit',
        items: [{ label: 'Copy Screen', run: () => void this.copyScreen(), enabled: live }],
      },
      {
        label: 'View',
        items: [
          { label: 'Connections Panel', run: () => this.toggleConnections(), checked: () => !this.sidebar.hidden },
          { label: 'Session Log', run: () => this.toggleLog(), checked: () => this.logOpen },
          { label: 'Key Overlay', run: () => t()?.toggleKeyOverlay(), enabled: () => !!t() },
          '-',
          { label: 'Appearance: System', run: () => void this.pickAppearance('system'), checked: () => !this.store.themeName && this.store.appTheme === 'system' },
          { label: 'Appearance: Light', run: () => void this.pickAppearance('light'), checked: () => !this.store.themeName && this.store.appTheme === 'light' },
          { label: 'Appearance: Dark', run: () => void this.pickAppearance('dark'), checked: () => !this.store.themeName && this.store.appTheme === 'dark' },
          { label: 'Theme…', run: () => void this.themesDialog(), checked: () => !!this.store.themeName },
          '-',
          {
            label: 'Use System Title Bar (restart)',
            run: () => void this.store.setSystemTitleBar(!this.store.systemTitleBar).then(() => this.notify(`The ${this.store.systemTitleBar ? 'system' : "app's own"} title bar is used after a restart`)),
            checked: () => this.store.systemTitleBar,
          },
          '-',
          { label: 'Demo Screen', run: () => this.openDemo() },
          { label: 'Demo Screen Size 24x80 / 27x132', run: () => t()?.toggleScreenSize(), enabled: () => !!t()?.isDemo },
        ],
      },
      {
        label: 'Communication',
        items: [
          { label: 'Connect', run: () => t()?.connect(), enabled: () => live() && !t()?.connected },
          { label: 'Disconnect', run: () => t()?.disconnect(), enabled: () => !!t()?.connected },
          { label: 'Disconnect All', run: () => void this.disconnectAll(), enabled: () => this.terminals().some((x) => x.connected) },
        ],
      },
      {
        label: 'Actions',
        items: [
          { label: 'Attention', run: press('attn'), enabled: () => !!t()?.connected },
          { label: 'System Request', run: press('sysreq'), enabled: () => !!t()?.connected },
          { label: 'Reset', run: press('reset'), enabled: () => !!t()?.connected },
          { label: 'Help', run: press('help'), enabled: () => !!t()?.connected },
          { label: 'Clear', run: press('clear'), enabled: () => !!t()?.connected },
          { label: 'Print (host)', run: press('print'), enabled: () => !!t()?.connected },
          '-',
          { label: 'Macros…', run: () => void this.macrosDialog() },
          { label: 'Run Macro…', run: () => void this.runMacroDialog(), enabled: () => live() && this.store.macros.length > 0 },
          { label: 'Record Macro', run: () => this.startRecording(), enabled: () => live() && !this.recordingTab },
          { label: 'Stop Recording', run: () => void this.stopRecording(), enabled: () => !!this.recordingTab },
          { label: 'Stop Macro', run: () => this.stopMacro(), enabled: () => !!this.macroRun },
        ],
      },
      {
        label: 'Tools',
        items: [
          { label: 'Integrated File System…', run: () => void this.openIfs() },
          { label: 'Run SQL Scripts…', run: () => void this.openSql() },
          { label: 'CL Console…', run: () => void this.openConsole('cl') },
          { label: 'QSH Console…', run: () => void this.openConsole('qsh') },
          '-',
          { label: 'Saved Passwords…', run: () => void this.managePasswords() },
        ],
      },
      {
        label: 'Window',
        items: [
          { label: 'Next Tab', run: () => this.cycle(1), enabled: () => this.entries.length > 1 },
          { label: 'Previous Tab', run: () => this.cycle(-1), enabled: () => this.entries.length > 1 },
          '-',
          { label: 'Duplicate Session', run: () => this.duplicate(), enabled: live },
          { label: 'Close Tab', run: () => this.active && void this.close(this.active), enabled: () => !!this.active },
          '-',
          { label: 'New Window', run: () => void this.newWindow().catch((err: unknown) => this.notify(`Could not open a window: ${errorText(err)}`)) },
          { label: 'Move Tab to New Window', run: () => void this.moveActiveToNewWindow(), enabled: live },
          { label: 'Merge Tab into Main Window', run: () => void this.mergeActiveIntoMain(), enabled: () => live() && this.windowName !== MAIN_WINDOW },
        ],
      },
      {
        label: 'Help',
        items: [
          { label: 'Project Website', run: () => void goApp().OpenURL(PROJECT_URL) },
          { label: 'Settings File Location', run: () => void this.showSettingsPath() },
          '-',
          { label: 'Check for Updates…', run: () => void this.checkForUpdates() },
          {
            label: 'Check for Updates at Startup',
            run: () => void this.store.setCheckForUpdates(!this.store.checkForUpdates),
            checked: () => this.store.checkForUpdates,
            enabled: () => !this.store.updatesLocked,
          },
          '-',
          { label: `About ${APP_NAME}`, run: () => void this.about() },
        ],
      },
    ];

    const bar = byId<HTMLElement>('menubar');
    for (const menu of menus) {
      const wrap = el('div', 'menu');
      const head = el('button', undefined, menu.label);
      head.type = 'button';
      head.setAttribute('aria-haspopup', 'true');
      const list = el('ul', 'menu-items');
      list.setAttribute('role', 'menu');
      const render = (): void => {
        list.replaceChildren();
        for (const item of menu.items) {
          const li = el('li');
          if (item === '-') {
            li.append(el('hr'));
          } else {
            const b = el('button', item.checked?.() ? 'checked' : undefined);
            b.type = 'button';
            b.setAttribute('role', 'menuitem');
            b.append(el('span', undefined, item.label));
            b.disabled = item.enabled ? !item.enabled() : false;
            b.addEventListener('click', () => {
              this.closeMenus();
              const panelWasHidden = this.sidebar.hidden;
              item.run();
              if (!(panelWasHidden && !this.sidebar.hidden)) this.focusActive();
            });
            li.append(b);
          }
          list.append(li);
        }
      };
      head.addEventListener('click', () => {
        const open = wrap.classList.contains('open');
        this.closeMenus();
        if (!open) {
          render();
          wrap.classList.add('open');
        }
      });
      head.addEventListener('mouseenter', () => {
        if (document.querySelector('.menu.open') && !wrap.classList.contains('open')) {
          this.closeMenus();
          render();
          wrap.classList.add('open');
        }
      });
      wrap.append(head, list);
      bar.append(wrap);
    }
    document.addEventListener('mousedown', (ev) => {
      if (!(ev.target instanceof Node) || !bar.contains(ev.target)) this.closeMenus();
    });
    window.addEventListener('blur', () => this.closeMenus());
  }

  private cycle(step: number): void {
    if (!this.active || this.entries.length < 2) return;
    const i = this.entries.indexOf(this.active);
    const next = this.entries[(i + step + this.entries.length) % this.entries.length];
    if (next) this.activate(next);
  }

  /** The session log grows up out of the status bar (click it, View > Session Log) and minimises back (Esc, the arrow). */
  private toggleLog(show = !this.logOpen): void {
    this.logPane.classList.toggle('open', show);
    this.statusBar.classList.toggle('log-open', show);
    this.statusText.title = show ? 'Minimise the session log' : 'Session log';
    if (show) {
      this.logEl.textContent = this.logLines.join('\n');
      this.logEl.scrollTop = this.logEl.scrollHeight;
    } else {
      this.focusActive();
    }
  }

  private async copyScreen(): Promise<void> {
    const text = this.activeTerminal()?.screenText();
    if (text === undefined) return;
    await goApp().ClipboardSet(text);
    this.notify('Screen copied');
  }

  private fileSafe(title: string): string {
    return title.replace(/[^\w.-]+/g, '_');
  }

  private async saveScreen(): Promise<void> {
    const t = this.activeTerminal();
    const text = t?.screenText();
    if (!t || text === undefined) return;
    if (await goApp().SaveTextFile('Save screen', `${this.fileSafe(t.title)}.txt`, text + '\n', [{ name: 'Text', patterns: '*.txt' }])) this.notify('Screen saved');
  }

  private async saveTrace(): Promise<void> {
    const t = this.activeTerminal();
    if (!t) return;
    const trace = await t.exportTrace();
    if (!trace) return;
    const saved = await goApp().SaveTextFile('Save session trace', `tn5250-trace-${this.fileSafe(t.title)}.json`, JSON.stringify(trace, null, 1) + '\n', [{ name: 'JSON', patterns: '*.json' }]);
    if (saved) await messageDialog('Trace saved', ['The trace contains screen contents; share it only with people allowed to see them.']);
  }

  private async disconnectAll(): Promise<void> {
    const open = this.terminals().filter((x) => x.connected);
    if (open.length > 1 && this.store.readDefaults().warnOnCloseMultiple) {
      if (!(await confirmDialog('Disconnect all', `Disconnect ${open.length} sessions?`, 'Disconnect'))) return;
    }
    for (const x of open) x.disconnect();
  }

  private async exit(): Promise<void> {
    const open = this.terminals().filter((x) => x.connected);
    if (open.length && !(await confirmDialog('Exit', `Disconnect ${open.length} session(s) and exit?`, 'Exit'))) return;
    wailsRuntime().Quit();
  }

  private async showSettingsPath(): Promise<void> {
    const p = await goApp().SettingsPaths();
    const lines = [`Your settings: ${p.user}`];
    if (p.managed) {
      const state = this.store.managedError ? `present but ${this.store.managedError}` : p.managedExists ? 'present' : 'not present';
      lines.push(`Company settings, read at every start and never changed by the app: ${p.managed} (${state})`);
    }
    if (p.preload) lines.push(`First-start seed for a user without settings: ${p.preload}`);
    lines.push('Passwords are kept in the operating system credential store, not in these files.');
    await messageDialog('Settings files', lines);
  }

  private async about(): Promise<void> {
    const version = await goApp()
      .Version()
      .catch(() => '');
    await messageDialog(`About ${APP_NAME}`, [
      ...(version ? [`Version ${version}`] : []),
      'A 5250 terminal emulator for IBM i. Free and open source (MIT).',
      PROJECT_URL,
      'No telemetry. Connections go only to the hosts you enter, and to github.com to check for updates (Help > Check for Updates at Startup turns that off).',
    ]);
  }
}

/** data-theme="light" | "dark" forces a scheme; absent = the system's. */
function setTheme(doc: Document, theme: AppTheme): void {
  const root = doc.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** The session name older versions keyed a saved password by, when the profile is for host. */
function sameName(profile: TerminalSettings, host: string): string {
  return profile.host === host ? profile.name : '';
}

/** "v0.1.3" -> "0.1.3". */
function versionOf(tag: string): string {
  return tag.replace(/^v/, '');
}

void new Shell().start();
