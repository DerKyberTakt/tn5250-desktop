import { describe, expect, it } from 'vitest';
import { splitStatements, statementLabel, statementsFrom, statementsIn } from '../../src/desktop/sqlScript';

const script = [
  '-- customers of one rep',
  "SELECT * FROM MYLIB.CUST WHERE REP = 'A;B' AND NOTE <> 'it''s;'; -- trailing",
  'CL: DSPLIBL;',
  'cl: WRKACTJOB',
  '/* a block; comment */',
  'UPDATE MYLIB.CUST',
  '   SET X = 1',
  ' WHERE ID = 2',
  '',
].join('\n');

describe('splitStatements', () => {
  it('splits on semicolons outside quotes and comments, and reads CL: lines', () => {
    const s = splitStatements(script);
    expect(s.map((x) => [x.kind, x.text])).toEqual([
      ['sql', "SELECT * FROM MYLIB.CUST WHERE REP = 'A;B' AND NOTE <> 'it''s;'"],
      ['cl', 'DSPLIBL'],
      ['cl', 'WRKACTJOB'],
      ['sql', 'UPDATE MYLIB.CUST\n   SET X = 1\n WHERE ID = 2'],
    ]);
    expect(s.map((x) => x.line)).toEqual([2, 3, 4, 6]);
    expect(script.slice(s[0]!.start, s[0]!.end)).toBe("SELECT * FROM MYLIB.CUST WHERE REP = 'A;B' AND NOTE <> 'it''s;'");
  });

  it('handles an unterminated last statement, double quotes and empty input', () => {
    expect(splitStatements('SELECT 1 FROM "MY;TABLE"').map((x) => x.text)).toEqual(['SELECT 1 FROM "MY;TABLE"']);
    expect(splitStatements('  ;; -- nothing\n')).toEqual([]);
    expect(splitStatements('')).toEqual([]);
  });
});

describe('picking statements by position', () => {
  const s = splitStatements(script);

  it('a caret picks the statement it is in; a selection picks what it touches', () => {
    const inFirst = script.indexOf('WHERE REP');
    expect(statementsIn(s, inFirst, inFirst, script).map((x) => x.kind)).toEqual(['sql']);
    // Just after the semicolon, on the same line: still that statement.
    const afterSemicolon = script.indexOf("s;';") + 4;
    expect(statementsIn(s, afterSemicolon, afterSemicolon, script).map((x) => x.kind)).toEqual(['sql']);
    // On the comment line above everything: nothing.
    expect(statementsIn(s, 3, 3, script)).toEqual([]);
    const from = script.indexOf('DSPLIBL');
    const to = script.indexOf('UPDATE') + 3;
    expect(statementsIn(s, from, to, script).map((x) => x.text.split(/\s/)[0])).toEqual(['DSPLIBL', 'WRKACTJOB', 'UPDATE']);
  });

  it('run from cursor takes the statement under the caret and everything after', () => {
    expect(statementsFrom(s, script.indexOf('WRKACTJOB'), script).map((x) => x.kind)).toEqual(['cl', 'sql']);
    expect(statementsFrom(s, 0, script).length).toBe(4);
    // The caret at the very end is inside the unterminated last statement.
    expect(statementsFrom(s, script.length, script).map((x) => x.kind)).toEqual(['sql']);
    // Nothing runnable after the caret: a trailing comment line.
    const tail = 'SELECT 1 FROM SYSIBM.SYSDUMMY1;\n-- done\n';
    expect(statementsFrom(splitStatements(tail), tail.indexOf('done'), tail)).toEqual([]);
  });

  it('labels are one line and shortened', () => {
    expect(statementLabel(s[3]!)).toBe('UPDATE MYLIB.CUST SET X = 1 WHERE ID = 2');
    expect(statementLabel(s[1]!)).toBe('CL: DSPLIBL');
    expect(statementLabel(s[0]!, 20)).toHaveLength(20);
  });
});
