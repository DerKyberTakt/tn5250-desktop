/**
 * The bar under the toolbar that leads back to the session while a tool page (Settings,
 * IFS, SQL, a file) is in front. One session has no tab, so without the bar the only way
 * back was the Connections panel.
 */
export interface BackBarState<T> {
  /** The tab bar is not shown (one session, one window, no split). */
  tabBarHidden: boolean;
  /** A session is the page in front. */
  sessionInFront: boolean;
  /** The sessions of this window, in tab order. */
  sessions: T[];
  /** The session that was in front last. */
  last: T | undefined;
}

/** The session the bar goes back to; undefined when no bar is needed. */
export function backTarget<T>(state: BackBarState<T>): T | undefined {
  if (!state.tabBarHidden || state.sessionInFront || state.sessions.length === 0) return undefined;
  return state.last !== undefined && state.sessions.includes(state.last) ? state.last : state.sessions[0];
}
