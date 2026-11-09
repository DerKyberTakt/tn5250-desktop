import type { Credential } from './credentials';
import {
  SETTINGS_DEFAULTS,
  diffSettings,
  resolveSettings,
  type SessionOverrides,
  type TerminalSettings,
} from '../shared/settings';
import { goApp } from './bridge';
import { sanitizeMacro, type Macro } from '../shared/macros';

/**
 * settings.json in the user config directory (Windows: %APPDATA%\tn5250-terminal,
 * Linux: ~/.config/tn5250-terminal). Defaults and sessions are stored as the values
 * that differ from the built-in defaults, the same model as the VS Code extension.
 *
 * Under it sits the managed file an administrator maintains for every user of the
 * machine (Windows: %ProgramData%\tn5250-terminal\settings.json, see app.go). It is read
 * at every start and never written: its defaults are the base the user's defaults
 * override, its sessions and macros are listed read-only next to the user's own (a user
 * session with the same name hides the managed one), and checkForUpdates false turns the
 * startup update check off for everyone.
 */
interface SettingsFile {
  version: 1;
  defaults: Partial<TerminalSettings>;
  sessions: SessionOverrides[];
  lastSession?: string;
  /** Check GitHub for a newer release at startup (Help menu); on unless false. */
  checkForUpdates?: boolean;
  /** View > Appearance: follow the system, or force light / dark. */
  appTheme?: AppTheme;
  /** View > Use System Title Bar: keep the system frame instead of the app's own title bar (read by Go at start). */
  systemTitleBar?: boolean;
  /** View > Theme…: the theme in use (a built-in or a file in the themes folder); none = Appearance decides. */
  themeName?: string;
  /** Host and user of the last IFS sign-on, to fill the dialog (the password is in the credential store). */
  ifsLast?: { host: string; user: string };
  /** Which USER@host passwords are saved in the credential store (names only, no passwords). */
  credentials?: Credential[];
  /** Keystroke macros (Actions > Macros). */
  macros?: Macro[];
}

type Listener = () => void;

/** The parts of the managed file the app honours. */
interface ManagedFile {
  defaults: Partial<TerminalSettings>;
  sessions: SessionOverrides[];
  macros: Macro[];
  checkForUpdates?: boolean;
}

const NO_MANAGED: ManagedFile = { defaults: {}, sessions: [], macros: [] };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type AppTheme = 'system' | 'light' | 'dark';
const APP_THEMES: AppTheme[] = ['system', 'light', 'dark'];

export class Store {
  private file: SettingsFile = { version: 1, defaults: {}, sessions: [] };
  private managed: ManagedFile = NO_MANAGED;
  /** Why the managed file was not used, for the log and Help > Settings File Location. */
  managedError: string | undefined;
  private readonly listeners = new Set<Listener>();

  async load(): Promise<void> {
    await this.loadManaged();
    // Editors such as Notepad may save the file with a byte-order mark, which JSON.parse rejects.
    const text = (await goApp().SettingsLoad()).replace(/^\uFEFF/, '');
    if (!text.trim()) return;
    const parsed = JSON.parse(text) as Partial<SettingsFile>;
    this.file = {
      version: 1,
      defaults: typeof parsed.defaults === 'object' && parsed.defaults ? parsed.defaults : {},
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((s) => typeof s?.host === 'string') : [],
      lastSession: typeof parsed.lastSession === 'string' ? parsed.lastSession : undefined,
      checkForUpdates: typeof parsed.checkForUpdates === 'boolean' ? parsed.checkForUpdates : undefined,
      appTheme: APP_THEMES.includes(parsed.appTheme as AppTheme) ? parsed.appTheme : undefined,
      systemTitleBar: parsed.systemTitleBar === true ? true : undefined,
      themeName: typeof parsed.themeName === 'string' && parsed.themeName.trim() ? parsed.themeName : undefined,
      credentials: Array.isArray(parsed.credentials)
        ? parsed.credentials.filter((c) => typeof c?.user === 'string' && typeof c?.host === 'string').map((c) => ({ user: c.user, host: c.host }))
        : undefined,
      ifsLast:
        typeof parsed.ifsLast?.host === 'string' && typeof parsed.ifsLast?.user === 'string'
          ? { host: parsed.ifsLast.host, user: parsed.ifsLast.user }
          : undefined,
      macros: Array.isArray(parsed.macros) ? parsed.macros.map(sanitizeMacro).filter((m): m is Macro => !!m) : undefined,
    };
  }

  /** Reads the administrator's file; a missing or broken one leaves the app working on the user's. */
  private async loadManaged(): Promise<void> {
    this.managed = NO_MANAGED;
    this.managedError = undefined;
    const app = goApp();
    if (typeof app.ManagedSettingsLoad !== 'function') return;
    let text: string;
    try {
      text = (await app.ManagedSettingsLoad()).replace(/^\uFEFF/, '');
    } catch (err) {
      this.managedError = `not readable: ${errorMessage(err)}`;
      return;
    }
    if (!text.trim()) return;
    try {
      const parsed = JSON.parse(text) as Partial<SettingsFile>;
      this.managed = {
        defaults: typeof parsed.defaults === 'object' && parsed.defaults ? parsed.defaults : {},
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((s) => typeof s?.host === 'string' && s.host.trim() !== '') : [],
        macros: Array.isArray(parsed.macros) ? parsed.macros.map(sanitizeMacro).filter((m): m is Macro => !!m) : [],
        checkForUpdates: typeof parsed.checkForUpdates === 'boolean' ? parsed.checkForUpdates : undefined,
      };
    } catch (err) {
      this.managedError = `not valid JSON: ${errorMessage(err)}`;
    }
  }

  /** True when an administrator's file contributes anything. */
  get hasManaged(): boolean {
    const m = this.managed;
    return m.sessions.length > 0 || m.macros.length > 0 || Object.keys(m.defaults).length > 0 || m.checkForUpdates !== undefined;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await goApp().SettingsSave(JSON.stringify(this.file, null, 2) + '\n');
    for (const l of this.listeners) l();
  }

  /** The built-in defaults with the administrator's on top: what the user's defaults override. */
  private baseDefaults(): TerminalSettings {
    const d = resolveSettings(SETTINGS_DEFAULTS, this.managed.defaults);
    d.name = '';
    return d;
  }

  readDefaults(): TerminalSettings {
    const d = resolveSettings(this.baseDefaults(), this.file.defaults);
    // resolveSettings fills an empty name from the host; defaults have no name.
    d.name = '';
    return d;
  }

  async writeDefaults(values: TerminalSettings): Promise<void> {
    // Only what differs from the administrator's base is the user's own; a later change
    // to the managed file then still reaches the values the user never touched.
    const diff: Partial<TerminalSettings> = diffSettings(this.baseDefaults(), values);
    if (!values.host) delete diff.host;
    delete diff.name;
    this.file.defaults = diff;
    await this.persist();
  }

  readSessions(): SessionOverrides[] {
    return this.file.sessions.map((s) => ({ ...s }));
  }

  /** The user's own sessions, resolved. */
  private ownSessions(): TerminalSettings[] {
    const defaults = this.readDefaults();
    return this.file.sessions.filter((s) => s.host.trim()).map((s) => resolveSettings(defaults, s));
  }

  /**
   * The administrator's sessions, resolved, without those the user has a session of the
   * same name for (a copy the user made and edited takes the managed one's place).
   */
  managedSessions(): TerminalSettings[] {
    if (!this.managed.sessions.length) return [];
    const defaults = this.readDefaults();
    const own = new Set(this.ownSessions().map((s) => s.name));
    return this.managed.sessions.map((s) => resolveSettings(defaults, s)).filter((s) => !own.has(s.name));
  }

  /** Is this profile one of the administrator's (read-only here)? */
  isManagedSession(p: { name: string; host: string }): boolean {
    return this.managedSessions().some((s) => s.name === p.name && s.host === p.host);
  }

  /** Every session a user can connect to: their own first, then the administrator's. */
  resolvedSessions(): TerminalSettings[] {
    return [...this.ownSessions(), ...this.managedSessions()];
  }

  async writeSessions(sessions: SessionOverrides[]): Promise<void> {
    this.file.sessions = sessions;
    await this.persist();
  }

  async saveSession(index: number, values: TerminalSettings): Promise<void> {
    const entry = diffSettings(this.readDefaults(), values);
    if (index >= 0 && index < this.file.sessions.length) this.file.sessions[index] = entry;
    else this.file.sessions.push(entry);
    await this.persist();
  }

  async removeSessionAt(index: number): Promise<void> {
    this.file.sessions.splice(index, 1);
    await this.persist();
  }

  /** Settings for an ad-hoc connection: the defaults with a host and port. */
  adHocSettings(host: string, port: number, tls: boolean): TerminalSettings {
    return resolveSettings(this.readDefaults(), { host, port, tls, name: '' });
  }

  get lastSession(): string | undefined {
    return this.file.lastSession;
  }

  get checkForUpdates(): boolean {
    if (this.updatesLocked) return false;
    return this.file.checkForUpdates !== false;
  }

  /** The administrator turned the startup update check off for everyone (MSI rollouts). */
  get updatesLocked(): boolean {
    return this.managed.checkForUpdates === false;
  }

  async setCheckForUpdates(on: boolean): Promise<void> {
    this.file.checkForUpdates = on;
    await this.persist();
  }

  get appTheme(): AppTheme {
    return this.file.appTheme ?? 'system';
  }

  async setAppTheme(theme: AppTheme): Promise<void> {
    if (this.appTheme === theme) return;
    this.file.appTheme = theme === 'system' ? undefined : theme;
    await this.persist();
  }

  get themeName(): string | undefined {
    return this.file.themeName;
  }

  async setThemeName(name: string | undefined): Promise<void> {
    if (this.file.themeName === name) return;
    this.file.themeName = name;
    await this.persist();
  }

  get systemTitleBar(): boolean {
    return this.file.systemTitleBar === true;
  }

  async setSystemTitleBar(on: boolean): Promise<void> {
    this.file.systemTitleBar = on ? true : undefined;
    await this.persist();
  }

  get ifsLast(): { host: string; user: string } | undefined {
    return this.file.ifsLast;
  }

  async setIfsLast(host: string, user: string): Promise<void> {
    if (this.file.ifsLast?.host === host && this.file.ifsLast.user === user) return;
    this.file.ifsLast = { host, user };
    await this.persist();
  }

  get credentials(): Credential[] {
    return (this.file.credentials ?? []).map((c) => ({ ...c }));
  }

  async addCredential(c: Credential): Promise<void> {
    const list = this.file.credentials ?? [];
    if (list.some((x) => x.user === c.user && x.host === c.host)) return;
    this.file.credentials = [...list, c].sort((a, b) => a.host.localeCompare(b.host) || a.user.localeCompare(b.user));
    await this.persist();
  }

  async removeCredential(c: Credential): Promise<void> {
    const list = this.file.credentials ?? [];
    const next = list.filter((x) => !(x.user === c.user && x.host === c.host));
    if (next.length === list.length) return;
    this.file.credentials = next;
    await this.persist();
  }

  /** The macros, as copies (edit one and save it back with saveMacro): the user's own, then the administrator's. */
  get macros(): Macro[] {
    const own = this.file.macros ?? [];
    const ids = new Set(own.map((m) => m.id));
    return [...own, ...this.managed.macros.filter((m) => !ids.has(m.id))].map((m) => ({ ...m, steps: m.steps.map((s) => ({ ...s })) }));
  }

  /** Is this macro one of the administrator's (read-only here)? */
  isManagedMacro(id: string): boolean {
    return this.managed.macros.some((m) => m.id === id) && !(this.file.macros ?? []).some((m) => m.id === id);
  }

  /** Adds the macro, or replaces the one with its id. An administrator's macro is left alone. */
  async saveMacro(macro: Macro): Promise<void> {
    if (this.isManagedMacro(macro.id)) return;
    const list = this.file.macros ?? [];
    const at = list.findIndex((m) => m.id === macro.id);
    if (at >= 0) list[at] = macro;
    else list.push(macro);
    this.file.macros = list;
    await this.persist();
  }

  /** Replaces the user's list (import); the administrator's macros are never copied into it. */
  async replaceMacros(macros: Macro[]): Promise<void> {
    const own = macros.filter((m) => !this.managed.macros.some((x) => x.id === m.id));
    this.file.macros = own.length ? own : undefined;
    await this.persist();
  }

  async removeMacro(id: string): Promise<void> {
    if (this.isManagedMacro(id)) return;
    const list = this.file.macros ?? [];
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return;
    this.file.macros = next.length ? next : undefined;
    await this.persist();
  }

  async setLastSession(name: string): Promise<void> {
    if (this.file.lastSession === name) return;
    this.file.lastSession = name;
    await this.persist();
  }
}

/** Secret-store keys, the same names as the extension uses. */
export function passwordKey(profileName: string, host: string): string {
  return `tn5250.password:${profileName || host}`;
}

export function certPassphraseKey(profileName: string, host: string): string {
  return `tn5250.certpass:${profileName || host}`;
}
