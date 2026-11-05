/** One past (or running) connection, as the History view shows it. */
import { isSignonScreen } from './screenText';
export interface HistoryEntry {
  id: string;
  /** Saved session name, '' for an ad-hoc host. */
  sessionName: string;
  host: string;
  port: number;
  tls: boolean;
  screenSize: string;
  /** Workstation (device) name the host accepted; '' when the host assigned one we never saw. */
  deviceName: string;
  /** User profile typed on the sign-on screen or used for bypass sign-on; '' when unknown. */
  user: string;
  tabTitle: string;
  /** Epoch ms. */
  start: number;
  end?: number;
  endedBy?: 'user' | 'host' | 'error' | 'reload' | 'closed';
  /** Epoch ms of the last heartbeat while open; the end time if the process died with the tab open. */
  seen?: number;
}

/** Entries still open from a process that is gone are closed at the time they were last seen alive. */
export function closeOrphans(list: HistoryEntry[]): HistoryEntry[] {
  return list.map((e) => (e.end ? e : { ...e, end: e.seen ?? e.start, endedBy: 'closed' as const }));
}

/** Marks the open entries with these ids as alive now. */
export function touchEntries(list: HistoryEntry[], ids: Iterable<string>, now = Date.now()): HistoryEntry[] {
  const open = new Set(ids);
  return list.map((e) => (!e.end && open.has(e.id) ? { ...e, seen: now } : e));
}

/** Adds (or replaces, by id) an entry at the front and keeps at most `cap` entries. */
export function pushHistory(list: HistoryEntry[], entry: HistoryEntry, cap: number): HistoryEntry[] {
  const rest = list.filter((e) => e.id !== entry.id);
  return [entry, ...rest].slice(0, Math.max(1, cap));
}

/** "12s", "4m", "1h 05m", "2d 3h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** The one-line summary under an entry: "JSMITH@DEV01 · 11/03 09:14 · 12m". */
export function describeEntry(e: HistoryEntry, now = Date.now()): string {
  const who = [e.user, e.deviceName].filter(Boolean).join('@');
  const when = new Date(e.start).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const length = e.end ? formatDuration(e.end - e.start) : `${formatDuration(now - e.start)}, open`;
  return [who, when, length].filter(Boolean).join(' · ');
}

/**
 * The user profile typed on an IBM i sign-on screen, read from the screen text when
 * Enter is pressed: a row says "Sign On" near the top and a later row starts with "User"
 * followed by dots or a colon and the value. '' when the screen is not a sign-on screen.
 */
export function signonUser(screenText: string): string {
  if (!isSignonScreen(screenText)) return '';
  const rows = screenText.split(/\r?\n/);
  for (const row of rows) {
    const m = /^\s*User\b[\s.:]*([A-Za-z0-9$#@_]{1,10})\s*$/.exec(row) ?? /^\s*User\b[\s.:]*([A-Za-z0-9$#@_]{1,10})\s{2,}/.exec(row);
    if (m) return (m[1] as string).toUpperCase();
  }
  return '';
}
