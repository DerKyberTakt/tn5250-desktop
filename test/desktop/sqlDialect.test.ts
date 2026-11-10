import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { db2iLanguage, serviceReferences } from '../../src/desktop/sqlDialect';

/** Leaf tokens of a parse, grouped by node name. */
function tokens(text: string): Record<string, string[]> {
  const state = EditorState.create({ doc: text, extensions: [db2iLanguage()] });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  const out: Record<string, string[]> = {};
  tree!.iterate({
    enter(n) {
      if (n.node.firstChild) return;
      (out[n.name] ??= []).push(text.slice(n.from, n.to));
    },
  });
  return out;
}

describe('Db2 for i dialect', () => {
  it('colours standard SQL and the Db2 for i additions', () => {
    const t = tokens(
      "SELECT CUSTNO, DEC(BALANCE, 11, 2), COALESCE(NAME, 'none') AS N\n" +
        "  FROM MYLIB.CUSTOMER\n" +
        " WHERE NAME = 'O''Brien' AND CUSTNO > 1000 -- the big ones\n" +
        ' ORDER BY 1 FETCH FIRST 5 ROWS ONLY;\n',
    );
    for (const w of ['SELECT', 'AS', 'FROM', 'WHERE', 'AND', 'ORDER', 'BY', 'FETCH', 'FIRST', 'ROWS', 'ONLY']) expect(t.Keyword).toContain(w);
    expect(t.Builtin).toContain('COALESCE');
    expect(t.Type).toContain('DEC');
    expect(t.Identifier).toEqual(expect.arrayContaining(['CUSTNO', 'BALANCE', 'MYLIB', 'CUSTOMER']));
    // A doubled quote reads as two adjacent strings (same colour, so it looks right).
    expect(t.String).toEqual(["'none'", "'O'", "'Brien'"]);
    expect(t.Number).toEqual(expect.arrayContaining(['11', '2', '1000', '1', '5']));
    expect(t.LineComment).toEqual(['-- the big ones']);
  });

  it('knows the services, catalog views, types and special registers', () => {
    const t = tokens(
      'SELECT CURRENT_TIMESTAMP, CAST(X AS INTEGER), VARCHAR_FORMAT(T, \'YYYY-MM-DD\')\n' +
        '  FROM QSYS2.SYSTABLES, TABLE(SYSTOOLS.SPOOLED_FILE_DATA(JOB_NAME => \'1/2/3\')) /* spool */\n' +
        ' WHERE TABLE_SCHEMA = CURRENT SCHEMA WITH UR;',
    );
    expect(t.Builtin).toContain('VARCHAR_FORMAT');
    // Words next to a dot are identifiers to the tokenizer; the editor colours the pair itself.
    expect(t.Identifier).toEqual(expect.arrayContaining(['QSYS2', 'SYSTABLES', 'SYSTOOLS', 'SPOOLED_FILE_DATA']));
    expect(t.Type).toContain('INTEGER');
    expect(t.Keyword).toEqual(expect.arrayContaining(['CURRENT_TIMESTAMP', 'CURRENT', 'SCHEMA', 'WITH', 'UR', 'CAST', 'TABLE']));
    expect(t.BlockComment).toEqual(['/* spool */']);
  });

  it('is case-insensitive and treats double quotes as delimited identifiers', () => {
    const t = tokens('select "Mixed Case" from mylib.t where :hv = 1;');
    expect(t.Keyword).toEqual(['select', 'from', 'where']);
    expect(t.QuotedIdentifier).toEqual(['"Mixed Case"']);
    expect(t.SpecialVar).toEqual([':hv']);
  });

  it('leaves CL: and QSH: lines parseable (they are just words to the SQL parser)', () => {
    const t = tokens('CL: DSPLIBL OUTPUT(*PRINT);\nQSH: ls -l /home\nSELECT 1 FROM SYSIBM.SYSDUMMY1;');
    expect(t.Keyword).toEqual(expect.arrayContaining(['SELECT', 'FROM']));
    expect(t.Builtin ?? []).not.toContain('DSPLIBL');
  });

  it('finds qualified service and catalog references for the editor to colour', () => {
    const refs = serviceReferences('select * from qsys2.systables, SYSTOOLS . SPOOLED_FILE_DATA, MYLIB.QSYS2X, SYSIBM.SYSDUMMY1');
    expect(refs.map((r) => r.text)).toEqual(['qsys2.systables', 'SYSTOOLS . SPOOLED_FILE_DATA', 'SYSIBM.SYSDUMMY1']);
    expect(refs[0]).toMatchObject({ from: 14, to: 29 });
  });
});
