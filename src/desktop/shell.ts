import type { KeyAction } from '../shared/keymap';
import type { WebviewToHost } from '../shared/protocol';
import { resolveSettings, type TerminalSettings } from '../shared/settings';
import type { SettingsToHost } from '../shared/settingsProtocol';
import { errorText, goApp, wailsRuntime, type SqlConnectRequest, type SystemInfo, type UpdateInfo } from './bridge';
import { Credentials } from './credentials';
import { confirmDialog, formDialog, listDialog, messageDialog } from './dialogs';
import { ICONS, type IconName } from './icons';
import { IfsTab, type IfsHost } from './ifsTab';
import { SettingsTab } from './settingsTab';
import { ConsoleTab, type ConsoleHost, type ConsoleMode } from './consoleTab';
import { SqlTab, type SqlHost } from './sqlTab';
import { Store } from './store';
import { TerminalTab, type TabHost } from './terminalTab';

const APP_NAME = 'TN5250 Terminal';
const PROJECT_URL = 'https://github.com/DerKyberTakt/tn5250-desktop';
const LOG_LIMIT = 1000;
/** While the app stays open, look for a new release once a day. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Entry =
  | { kind: 'terminal'; tab: TerminalTab; button: HTMLElement }
  | { kind: 'settings'; tab: SettingsTab; button: HTMLElement }
  | { kind: 'ifs'; tab: IfsTab; button: HTMLElement }
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

class Shell implements TabHost, IfsHost, SqlHost, ConsoleHost {
  readonly store = new Store();
  readonly credentials = new Credentials(this.store);
  system: SystemInfo = { computerName: '', userName: '', platform: '' };

  private readonly entries: Entry[] = [];
  private active: Entry | undefined;
  private selectedSession = -1;
  private readonly logLines: string[] = [];
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly tabbar = byId<HTMLDivElement>('tabbar');
  private readonly frames = byId<HTMLElement>('frames');
  private readonly empty = byId<HTMLDivElement>('empty');
  private readonly sidebar = byId<HTMLElement>('sidebar');
  private toolbarItems: Array<{ button: HTMLButtonElement; enabled?: () => boolean; pressed?: () => boolean }> = [];
  private updateButton?: HTMLButtonElement;
  private updateInfo?: UpdateInfo;
  private updating = false;
  private readonly sessionList = byId<HTMLUListElement>('sessions');
  private readonly logEl = byId<HTMLPreElement>('log');
  private readonly statusText = byId<HTMLSpanElement>('status-text');
  private readonly statusRight = byId<HTMLSpanElement>('status-right');

  async start(): Promise<void> {
    try {
      await this.store.load();
    } catch (err) {
      this.log(`settings file not readable, starting with defaults: ${errorText(err)}`);
    }
    try {
      this.system = await goApp().SystemInfo();
    } catch (err) {
      this.log(`system info: ${errorText(err)}`);
    }
    this.store.onChange(() => {
      for (const e of this.entries) {
        if (e.kind === 'terminal') e.tab.pushConfig();
        else if (e.kind === 'settings') e.tab.push();
      }
      this.renderSessions();
    });
    this.buildMenus();
    this.buildToolbar();
    this.bindSidebar();
    this.renderSessions();
    window.addEventListener('message', (ev) => this.onFrameMessage(ev));
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
      off = wailsRuntime().EventsOn('update:progress', (done, total) => {
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
    } catch {
      return;
    }
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
    if (!this.logEl.hidden) {
      this.logEl.textContent = this.logLines.join('\n');
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  changed(tab: TerminalTab | IfsTab | SqlTab | ConsoleTab): void {
    const entry = this.entries.find((e) => e.tab === tab);
    if (entry) this.renderTabButton(entry);
    if (this.active?.tab === tab) this.refresh();
  }

  notify(text: string): void {
    this.statusText.textContent = text;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.refresh(), 5000);
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
    const sessions = this.store.readSessions();
    const picked = this.selectedSession >= 0 ? sessions[this.selectedSession] : undefined;
    const defaults = this.store.readDefaults();
    const base = t?.profile ?? (picked ? resolveSettings(defaults, picked) : this.store.resolvedSessions()[0]) ?? defaults;
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
    const sessions = this.store.readSessions();
    const picked = this.selectedSession >= 0 ? sessions[this.selectedSession] : undefined;
    const defaults = this.store.readDefaults();
    const base = t?.profile ?? (picked ? resolveSettings(defaults, picked) : this.store.resolvedSessions()[0]) ?? defaults;
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

  private openSettings(select = -1): void {
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
    this.frames.append(entry.tab.frame);
    this.renderTabButton(entry);
    if (activate) this.activate(entry);
    else this.refresh();
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
    const i = this.entries.indexOf(entry);
    if (i < 0) return;
    this.entries.splice(i, 1);
    entry.tab.dispose();
    entry.button.remove();
    if (this.active === entry) {
      this.active = undefined;
      const next = this.entries[Math.min(i, this.entries.length - 1)];
      if (next) this.activate(next);
    }
    if (!this.entries.length) this.sidebar.hidden = false;
    this.refresh();
    this.focusActive();
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

  private refresh(): void {
    this.empty.hidden = this.entries.length > 0;
    // One tab needs no tab bar (the window title names it); it appears with the second tab.
    this.tabbar.hidden = this.entries.length < 2;
    const t = this.activeTerminal();
    const title = this.active ? `${this.active.tab.title} - ${APP_NAME}` : APP_NAME;
    document.title = title;
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

  private renderSessions(): void {
    const sessions = this.store.readSessions();
    const defaults = this.store.readDefaults();
    this.sessionList.replaceChildren();
    if (!sessions.length) {
      this.sessionList.append(el('li', 'none', 'No saved sessions'));
      return;
    }
    sessions.forEach((s, i) => {
      const r = resolveSettings(defaults, s);
      const li = el('li', i === this.selectedSession ? 'selected' : undefined, r.name || r.host || '(no host)');
      li.append(el('small', undefined, r.host ? `${r.host}:${r.port}${r.tls ? ' TLS' : ''}` : 'not configured'));
      li.title = 'Double-click to connect, right-click to edit';
      li.addEventListener('click', () => {
        this.selectedSession = i;
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
      this.sessionList.append(li);
    });
  }

  // --- frames ---

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
    if (ev.key === 'Escape') this.closeMenus();
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
      const b = el('button', 'tool');
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
          { label: 'Session Log', run: () => this.toggleLog(), checked: () => !this.logEl.hidden },
          { label: 'Key Overlay', run: () => t()?.toggleKeyOverlay(), enabled: () => !!t() },
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

  private toggleLog(): void {
    this.logEl.hidden = !this.logEl.hidden;
    if (!this.logEl.hidden) {
      this.logEl.textContent = this.logLines.join('\n');
      this.logEl.scrollTop = this.logEl.scrollHeight;
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
    const trace = t?.exportTrace();
    if (!t || !trace) return;
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
    await messageDialog('Settings file', [await goApp().SettingsFilePath(), 'Passwords are kept in the operating system credential store, not in this file.']);
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

/** The session name older versions keyed a saved password by, when the profile is for host. */
function sameName(profile: TerminalSettings, host: string): string {
  return profile.host === host ? profile.name : '';
}

/** "v0.1.3" -> "0.1.3". */
function versionOf(tag: string): string {
  return tag.replace(/^v/, '');
}

void new Shell().start();
