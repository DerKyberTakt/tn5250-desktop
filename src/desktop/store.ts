import {
  SETTINGS_DEFAULTS,
  diffSettings,
  resolveSettings,
  type SessionOverrides,
  type TerminalSettings,
} from '../shared/settings';
import { goApp } from './bridge';

/**
 * settings.json in the user config directory (Windows: %APPDATA%\tn5250-terminal,
 * Linux: ~/.config/tn5250-terminal). Defaults and sessions are stored as the values
 * that differ from the built-in defaults, the same model as the VS Code extension.
 */
interface SettingsFile {
  version: 1;
  defaults: Partial<TerminalSettings>;
  sessions: SessionOverrides[];
  lastSession?: string;
  /** Check GitHub for a newer release at startup (Help menu); on unless false. */
  checkForUpdates?: boolean;
}

type Listener = () => void;

export class Store {
  private file: SettingsFile = { version: 1, defaults: {}, sessions: [] };
  private readonly listeners = new Set<Listener>();

  async load(): Promise<void> {
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
    };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await goApp().SettingsSave(JSON.stringify(this.file, null, 2) + '\n');
    for (const l of this.listeners) l();
  }

  readDefaults(): TerminalSettings {
    const d = resolveSettings(SETTINGS_DEFAULTS, this.file.defaults);
    // resolveSettings fills an empty name from the host; defaults have no name.
    d.name = '';
    return d;
  }

  async writeDefaults(values: TerminalSettings): Promise<void> {
    const diff: Partial<TerminalSettings> = diffSettings(SETTINGS_DEFAULTS, values);
    if (!values.host) delete diff.host;
    delete diff.name;
    this.file.defaults = diff;
    await this.persist();
  }

  readSessions(): SessionOverrides[] {
    return this.file.sessions.map((s) => ({ ...s }));
  }

  resolvedSessions(): TerminalSettings[] {
    const defaults = this.readDefaults();
    return this.file.sessions.filter((s) => s.host.trim()).map((s) => resolveSettings(defaults, s));
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
    return this.file.checkForUpdates !== false;
  }

  async setCheckForUpdates(on: boolean): Promise<void> {
    this.file.checkForUpdates = on;
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
