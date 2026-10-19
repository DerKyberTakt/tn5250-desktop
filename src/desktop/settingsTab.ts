import { importKmp } from '../shared/kmpImport';
import { COLOR_KEYS, resolveSettings, type TerminalSettings } from '../shared/settings';
import type { HostToSettings, SettingsToHost } from '../shared/settingsProtocol';
import { errorText, goApp } from './bridge';
import { confirmDialog, promptDialog } from './dialogs';
import { certPassphraseKey, passwordKey, type Store } from './store';

export interface SettingsHost {
  readonly store: Store;
  openSession(profile: TerminalSettings): void;
  notify(text: string): void;
}

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
  }

  dispose(): void {
    this.frame.remove();
  }

  push(patch?: Partial<TerminalSettings>): void {
    void this.buildData(patch).then((msg) => this.frame.contentWindow?.postMessage(msg, location.origin && location.origin !== 'null' ? location.origin : '*'));
  }

  private async buildData(patch?: Partial<TerminalSettings>): Promise<HostToSettings> {
    const store = this.host.store;
    const defaults = store.readDefaults();
    const sessions = store.readSessions();
    const current = this.select < 0 ? defaults : resolveSettings(defaults, sessions[this.select] ?? { host: '' });
    const merged = { ...current, ...(patch ?? {}) };
    let watermarkImageData: string | undefined;
    if (merged.watermarkImage) {
      try {
        watermarkImageData = await goApp().ImageDataURL(merged.watermarkImage);
      } catch {
        watermarkImageData = undefined;
      }
    }
    return { type: 'data', defaults, sessions, select: this.select, patch, fonts: [], watermarkImageData };
  }

  private targetName(target: number): { name: string; host: string } {
    const store = this.host.store;
    if (target < 0) return { name: '', host: store.readDefaults().host };
    const s = store.readSessions()[target];
    return { name: s?.name ?? s?.host ?? '', host: s?.host ?? '' };
  }

  async handle(msg: SettingsToHost): Promise<void> {
    const store = this.host.store;
    const app = goApp();
    try {
      switch (msg.type) {
        case 'ready':
          this.push();
          break;
        case 'save':
          if (msg.target < 0) await store.writeDefaults(msg.values);
          else await store.saveSession(msg.target, msg.values);
          this.select = msg.target;
          this.push();
          this.host.notify('Settings saved');
          break;
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
        case 'setPassword':
        case 'setCertPassphrase': {
          const { name, host } = this.targetName(msg.target);
          const isPassword = msg.type === 'setPassword';
          const value = await promptDialog(isPassword ? `Sign-on password for ${name || 'Defaults'}` : `Certificate passphrase for ${name || 'Defaults'}`, isPassword ? 'Password' : 'Passphrase', {
            password: true,
            note: 'Stored in the operating system credential store. Leave empty to remove.',
          });
          if (value === undefined) break;
          const key = isPassword ? passwordKey(msg.target < 0 ? '' : name, host) : certPassphraseKey(msg.target < 0 ? '' : name, host);
          await app.SecretSet(key, value);
          this.host.notify(value ? 'Stored in the credential store' : 'Removed from the credential store');
          break;
        }
        case 'importKmp': {
          const file = await app.PickFile('Import ACS keyboard map', [{ name: 'ACS keyboard map', patterns: '*.kmp' }, { name: 'All files', patterns: '*.*' }]);
          if (!file) break;
          const result = importKmp(await app.ReadTextFile(file));
          const count = Object.keys(result.keymap).length;
          if (!count) {
            this.host.notify('No usable key assignments found in that file');
            break;
          }
          if (msg.target < 0) {
            const d = store.readDefaults();
            await store.writeDefaults({ ...d, keymap: { ...d.keymap, ...result.keymap } });
          } else {
            const sessions = store.readSessions();
            const s = sessions[msg.target];
            if (!s) break;
            s.keymap = { ...(s.keymap ?? {}), ...result.keymap };
            await store.writeSessions(sessions);
          }
          this.select = msg.target;
          this.push();
          this.host.notify(`Imported ${count} key assignment(s)${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`);
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
