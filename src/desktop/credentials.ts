/**
 * Saved IBM i passwords: one per USER@host in the operating system credential store
 * (Windows Credential Manager, the Secret Service keyring on Linux), shared by 5250
 * bypass sign-on, the IFS browser and the other host-server tools. settings.json only
 * lists which USER@host entries exist (for Tools > Saved Passwords), never a password.
 *
 * Passwords saved by earlier versions (per session name, or IFS-only) are still found
 * and moved to the shared key the first time they are used.
 */
import { goApp } from './bridge';
import type { Store } from './store';

export interface Credential {
  user: string;
  host: string;
}

export function credentialKey(user: string, host: string): string {
  return `tn5250.cred:${user.trim().toUpperCase()}@${host.trim().toLowerCase()}`;
}

/** Keys of earlier versions, oldest last. */
function legacyKeys(user: string, host: string, profileName: string): string[] {
  const h = host.trim();
  return [`tn5250.ifs:${user.trim().toUpperCase()}@${h.toLowerCase()}`, `tn5250.password:${profileName || h}`, `tn5250.password:${h}`];
}

export class Credentials {
  constructor(private readonly store: Store) {}

  /** The saved password for user@host ('' when none). profileName finds passwords saved per session by older versions. */
  async find(user: string, host: string, profileName = ''): Promise<string> {
    if (!user.trim() || !host.trim()) return '';
    const app = goApp();
    try {
      const current = await app.SecretGet(credentialKey(user, host));
      if (current) return current;
      for (const key of legacyKeys(user, host, profileName)) {
        const old = await app.SecretGet(key);
        if (old) {
          // Move it: a password removed later must not come back from the old key.
          await this.save(user, host, old);
          await app.SecretDelete(key).catch(() => undefined);
          return old;
        }
      }
    } catch {
      // credential store not available: behave as if nothing is saved
    }
    return '';
  }

  async save(user: string, host: string, password: string): Promise<void> {
    await goApp().SecretSet(credentialKey(user, host), password);
    await this.store.addCredential({ user: user.trim().toUpperCase(), host: host.trim().toLowerCase() });
  }

  /** Forgets the password, including copies under the keys of earlier versions. */
  async remove(user: string, host: string, profileName = ''): Promise<void> {
    const app = goApp();
    for (const key of [credentialKey(user, host), ...legacyKeys(user, host, profileName)]) {
      await app.SecretDelete(key).catch(() => undefined);
    }
    await this.store.removeCredential({ user: user.trim().toUpperCase(), host: host.trim().toLowerCase() });
  }

  list(): Credential[] {
    return this.store.credentials;
  }
}
