import { importHod } from '../shared/hodImport';
import { isSaved, mergeImported, type MergeResult } from '../shared/sessionImport';
import type { SessionOverrides } from '../shared/settings';

/**
 * File > Import Connections: ACS session profiles (.hod) into the saved sessions. The
 * readers are shared with the VS Code extension (src/shared); this file holds the parts
 * the shell needs around them, without any DOM, so they can be tested.
 */

/** Where ACS keeps its session profiles and keyboard maps; the Go side expands '~'. */
export const ACS_EMULATOR_DIR = '~/Documents/IBM/iAccessClient/Emulator';

export const HOD_FILTERS = [
  { name: 'ACS session profile', patterns: '*.hod' },
  { name: 'All files', patterns: '*.*' },
];

export interface FoundSession {
  session: SessionOverrides;
  notes: string[];
}

export interface Found {
  /** The 5250 display sessions, in file order. Printer, 3270 and VT profiles are left out without a word. */
  sessions: FoundSession[];
  /** Files that could not be read: an error, not a filter, so the message says so. */
  unreadable: number;
}

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Reads and parses the .hod files; `read` is the Go ReadTextFile. */
export async function readProfiles(files: string[], read: (path: string) => Promise<string>): Promise<Found> {
  const found: Found = { sessions: [], unreadable: 0 };
  for (const file of files) {
    let text: string;
    try {
      text = await read(file);
    } catch {
      found.unreadable++;
      continue;
    }
    const r = importHod(text, fileName(file));
    if (r.ok) found.sessions.push({ session: r.session, notes: r.notes });
  }
  return found;
}

export interface ImportRow {
  label: string;
  detail: string;
  /** The connection is already saved and would be updated in place. */
  replaces: boolean;
}

/** One row per found session for the pick list. */
export function importRows(found: FoundSession[], saved: SessionOverrides[]): ImportRow[] {
  return found.map(({ session, notes }) => {
    const where = `${session.host}${session.port ? `:${session.port}` : ''}${session.tls ? ' TLS' : ''}`;
    const parts = [
      where,
      session.screenSize,
      session.codePage !== undefined ? `CCSID ${session.codePage}` : undefined,
      session.deviceName ? `device ${session.deviceName}` : undefined,
      session.signonUser ? `user ${session.signonUser}` : undefined,
      ...notes,
    ].filter((p): p is string => !!p);
    return { label: session.name || session.host, detail: parts.join(', '), replaces: isSaved(saved, session) };
  });
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function unreadableNote(unreadable: number): string {
  return unreadable ? ` ${plural(unreadable, 'file')} could not be read.` : '';
}

/** The status line after an import. */
export function importMessage(merged: MergeResult, unreadable: number): string {
  const replaced = merged.replaced.length ? ` (${merged.replaced.length} updated)` : '';
  const skipped = merged.skipped.length ? ` ${plural(merged.skipped.length, 'saved connection')} left as ${merged.skipped.length === 1 ? 'it was' : 'they were'}.` : '';
  return `${plural(merged.touched.length, 'connection')} imported${replaced}.${skipped}${unreadableNote(unreadable)}`;
}

/** What an import that changed nothing says. */
export function nothingImported(merged: MergeResult): string {
  const n = merged.skipped.length;
  return `Nothing imported: the ${plural(n, 'selected connection')} ${n === 1 ? 'is' : 'are'} already saved.`;
}

export { mergeImported };
