/** What identifies a saved connection: its name and host. */
export interface ProfileRef {
  name?: string;
  host?: string;
}

/**
 * The saved connection a session belongs to, as its index in the list; undefined when there is
 * no session, or it has no saved connection (the demo screen, a quick connection).
 */
export function profileIndexOf(sessions: readonly ProfileRef[], active: ProfileRef | undefined): number | undefined {
  if (!active) return undefined;
  const { name, host } = active;
  const find = (match: (s: ProfileRef) => boolean): number | undefined => {
    const i = sessions.findIndex(match);
    return i >= 0 ? i : undefined;
  };
  if (name) return find((s) => s.name === name && s.host === host) ?? find((s) => s.name === name);
  if (host) return find((s) => !s.name && s.host === host);
  return undefined;
}

/**
 * What a click on Settings does. The page opens on the connection of the session being looked
 * at. Without one it opens on `fallback`, and a page that is open already is left on the
 * profile it shows, so unsaved changes there are not thrown away by coming back to it.
 *
 * @param shown the profile the open Settings page shows (-1 = Defaults), undefined when it is closed
 */
export function settingsTarget(
  sessions: readonly ProfileRef[],
  active: ProfileRef | undefined,
  shown: number | undefined,
  fallback: number,
): { select: number } | 'keep' {
  const target = profileIndexOf(sessions, active);
  if (shown === undefined) return { select: target ?? fallback };
  if (target === undefined || target === shown) return 'keep';
  return { select: target };
}
