import { describe, expect, it } from 'vitest';
import { nextPaging, pagingBar, type PageView, type PagingState } from '../../src/webview/subfilePaging';

const view = (body: string, end: 'more' | 'bottom' = 'more', key = '7|Opt Invoice'): PageView => ({ key, body, end });
/** Runs screens through the tracker; each step is [view, pending page key]. */
function run(steps: Array<[PageView, number]>): PagingState {
  let state: PagingState | undefined;
  for (const [v, dir] of steps) state = nextPaging(state, v, dir).state;
  return state as PagingState;
}

describe('nextPaging', () => {
  it('starts on the first page, and the thumb moves a page for every page key the host answers with other records', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1]]);
    expect(s.page).toBe(2);
    // The bug: the thumb stayed at the top of the bar on every page but the last.
    expect(pagingBar(s, 'more')).toEqual({ total: 4, pos: 2 });
    expect(pagingBar(run([[view('p1'), 0]]), 'more')).toEqual({ total: 2, pos: 0 });
  });

  it('goes back a page on page up', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1], [view('p2'), -1]]);
    expect(s.page).toBe(1);
    expect(pagingBar(s, 'more')).toEqual({ total: 4, pos: 1 });
  });

  it('does not move when the host refuses the key (same records: roll past the first or last record)', () => {
    const first = nextPaging(undefined, view('p1'), 0).state;
    const refused = nextPaging(first, view('p1'), -1);
    expect(refused.used).toBe(false);
    expect(refused.state.page).toBe(0);
  });

  it('says whether the screen was the answer to the page key', () => {
    const first = nextPaging(undefined, view('p1'), 0).state;
    expect(nextPaging(first, view('p2'), 1).used).toBe(true);
    expect(nextPaging(first, view('p2'), 0).used).toBe(false);
    // Records that change without a page key (a refresh) leave the page alone.
    expect(nextPaging(first, view('p1 refreshed'), 0).state.page).toBe(0);
  });

  it('knows the number of pages once Bottom is seen, and the thumb is at the end there', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3', 'bottom'), 1]]);
    expect(s.pages).toBe(3);
    expect(pagingBar(s, 'bottom')).toEqual({ total: 3, pos: 2 });
    const back = nextPaging(s, view('p2'), -1).state;
    expect(pagingBar(back, 'more')).toEqual({ total: 3, pos: 1 });
  });

  it('a list of one page fills the bar', () => {
    expect(pagingBar(run([[view('p1', 'bottom'), 0]]), 'bottom')).toEqual({ total: 1, pos: 0 });
  });

  it('forgets the number of pages when the last page shows More... again', () => {
    const s = run([[view('p1'), 0], [view('p2', 'bottom'), 1], [view('p2 and more', 'more'), 0]]);
    expect(s.pages).toBeUndefined();
    expect(pagingBar(s, 'more')).toEqual({ total: 3, pos: 1 });
  });

  it('never goes above the page the list was first seen on', () => {
    // A program can open a list in the middle; a page up from there shows other records.
    const s = run([[view('p5'), 0], [view('p4'), -1]]);
    expect(s.page).toBe(0);
  });

  it('starts again for another list', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('x1', 'more', '9|Other list'), 1]]);
    expect(s.page).toBe(0);
    expect(s.deepest).toBe(0);
  });

  it('keeps the old picture when nothing is known (no state)', () => {
    expect(pagingBar(undefined, 'more')).toEqual({ total: 3, pos: 0 });
    expect(pagingBar(undefined, 'bottom')).toEqual({ total: 3, pos: 2 });
  });
});
