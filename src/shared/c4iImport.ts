import type { SessionOverrides } from './settings';

/**
 * Import of Code for IBM i connections.
 *
 * Code for IBM i keeps its connections in the `code-for-ibmi.connections` user setting:
 * an array of { name, host, port, username, ... }. Its port is the SSH port, not the 5250
 * one, so the 5250 port and TLS come from a connection to the same host already saved in
 * the emulator (one imported from ACS, say); the caller asks for the rest. Passwords stay
 * in Code for IBM i's own secret storage, which no other extension can read; the private
 * key and passphrase fields are never read either.
 */

export interface PortChoice {
  port: number;
  tls: boolean;
}

export type C4iImport =
  | { ok: true; session: SessionOverrides; portKnown: boolean }
  | { ok: false; name: string; reason: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Reads the value of the `code-for-ibmi.connections` setting (anything that is not an array
 * gives no entries). `known` returns the 5250 port and TLS of a host already saved; a
 * connection whose host it does not know comes back without them (`portKnown: false`).
 */
export function importCodeForIbmi(value: unknown, known: (host: string) => PortChoice | undefined = () => undefined): C4iImport[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry: unknown): C4iImport => {
    const conn = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const name = text(conn.name);
    const host = text(conn.host);
    if (!host) return { ok: false, name: name || '(unnamed)', reason: 'no host name' };
    const session: SessionOverrides = { name: name || host, host };
    const port = known(host);
    if (port) {
      session.port = port.port;
      session.tls = port.tls;
    }
    const user = text(conn.username);
    if (user) session.signonUser = user;
    return { ok: true, session, portKnown: !!port };
  });
}
