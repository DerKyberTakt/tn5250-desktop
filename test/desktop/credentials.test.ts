import { beforeEach, describe, expect, it } from 'vitest';
import { Credentials, credentialKey } from '../../src/desktop/credentials';
import { Store } from '../../src/desktop/store';

// A fake Go host: an in-memory credential store and settings file.
const secrets = new Map<string, string>();
let settingsText = '';

beforeEach(() => {
  secrets.clear();
  settingsText = '';
  (globalThis as { window?: unknown }).window = {
    go: {
      main: {
        App: {
          SecretGet: async (k: string) => secrets.get(k) ?? '',
          SecretSet: async (k: string, v: string) => void secrets.set(k, v),
          SecretDelete: async (k: string) => void secrets.delete(k),
          SettingsLoad: async () => settingsText,
          SettingsSave: async (t: string) => void (settingsText = t),
        },
      },
    },
  };
});

describe('Credentials', () => {
  it('saves one password per USER@host and lists it without the password', async () => {
    const store = new Store();
    const creds = new Credentials(store);
    await creds.save('user1', 'PUB400.COM', 'secret');
    expect(secrets.get(credentialKey('USER1', 'pub400.com'))).toBe('secret');
    expect(await creds.find('User1', 'pub400.com')).toBe('secret');
    expect(creds.list()).toEqual([{ user: 'USER1', host: 'pub400.com' }]);
    expect(settingsText).toContain('USER1');
    expect(settingsText).not.toContain('secret');
  });

  it('moves passwords saved by older versions and does not bring them back after Remove', async () => {
    secrets.set('tn5250.password:My System', 'old-session-pw');
    secrets.set('tn5250.ifs:USER2@pub400.com', 'old-ifs-pw');
    const creds = new Credentials(new Store());

    expect(await creds.find('user1', 'pub400.com', 'My System')).toBe('old-session-pw');
    expect(secrets.has('tn5250.password:My System')).toBe(false);
    expect(secrets.get(credentialKey('user1', 'pub400.com'))).toBe('old-session-pw');

    expect(await creds.find('USER2', 'pub400.com')).toBe('old-ifs-pw');
    expect(secrets.has('tn5250.ifs:USER2@pub400.com')).toBe(false);

    await creds.remove('user1', 'pub400.com', 'My System');
    expect(await creds.find('user1', 'pub400.com', 'My System')).toBe('');
    expect(creds.list()).toEqual([{ user: 'USER2', host: 'pub400.com' }]);
  });

  it('finds nothing without a user or host', async () => {
    const creds = new Credentials(new Store());
    expect(await creds.find('', 'pub400.com')).toBe('');
    expect(await creds.find('user1', '')).toBe('');
  });
});
