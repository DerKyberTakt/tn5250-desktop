import type { KeyAction } from '../shared/keymap';
import type { WebviewToHost } from '../shared/protocol';
import { resolveSettings, type TerminalSettings } from '../shared/settings';
import type { SettingsToHost } from '../shared/settingsProtocol';
import { errorText, goApp, wailsRuntime, type SystemInfo } from './bridge';
import { confirmDialog, formDialog, messageDialog } from './dialogs';
import { SettingsTab } from './settingsTab';
import { Store } from './store';
import { TerminalTab, type TabHost } from './terminalTab';

const APP_NAME = 'TN5250 Terminal';
const PROJECT_URL = 'https://github.com/DerKyberTakt/tn5250-desktop';
const LOG_LIMIT = 1000;

type Entry = { kind: 'terminal'; tab: TerminalTab; button: HTMLElement } | { kind: 'settings'; tab: SettingsTab; button: HTMLElement };

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

class Shell implements TabHost {
  readonly store = new Store();
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
        else e.tab.push();
      }
      this.renderSessions();
    });
    this.buildMenus();
    this.bindSidebar();
    this.renderSessions();
    window.addEventListener('message', (ev) => this.onFrameMessage(ev));
    document.addEventListener('keydown', (ev) => this.onShellKey(ev));
    this.refresh();
    await this.openFromCommandLine();
  }

  /** `tn5250-terminal [--tls] host[:port]` opens an ad-hoc session (port 992 implies TLS). */
  private async openFromCommandLine(): Promise<void> {
    let args: string[];
    try {
      args = await goApp().LaunchArgs();
    } catch {
      return;
    }
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

  changed(tab: TerminalTab): void {
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
    this.addEntry({ kind: 'terminal', tab, button: el('div') }, profile.switchToNewTab || !this.active);
    if (profile.name) void this.store.setLastSession(profile.name).catch(() => undefined);
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
    this.refresh();
  }

  private activeTerminal(): TerminalTab | undefined {
    return this.active?.kind === 'terminal' ? this.active.tab : undefined;
  }

  private terminals(): TerminalTab[] {
    return this.entries.flatMap((e) => (e.kind === 'terminal' ? [e.tab] : []));
  }

  private refresh(): void {
    this.empty.hidden = this.entries.length > 0;
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
    const entry = this.entries.find((e) => e.tab.frame.contentWindow === ev.source);
    if (!entry) return;
    const message = data.message as { type?: unknown };
    if (typeof message.type !== 'string') return;
    if (entry.kind === 'terminal') entry.tab.handle(message as WebviewToHost);
    else void entry.tab.handle(message as SettingsToHost);
  }

  /** Shortcuts that work while focus is in the shell (menus, sidebar), not inside a terminal. */
  private onShellKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.closeMenus();
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
          { label: 'Connections Panel', run: () => (this.sidebar.hidden = !this.sidebar.hidden), checked: () => !this.sidebar.hidden },
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
              item.run();
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
    await messageDialog(`About ${APP_NAME}`, [
      'A 5250 terminal emulator for IBM i. Free and open source (MIT).',
      PROJECT_URL,
      'No telemetry. Connections go only to the hosts you enter.',
    ]);
  }
}

void new Shell().start();
