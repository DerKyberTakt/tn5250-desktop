import { importKmp } from '../shared/kmpImport';
import { COLOR_KEYS, copySessionAt, describeChange, reloadPlan, resolveSettings, type TerminalSettings } from '../shared/settings';
import type { HostToSettings, SettingsToHost } from '../shared/settingsProtocol';
import { errorText, goApp } from './bridge';
import { confirmDialog, formDialog, listDialog, promptDialog } from './dialogs';
import type { Credentials } from './credentials';
import { certPassphraseKey, type Store } from './store';

export interface SettingsHost {
  readonly store: Store;
  readonly credentials: Credentials;
  openSession(profile: TerminalSettings): void;
  /** The open terminal tabs that have a session (not the demo screen). */
  openTerminals(): Array<{ tab: { readonly title: string; reload(profile: TerminalSettings): void }; profile: TerminalSettings; deviceTemplate: string }>;
  notify(text: string): void;
}

const ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';

/** The ACS-style settings page (the unchanged settings bundle) in a frame. */
export class SettingsTab {
  readonly frame: HTMLIFrameElement;
  readonly title = 'Settings';
  private select: number;

  constructor(
    private readonly host: SettingsHost,
    select = -1,
  ) {
    this.select = select;
    this.frame = document.createElement('iframe');
    this.frame.className = 'terminal-frame';
    this.frame.src = 'settings.html';
    this.frame.title = 'TN5250 Settings';
  }

  show(select: number): void {
    this.select = select;
    this.push();
  }

  focus(): void {
    this.frame.focus();
    this.frame.contentWindow?.focus();
  }

  dispose(): void {
    this.frame.remove();
  }

  push(patch?: Partial<TerminalSettings>): void {
    void this.buildData(patch).then((msg) => {
      this.send(msg);
      this.sendOpenTabs();
    });
  }

  private send(msg: HostToSettings): void {
    this.frame.contentWindow?.postMessage(msg, ORIGIN);
  }

  /** The open terminal tabs with a session, so the page can warn which ones a save would reload. */
  sendOpenTabs(): void {
    const tabs = this.host.openTerminals().map((t) => ({ title: t.tab.title, profile: t.profile, deviceTemplate: t.deviceTemplate }));
    this.send({ type: 'openTabs', tabs });
  }

  private async buildData(patch?: Partial<TerminalSettings>): Promise<HostToSettings> {
    const store = this.host.store;
    const defaults = store.readDefaults();
    const sessions = store.readSessions();
    const current = this.select < 0 ? defaults : resolveSettings(defaults, sessions[this.select] ?? { host: '' });
    const merged = { ...current, ...(patch ?? {}) };
    return { type: 'data', defaults, sessions, select: this.select, patch, fonts: [], watermarkImageData: await this.watermarkData(merged) };
  }

  /** The watermark image of a profile as a data URL, for the preview. */
  private async watermarkData(settings: TerminalSettings): Promise<string | undefined> {
    if (!settings.watermarkImage) return undefined;
    try {
      return await goApp().ImageDataURL(settings.watermarkImage);
    } catch {
      return undefined;
    }
  }

  private targetName(target: number): { name: string; host: string; user: string } {
    const store = this.host.store;
    const defaults = store.readDefaults();
    if (target < 0) return { name: '', host: defaults.host, user: defaults.signonUser };
    const s = store.readSessions()[target];
    const resolved = s ? resolveSettings(defaults, s) : defaults;
    return { name: s?.name ?? s?.host ?? '', host: s?.host ?? '', user: resolved.signonUser };
  }

  async handle(msg: SettingsToHost): Promise<void> {
    const store = this.host.store;
    const app = goApp();
    try {
      switch (msg.type) {
        case 'ready':
          this.push();
          break;
        case 'save': {
          // Changes that only apply on a new connection: offer to reconnect the open tabs that use them.
          const changes = msg.connectionChanges ?? [];
          const sessions = store.readSessions();
          const plan = changes.length ? reloadPlan(msg.target, msg.values, sessions, this.host.openTerminals(), changes) : [];
          let reload = false;
          if (plan.length) {
            const before = msg.target < 0 ? store.readDefaults() : resolveSettings(store.readDefaults(), sessions[msg.target] ?? { host: '' });
            const pick = await listDialog(
              plan.length === 1 ? 'Reload the open tab?' : `Reload the ${plan.length} open tabs?`,
              'Save & Reload reconnects the tabs below now. Apply & Continue saves and leaves them running until they reconnect.',
              [
                ...changes.map((k) => `Change: ${describeChange(k, before, msg.values)}`),
                ...plan.map(({ tab, profile }) => `Tab: ${tab.title} (${profile.name || profile.host})`),
              ],
              [],
              ['Save & Reload', 'Apply & Continue'],
            );
            if (!pick) break; // Close: nothing saved, the page stays dirty
            reload = pick.action === 'Save & Reload';
          }
          if (msg.target < 0) await store.writeDefaults(msg.values);
          else await store.saveSession(msg.target, msg.values);
          this.select = msg.target;
          this.push();
          if (reload) for (const { tab, profile } of plan) tab.reload(profile);
          this.host.notify(reload ? 'Settings saved, tabs reloaded' : plan.length ? 'Settings applied' : 'Settings saved');
          break;
        }
        case 'select': {
          // The page switched profiles: send that profile's watermark image for the preview.
          this.select = msg.index;
          const defaults = store.readDefaults();
          const current = msg.index < 0 ? defaults : resolveSettings(defaults, store.readSessions()[msg.index] ?? { host: '' });
          this.send({ type: 'assets', select: msg.index, watermarkImageData: await this.watermarkData(current) });
          break;
        }
        case 'copySession': {
          const copied = copySessionAt(store.readSessions(), msg.index);
          if (!copied) break;
          await store.writeSessions(copied.sessions);
          this.select = copied.index;
          this.push();
          break;
        }
        case 'addSession': {
          const sessions = store.readSessions();
          sessions.push({ host: '', name: 'New session' });
          await store.writeSessions(sessions);
          this.select = sessions.length - 1;
          this.push();
          break;
        }
        case 'removeSession': {
          const name = store.readSessions()[msg.index]?.name ?? 'this session';
          if (await confirmDialog('Remove session', `Remove "${name}"?`, 'Remove')) {
            await store.removeSessionAt(msg.index);
            this.select = -1;
            this.push();
          }
          break;
        }
        case 'connect': {
          const entry = store.readSessions()[msg.index];
          if (entry?.host) this.host.openSession(resolveSettings(store.readDefaults(), entry));
          break;
        }
        case 'setPassword': {
          const { name, host, user } = this.targetName(msg.target);
          const values = await formDialog(
            `Saved password${name ? ` for ${name}` : ''}`,
            [
              { label: 'Host', value: host },
              { label: 'User profile', value: user },
              { label: 'Password', password: true },
            ],
            'Save',
            'One password per user profile and host, kept in the operating system credential store and shared by bypass sign-on, the IFS browser and the other tools. Leave the password empty to remove it.',
          );
          if (!values) break;
          const [h = '', u = '', pw = ''] = values.map((v) => v.trim());
          if (!h || !u) {
            this.host.notify('Host and user profile are needed');
            break;
          }
          if (pw) await this.host.credentials.save(u, h, pw);
          else await this.host.credentials.remove(u, h, name);
          this.host.notify(pw ? `Password for ${u.toUpperCase()}@${h} saved` : `Password for ${u.toUpperCase()}@${h} removed`);
          break;
        }
        case 'setCertPassphrase': {
          const { name, host } = this.targetName(msg.target);
          const value = await promptDialog(`Certificate passphrase for ${name || 'Defaults'}`, 'Passphrase', {
            password: true,
            note: 'Stored in the operating system credential store. Leave empty to remove.',
          });
          if (value === undefined) break;
          const key = certPassphraseKey(msg.target < 0 ? '' : name, host);
          await app.SecretSet(key, value);
          this.host.notify(value ? 'Stored in the credential store' : 'Removed from the credential store');
          break;
        }
        case 'importKmp': {
          // The page merges the keys into its unsaved edits; nothing is written until Save.
          const file = await app.PickFileIn('Import ACS keyboard map', [{ name: 'ACS keyboard map', patterns: '*.kmp' }, { name: 'All files', patterns: '*.*' }], '~/Documents/IBM/iAccessClient/Emulator');
          if (!file) break;
          const result = importKmp(await app.ReadTextFile(file));
          if (!Object.keys(result.keymap).length) {
            this.host.notify('No usable key assignments found in that file');
            break;
          }
          this.send({ type: 'kmp', keymap: result.keymap, skipped: result.skipped.length });
          break;
        }
        case 'browseFile': {
          const pem = msg.key === 'tlsClientKey';
          const file = await app.PickFile(pem ? 'Client private key (PEM)' : 'Client certificate (PKCS#12 or PEM)', pem
            ? [{ name: 'PEM key', patterns: '*.pem;*.key' }, { name: 'All files', patterns: '*.*' }]
            : [{ name: 'Certificates', patterns: '*.pfx;*.p12;*.pem;*.crt;*.cer' }, { name: 'All files', patterns: '*.*' }]);
          if (file) this.push({ [msg.key]: file } as Partial<TerminalSettings>);
          break;
        }
        case 'browseFont':
          this.host.notify('Importing font files is not available in the desktop app yet; pick an installed font');
          break;
        case 'browseWatermark': {
          const file = await app.PickFile('Watermark image', [{ name: 'Images', patterns: '*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp' }]);
          if (file) this.push({ watermarkImage: file, watermarkType: 'image' });
          break;
        }
        case 'exportColors':
          await app.SaveTextFile('Export colour scheme', 'tn5250-colors.json', JSON.stringify(msg.values, null, 2) + '\n', [{ name: 'JSON', patterns: '*.json' }]);
          break;
        case 'importColors': {
          const file = await app.PickFile('Import colour scheme', [{ name: 'JSON', patterns: '*.json' }]);
          if (!file) break;
          const parsed = JSON.parse(await app.ReadTextFile(file)) as Record<string, unknown>;
          const patch: Partial<TerminalSettings> = {};
          for (const k of COLOR_KEYS) {
            const v = parsed[k];
            if (typeof v === 'string') (patch as Record<string, unknown>)[k] = v;
          }
          this.push(patch);
          break;
        }
        case 'openJson': {
          const path = await app.SettingsFilePath();
          await app.ClipboardSet(path);
          this.host.notify(`Settings file: ${path} (path copied)`);
          break;
        }
      }
    } catch (err) {
      this.host.notify(errorText(err));
    }
  }
}
