import type { SessionOverrides } from './settings';

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * Index of the saved connection an imported one corresponds to, or -1: same host and the
 * same name, or the name an earlier import gave it to keep names unique ("Prod (2)" for
 * "Prod"). Case is ignored.
 */
export function savedIndex(saved: SessionOverrides[], session: SessionOverrides): number {
  const host = norm(session.host);
  const name = norm(session.name) || host;
  return saved.findIndex((s) => {
    if (norm(s.host) !== host) return false;
    const other = norm(s.name) || host;
    return other === name || (other.startsWith(`${name} (`) && /^ \(\d+\)$/.test(other.slice(name.length)));
  });
}

/** True when the connection is already saved (see savedIndex). */
export function isSaved(saved: SessionOverrides[], session: SessionOverrides): boolean {
  return savedIndex(saved, session) >= 0;
}

export interface MergeResult {
  /** The saved list with the imported connections merged in. */
  sessions: SessionOverrides[];
  /** The connections appended, with their final names. */
  added: SessionOverrides[];
  /** The saved connections an import replaced, as they are now. */
  replaced: SessionOverrides[];
  /** The imported connections left out because they were already saved (updateSaved false). */
  skipped: SessionOverrides[];
  /** Saved TLS connections the profile wanted as plain telnet: TLS (and the saved port) were kept. */
  tlsKept: SessionOverrides[];
  /**
   * Saved connections whose host, port or TLS changed and that had a sign-on user: the
   * sign-on user and bypass sign-on were cleared on the merged entry. The entries are
   * given as they were before the import, so the caller can delete the stored password
   * (the secret store key follows USER@host) unless another connection still uses it.
   */
  credentialsReset: SessionOverrides[];
  /** Index in `sessions` of every connection the import added or replaced, in import order. */
  touched: number[];
}

export interface MergeOptions {
  /**
   * What to do with an imported connection that is already saved: replace the saved entry
   * (the default) or leave it exactly as it is and only add the new ones.
   */
  updateSaved?: boolean;
}

/**
 * Merges imported connections into the saved list. One that is already saved replaces the
 * saved entry in place: every value the import brings wins, and what only the emulator
 * has (a trusted certificate, demo mode ...) stays, as does the saved name.
 * With `updateSaved: false` it is skipped instead, so nothing already saved changes.
 * An import never turns TLS off on a saved TLS connection (TLS and the saved port stay,
 * see tlsKept), and a saved sign-on user and bypass sign-on never follow a connection to
 * another host, port or TLS setting (see credentialsReset).
 * A new one is appended; a name already used by a connection to another host gets " (2)",
 * " (3)" ... so every name stays unique. The list given is never changed.
 */
export function mergeImported(saved: SessionOverrides[], incoming: SessionOverrides[], options: MergeOptions = {}): MergeResult {
  const sessions = [...saved];
  const added: SessionOverrides[] = [];
  const replaced: SessionOverrides[] = [];
  const skipped: SessionOverrides[] = [];
  const touched: number[] = [];
  const tlsKept: SessionOverrides[] = [];
  const credentialsReset: SessionOverrides[] = [];
  const names = new Set(saved.map((s) => norm(s.name)));
  for (const s of incoming) {
    const at = savedIndex(sessions, s);
    if (at >= 0 && at < saved.length && options.updateSaved === false) {
      skipped.push(s);
      continue;
    }
    if (at >= 0) {
      const current = sessions[at] as SessionOverrides;
      const entry: SessionOverrides = { ...current, ...s, name: current.name ?? s.name };
      if (current.tls === true && entry.tls !== true) {
        entry.tls = true;
        if (current.port !== undefined) entry.port = current.port;
        else delete entry.port;
        tlsKept.push(entry);
      }
      const where = (x: SessionOverrides): string => `${norm(x.host)}:${x.port ?? (x.tls ? 992 : 23)}:${x.tls === true}`;
      if (where(entry) !== where(current)) {
        if (current.signonUser || current.autoSignon) credentialsReset.push(current);
        delete entry.signonUser;
        delete entry.autoSignon;
      }
      sessions[at] = entry;
      if (!touched.includes(at)) {
        touched.push(at);
        if (at < saved.length) replaced.push(entry);
      }
      continue;
    }
    const base = (s.name ?? '').trim() || s.host.trim();
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    names.add(name.toLowerCase());
    const entry: SessionOverrides = { ...s, name };
    sessions.push(entry);
    added.push(entry);
    touched.push(sessions.length - 1);
  }
  return { sessions, added, replaced, skipped, tlsKept, credentialsReset, touched };
}
