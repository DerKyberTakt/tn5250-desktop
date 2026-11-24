/**
 * Where a list stands that pages with More... / Bottom and has no scroll bar of the host.
 * The host does not say which page is shown, so the terminal counts: a page key that is
 * followed by other records moves one page, and Bottom gives the number of pages.
 */
export interface PagingState {
  /** Which list this is: its place on the screen and its heading. */
  key: string;
  /** The records shown, without the input fields. */
  body: string;
  /** Pages down from where the list was first seen. */
  page: number;
  /** The deepest page reached. */
  deepest: number;
  /** The number of pages, known once Bottom was seen. */
  pages?: number;
}

export interface PageView {
  key: string;
  body: string;
  end: 'more' | 'bottom';
}

/**
 * The state after a screen. `dir` is the page key waiting for its answer (1 = page down,
 * -1 = page up, 0 = none); `used` says whether this screen was that answer.
 */
export function nextPaging(prev: PagingState | undefined, view: PageView, dir: number): { state: PagingState; used: boolean } {
  if (!prev || prev.key !== view.key) {
    return { state: { key: view.key, body: view.body, page: 0, deepest: 0, pages: view.end === 'bottom' ? 1 : undefined }, used: false };
  }
  const moved = dir !== 0 && view.body !== prev.body;
  const page = moved ? Math.max(0, prev.page + dir) : prev.page;
  const deepest = Math.max(prev.deepest, page);
  // Bottom says this is the last page; More... on what was the last page says the list grew.
  let pages = prev.pages;
  if (view.end === 'bottom') pages = page + 1;
  else if (pages !== undefined && page >= pages - 1) pages = undefined;
  return { state: { key: view.key, body: view.body, page, deepest, pages }, used: moved };
}

/**
 * The scroll bar of the list in pages. While the number of pages is not known the bar has
 * one more page than the deepest one seen, so the thumb never sits at the end before Bottom.
 */
export function pagingBar(state: PagingState | undefined, end: 'more' | 'bottom'): { total: number; pos: number } {
  if (!state) return { total: 3, pos: end === 'bottom' ? 2 : 0 };
  if (state.pages !== undefined) return { total: state.pages, pos: Math.min(state.page, state.pages - 1) };
  return { total: Math.max(state.deepest, state.page) + 2, pos: state.page };
}
