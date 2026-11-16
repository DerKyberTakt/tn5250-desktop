/** One place the search text appears on the screen: a run of cells on one row. */
export interface FindMatch {
  row: number;
  col: number;
  length: number;
}

export interface FindOptions {
  /** Case must match exactly. Off (the default), `abc` also finds `ABC`. */
  matchCase?: boolean;
}

/**
 * Every place the query appears on the screen, row by row and left to right. Pass the rows
 * from `visibleRows`, one string per row, so hidden text is never found. A match never runs
 * from one row into the next and never overlaps the one before it (`aa` is found twice in
 * `aaaa`, as in VS Code). Characters are compared one at a time, so the column of a match is
 * the column on the screen even for a letter whose other case is two characters long. An
 * empty query finds nothing; a space in the query is matched like any other character.
 */
export function findMatches(rows: readonly string[], query: string, options: FindOptions = {}): FindMatch[] {
  const out: FindMatch[] = [];
  const length = query.length;
  if (length === 0) return out;
  const cellsOf = (s: string): string[] => (options.matchCase ? s.split('') : s.split('').map(fold));
  const q = cellsOf(query);
  rows.forEach((line, row) => {
    const cells = cellsOf(line);
    let col = 0;
    while (col + length <= cells.length) {
      let k = 0;
      while (k < length && cells[col + k] === q[k]) k++;
      if (k === length) {
        out.push({ row, col, length });
        col += length;
      } else {
        col++;
      }
    }
  });
  return out;
}

/** One character in a single case: upper case first, then lower, so letters with two lower case forms (Greek sigma) still meet. */
function fold(c: string): string {
  return c.toUpperCase().toLowerCase();
}

/**
 * Index of the match a new search lands on: the first one starting at `from` or after it,
 * reading left to right and top to bottom, wrapping to the first on the screen when none is
 * after it. A match that still matches when the host repaints the screen, or when one more
 * letter is typed, therefore stays the current one. With no `from`, the first match.
 * -1 when there are no matches.
 */
export function matchFrom(matches: readonly FindMatch[], from?: { row: number; col: number }): number {
  if (matches.length === 0) return -1;
  if (!from) return 0;
  const at = matches.findIndex((m) => m.row > from.row || (m.row === from.row && m.col >= from.col));
  return at < 0 ? 0 : at;
}

/**
 * Index of the next match (`step` 1) or the previous one (`step` -1) from `current`, wrapping
 * to the other end of the screen past the last or the first. From no current match (-1), the
 * first or the last. -1 when there are no matches.
 */
export function stepMatch(count: number, current: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** The counter beside the search box: nothing while it is empty, "No results", or "2 of 5". */
export function findStatus(query: string, current: number, count: number): string {
  if (query === '') return '';
  if (count === 0) return 'No results';
  return `${current + 1} of ${count}`;
}
