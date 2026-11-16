import { describe, expect, it } from 'vitest';
import { findMatches, findStatus, matchFrom, stepMatch } from '../../src/shared/screenFind';
import { visibleRows } from '../../src/shared/screenText';

describe('findMatches', () => {
  const rows = ['Work with Objects', 'Opt  Object', ' 1   OBJECT1'];

  it('finds every match row by row, left to right, ignoring case by default', () => {
    expect(findMatches(rows, 'object')).toEqual([
      { row: 0, col: 10, length: 6 },
      { row: 1, col: 5, length: 6 },
      { row: 2, col: 5, length: 6 },
    ]);
  });

  it('keeps to the exact case with matchCase', () => {
    expect(findMatches(rows, 'Object', { matchCase: true })).toEqual([
      { row: 0, col: 10, length: 6 },
      { row: 1, col: 5, length: 6 },
    ]);
  });

  it('does not overlap matches', () => {
    expect(findMatches(['aaaa a'], 'aa').map((m) => m.col)).toEqual([0, 2]);
  });

  it('never runs from one row into the next', () => {
    expect(findMatches(['xxab', 'cdxx'], 'abcd')).toEqual([]);
    expect(findMatches(['abc'], 'abcd')).toEqual([]);
  });

  it('finds nothing for an empty query', () => {
    expect(findMatches(rows, '')).toEqual([]);
  });

  it('matches spaces in the query like any other character', () => {
    expect(findMatches(rows, 't  O')).toEqual([{ row: 1, col: 2, length: 4 }]);
    expect(findMatches(rows, 'opt o')).toEqual([]);
  });

  it('keeps screen columns for a letter whose lower case is two characters', () => {
    // Lower-casing the whole row would turn the dotted capital I into two characters and move every later match one column right.
    const dottedI = String.fromCharCode(0x130);
    expect(findMatches([`${dottedI}ABC abc`], 'abc').map((m) => m.col)).toEqual([1, 5]);
  });

  it('matches a letter with two lower case forms either way', () => {
    const capitalSigma = String.fromCharCode(0x3a3);
    const finalSigma = String.fromCharCode(0x3c2);
    expect(findMatches([`${capitalSigma}X`], finalSigma)).toEqual([{ row: 0, col: 0, length: 1 }]);
    expect(findMatches([`${capitalSigma}X`], finalSigma, { matchCase: true })).toEqual([]);
  });

  it('cannot find text the screen hides', () => {
    // Nondisplay attribute at cell 3 hides SECR; normal again at cell 8.
    const attrs = new Array<number>(12).fill(0);
    attrs[3] = 0x27;
    attrs[8] = 0x20;
    const screen = visibleRows({ rows: 2, cols: 6, text: 'Pw: SECR OK ', attrs });
    expect(findMatches(screen, 'SE')).toEqual([]);
    expect(findMatches(screen, 'OK')).toEqual([{ row: 1, col: 3, length: 2 }]);
  });
});

describe('matchFrom', () => {
  const matches = [
    { row: 0, col: 10, length: 6 },
    { row: 1, col: 5, length: 6 },
    { row: 2, col: 5, length: 6 },
  ];

  it('starts at the first match when there is no position yet', () => {
    expect(matchFrom(matches)).toBe(0);
  });

  it('lands on the first match at the position or after it', () => {
    expect(matchFrom(matches, { row: 1, col: 5 })).toBe(1);
    expect(matchFrom(matches, { row: 1, col: 6 })).toBe(2);
    expect(matchFrom(matches, { row: 0, col: 0 })).toBe(0);
  });

  it('wraps to the first match when none is after the position', () => {
    expect(matchFrom(matches, { row: 2, col: 6 })).toBe(0);
  });

  it('keeps the current match when the host repaints and it is still there, else takes the next', () => {
    expect(matchFrom([{ row: 0, col: 2, length: 6 }, { row: 1, col: 5, length: 6 }], { row: 1, col: 5 })).toBe(1);
    expect(matchFrom([{ row: 0, col: 2, length: 6 }, { row: 2, col: 0, length: 6 }], { row: 1, col: 5 })).toBe(1);
  });

  it('returns -1 when there are no matches', () => {
    expect(matchFrom([], { row: 0, col: 0 })).toBe(-1);
    expect(matchFrom([])).toBe(-1);
  });
});

describe('stepMatch', () => {
  it('moves forward and back, wrapping at either end', () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 1, -1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  it('starts at the first or the last match from none', () => {
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(3, -1, -1)).toBe(2);
    expect(stepMatch(2, 5, 1)).toBe(0);
  });

  it('returns -1 when there are no matches', () => {
    expect(stepMatch(0, -1, 1)).toBe(-1);
    expect(stepMatch(0, 0, -1)).toBe(-1);
  });
});

describe('findStatus', () => {
  it('says nothing for an empty box, then No results or the position', () => {
    expect(findStatus('', -1, 0)).toBe('');
    expect(findStatus('x', -1, 0)).toBe('No results');
    expect(findStatus('x', 1, 5)).toBe('2 of 5');
  });
});
