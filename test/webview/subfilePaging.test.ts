import { describe, expect, it } from 'vitest';
import { nextPaging, pagingBar, type PageView, type PagingState } from '../../src/webview/subfilePaging';

/** A page of four records named after `name`. */
const page = (name: string): string[] => [`${name} a`, `${name} b`, `${name} c`, `${name} d`];
const view = (rows: string | string[], end: 'more' | 'bottom' = 'more', key = '7|Opt Invoice'): PageView => ({ key, rows: typeof rows === 'string' ? page(rows) : rows, end });
/** Runs screens through the tracker; each step is [view, the page key the screen answers]. */
function run(steps: Array<[PageView, number]>, from?: PagingState): PagingState {
  let state = from;
  for (const [v, paged] of steps) state = nextPaging(state, v, paged);
  return state as PagingState;
}
const bar = (s: PagingState, end: 'more' | 'bottom' = 'more'): string => {
  const b = pagingBar(s, end);
  return `${b.pos}/${b.total}`;
};

describe('nextPaging', () => {
  it('starts on the first page, and the thumb moves a page for every page key the host answers with other records', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1]]);
    expect(s.page).toBe(2);
    expect(bar(s)).toBe('2/4');
    expect(bar(run([[view('p1'), 0]]))).toBe('0/2');
  });

  it('goes back a page on page up, and the bar keeps its length', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1], [view('p2'), -1]]);
    expect(bar(s)).toBe('1/4');
    expect(bar(run([[view('p1'), -1]], s))).toBe('0/4');
  });

  it('does not move when the host refuses the key (same records: roll past the first or last record)', () => {
    const top = run([[view('p1'), 0], [view('p1'), -1], [view('p1'), -1]]);
    expect(bar(top)).toBe('0/2');
    const end = run([[view('p2', 'bottom'), 1], [view('p2', 'bottom'), 1]], top);
    expect(bar(end, 'bottom')).toBe('1/2');
  });

  it('follows the keys the host answered, in any order (the trace: page ups refused at the top, then page downs)', () => {
    // The bug: refused Page Up keys stayed waiting and were matched to the answers of later
    // Page Down keys, so the thumb stood still or went up while the list went down.
    const steps: Array<[PageView, number]> = [[view('p1'), 0], [view('p2'), 1], [view('p3'), 1], [view('p2'), -1], [view('p1'), -1]];
    for (let i = 0; i < 6; i++) steps.push([view('p1'), -1]);
    const positions: string[] = [];
    let state = run(steps);
    for (const name of ['p2', 'p3', 'p4', 'p5']) {
      state = nextPaging(state, view(name), 1);
      positions.push(bar(state));
    }
    expect(positions).toEqual(['1/4', '2/4', '3/5', '4/6']);
  });

  it('the bar only gets longer while new pages are found; going back over them changes nothing', () => {
    let state = run([[view('p1'), 0]]);
    const totals: number[] = [];
    for (const [name, paged] of [['p2', 1], ['p3', 1], ['p2', -1], ['p1', -1], ['p2', 1], ['p3', 1], ['p4', 1]] as Array<[string, number]>) {
      state = nextPaging(state, view(name), paged);
      totals.push(pagingBar(state, 'more').total);
    }
    expect(totals).toEqual([3, 4, 4, 4, 4, 4, 5]);
  });

  it('knows the number of pages once Bottom is seen, and the thumb is at the end there', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3', 'bottom'), 1]]);
    expect(s.last).toBe(2);
    expect(bar(s, 'bottom')).toBe('2/3');
    expect(bar(nextPaging(s, view('p2'), -1))).toBe('1/3');
  });

  it('a list of one page fills the bar', () => {
    expect(bar(run([[view('p1', 'bottom'), 0]]), 'bottom')).toBe('0/1');
  });

  it('forgets the number of pages when the last page shows More... again', () => {
    const s = run([[view('p1'), 0], [view('p2', 'bottom'), 1], [view(['p2 a', 'p2 b', 'p2 c', 'new'], 'more'), 0]]);
    expect(s.last).toBeUndefined();
    expect(bar(s)).toBe('1/3');
  });

  it('a page up from where the list was first seen puts a page before it', () => {
    // A program can open a list in the middle.
    const s = run([[view('p5'), 0], [view('p6', 'bottom'), 1], [view('p5'), -1], [view('p4'), -1]]);
    expect(bar(s)).toBe('0/3');
    expect(bar(run([[view('p5'), 1], [view('p6', 'bottom'), 1]], s), 'bottom')).toBe('2/3');
  });

  it('recognises a page it has seen: the list shown again from the top stands on page one', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1], [view('p1'), 0]]);
    expect(bar(s)).toBe('0/4');
  });

  it('records that change in place leave the page alone', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view(['p2 a', 'p2 b', 'p2 c changed', 'p2 d']), 0]]);
    expect(bar(s)).toBe('1/3');
    // The changed records are the page now: going on and coming back still fits.
    expect(bar(run([[view('p3'), 1], [view(['p2 a', 'p2 b', 'p2 c changed', 'p2 d']), -1]], s))).toBe('1/4');
  });

  it('a list loaded again with other records starts at its first page', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1], [view('x1'), 0]]);
    expect(bar(s)).toBe('0/2');
    expect(bar(nextPaging(s, view('x2'), 1))).toBe('1/3');
  });

  it('comes back to its page when what covered the list goes away', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('p3'), 1], [view('window'), 0], [view('window other'), 0], [view('p3'), 0]]);
    expect(bar(s)).toBe('2/4');
  });

  it('starts again for another list', () => {
    const s = run([[view('p1'), 0], [view('p2'), 1], [view('x1', 'more', '9|Other list'), 1]]);
    expect(bar(s)).toBe('0/2');
  });

  it('keeps the old picture when nothing is known (no state)', () => {
    expect(pagingBar(undefined, 'more')).toEqual({ total: 3, pos: 0 });
    expect(pagingBar(undefined, 'bottom')).toEqual({ total: 3, pos: 2 });
  });
});
