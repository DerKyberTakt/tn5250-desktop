/**
 * The Connections tree: every saved session with its open tabs (in any window) as
 * children, and the tabs of no saved session in a group of their own. Pure; the shell
 * renders it.
 */
import type { TerminalSettings } from '../shared/settings';
import type { RegistryEntry } from './relay';

export interface TreeRow {
  /** Index in the saved sessions list (for the settings page). */
  index: number;
  profile: TerminalSettings;
  tabs: RegistryEntry[];
  connected: number;
}

export interface Tree {
  rows: TreeRow[];
  /** Tabs that belong to no saved session (quick connects, command-line hosts). */
  others: RegistryEntry[];
}

const byLetter = (a: RegistryEntry, b: RegistryEntry): number => a.letter.localeCompare(b.letter, undefined, { numeric: true });

/**
 * Sessions with a connected tab first, then those with any tab, then the rest, each
 * group in saved order; tabs by letter. A tab belongs to the saved session with its
 * name and host.
 */
export function buildTree(sessions: TerminalSettings[], registry: RegistryEntry[]): Tree {
  const claimed = new Set<string>();
  const rows: TreeRow[] = sessions.map((profile, index) => {
    const tabs = registry.filter((t) => t.name === profile.name && t.host === profile.host).sort(byLetter);
    for (const t of tabs) claimed.add(t.tab);
    return { index, profile, tabs, connected: tabs.filter((t) => t.status === 'connected').length };
  });
  const rank = (r: TreeRow): number => (r.connected ? 0 : r.tabs.length ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  const others = registry.filter((t) => !claimed.has(t.tab)).sort(byLetter);
  return { rows, others };
}

/** "3 connected", "1 open" or '' for the badge next to a session. */
export function tabsBadge(row: TreeRow): string {
  if (row.connected) return `${row.connected} connected`;
  if (row.tabs.length) return `${row.tabs.length} open`;
  return '';
}
