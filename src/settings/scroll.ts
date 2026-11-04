/**
 * Keeps the scroll position of the settings page across a rebuild of its DOM.
 * Pure: the scrollable elements are reached through injected getters, so it runs
 * (and is tested) with plain objects, no DOM.
 */

/** Anything with a scrollTop, which is all an element has to offer here. */
export interface Scrollable {
  scrollTop: number;
}

/** The scrollable areas of the page by name (e.g. nav, main); an entry is missing while it is not on the page. */
export type ScrollTargets = Record<string, Scrollable | null | undefined>;

/** scrollTop per named area. */
export type ScrollState = Record<string, number>;

export function captureScroll(targets: ScrollTargets): ScrollState {
  const state: ScrollState = {};
  for (const [name, t] of Object.entries(targets)) if (t) state[name] = t.scrollTop;
  return state;
}

/** Puts back the captured positions of `only` (default: all) on the areas that exist now. */
export function restoreScroll(targets: ScrollTargets, state: ScrollState, only?: readonly string[]): void {
  for (const [name, top] of Object.entries(state)) {
    if (only && !only.includes(name)) continue;
    const t = targets[name];
    if (t && t.scrollTop !== top) t.scrollTop = top;
  }
}

export interface PreserveOptions {
  /** Names of the areas to restore; the others start at the top again (a different page was opened). Default: all. */
  restore?: readonly string[];
  /** Runs the second restore after layout (requestAnimationFrame in the page); without it only the synchronous one runs. */
  defer?: (fn: () => void) => void;
}

/**
 * Runs `rebuild` (which replaces the DOM) and gives the scroll position back in the same
 * frame: once right after the swap, and once more after layout when `defer` is given
 * (images, fonts and zoomed blocks can change heights a moment later).
 * `getTargets` is called again after the rebuild because the elements are new ones.
 */
export function preserveScroll(getTargets: () => ScrollTargets, rebuild: () => void, opts: PreserveOptions = {}): void {
  const state = captureScroll(getTargets());
  rebuild();
  restoreScroll(getTargets(), state, opts.restore);
  opts.defer?.(() => restoreScroll(getTargets(), state, opts.restore));
}
