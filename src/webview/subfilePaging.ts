/**
 * Where a list stands that pages with More... / Bottom and has no scroll bar of the host.
 * The host does not say which page is shown, so the terminal keeps the pages it has seen:
 * a screen that answers a page key with other records is the page before or after, a page
 * seen before is recognised by its records, and Bottom gives the number of pages.
 */
export interface PagingState {
  /** Which list this is: its place on the screen and its heading. */
  key: string;
  /** The records of every page seen, in order; the first is where the list was first seen. */
  pages: string[];
  /** Index in `pages` of the page shown. */
  page: number;
  /** Index of the page that showed Bottom, once seen. */
  last?: number;
  /** The list as it was before other records took its place (a window over it, or a reload). */
  earlier?: PagingState;
}

export interface PageView {
  key: string;
  /** The rows of the list, without what is typed into them. */
  rows: string[];
  end: 'more' | 'bottom';
}

const SEP = '\n';

/** True when at least half of the rows that hold text are the same in both pages, row by row. */
function alike(a: string, b: string): boolean {
  const x = a.split(SEP);
  const y = b.split(SEP);
  let filled = 0;
  let same = 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? '';
    const q = y[i] ?? '';
    if (p.trim() === '' && q.trim() === '') continue;
    filled++;
    if (p === q) same++;
  }
  return same > 0 && same * 2 >= filled;
}

/** Notes what the page shown says about the end of the list. */
function withEnd(state: PagingState, end: 'more' | 'bottom'): PagingState {
  if (end === 'bottom') return { ...state, pages: state.pages.slice(0, state.page + 1), last: state.page };
  // More... on what was the last page: the list grew.
  if (state.last !== undefined && state.page >= state.last) return { ...state, last: undefined };
  return state;
}

/**
 * The state after a screen. `paged` says what the screen answers: 1 = Page Down, -1 = Page Up,
 * 0 = something else (the engine knows which key it sent last).
 */
export function nextPaging(prev: PagingState | undefined, view: PageView, paged: number): PagingState {
  const body = view.rows.join(SEP);
  const fresh = (earlier?: PagingState): PagingState => withEnd({ key: view.key, pages: [body], page: 0, earlier }, view.end);
  if (!prev || prev.key !== view.key) return fresh();
  const current = prev.pages[prev.page];
  // The same records: nothing moved (also a refused key: roll past the first or last record).
  if (body === current) return withEnd(prev, view.end);

  if (paged !== 0) {
    // The answer to a page key with other records is the page after or before; from here on this is the list.
    const pages = prev.pages.slice();
    let page = prev.page + (paged > 0 ? 1 : -1);
    let last = prev.last;
    if (page < 0) {
      // Above where the list was first seen.
      pages.unshift(body);
      page = 0;
      if (last !== undefined) last += 1;
    } else {
      pages[page] = body;
    }
    return withEnd({ key: prev.key, pages, page, last }, view.end);
  }

  // Other records without a page key. A page seen before: the list stands there (redisplayed from the top, or back from a window).
  const known = prev.pages.indexOf(body);
  if (known >= 0) return withEnd({ ...prev, page: known }, view.end);
  const back = prev.earlier?.pages.indexOf(body) ?? -1;
  if (prev.earlier && back >= 0) return withEnd({ ...prev.earlier, page: back }, view.end);
  // Most rows as they were: records changed in place (an option was run, a status changed).
  if (alike(current ?? '', body)) {
    const pages = prev.pages.slice();
    pages[prev.page] = body;
    return withEnd({ ...prev, pages }, view.end);
  }
  // Something else stands there: a list loaded again starts at its first page. What was counted
  // is kept once, in case the old records come back (a window that covered them was closed).
  const keep = prev.pages.length > 1 || !prev.earlier ? { ...prev, earlier: undefined } : prev.earlier;
  return fresh(keep);
}

/**
 * The scroll bar of the list in pages. While the number of pages is not known the bar has
 * one more page than were seen, so the thumb never sits at the end before Bottom.
 */
export function pagingBar(state: PagingState | undefined, end: 'more' | 'bottom'): { total: number; pos: number } {
  if (!state) return { total: 3, pos: end === 'bottom' ? 2 : 0 };
  const total = state.last !== undefined ? state.last + 1 : state.pages.length + 1;
  return { total, pos: Math.min(state.page, total - 1) };
}
