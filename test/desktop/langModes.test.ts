import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import type { Language } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { batchLanguage, clLanguage, languageFor, rpgLanguage } from '../../src/desktop/langModes';

const classes = tagHighlighter([
  { tag: t.keyword, class: 'kw' },
  { tag: t.typeName, class: 'type' },
  { tag: t.standard(t.name), class: 'fn' },
  { tag: t.string, class: 'str' },
  { tag: t.variableName, class: 'var' },
  { tag: t.atom, class: 'atom' },
  { tag: t.number, class: 'num' },
  { tag: t.comment, class: 'comment' },
  { tag: t.labelName, class: 'label' },
  { tag: t.meta, class: 'meta' },
  { tag: t.operator, class: 'op' },
]);

/** Every coloured token as `class:text`. */
function tokens(lang: Language, text: string): string[] {
  const out: string[] = [];
  highlightTree(lang.parser.parse(text), classes, (from, to, cls) => out.push(`${cls}:${text.slice(from, to)}`));
  return out;
}

describe('CL mode', () => {
  it('colours commands, parameter keywords, variables, values, strings, comments and continuations', () => {
    const src = ["PGM PARM(&LIB)", "  CHGVAR VAR(&X) VALUE('a''b') /* note */", "  CALL PGM(QCMDEXC) +", "       PARM(*LIBL 12)", "TAG: IF COND(&X *EQ 'y') THEN(DLTF FILE(QTEMP/A))", "ENDPGM"].join('\n');
    expect(tokens(clLanguage, src)).toEqual([
      'kw:PGM',
      'type:PARM',
      'var:&LIB',
      'kw:CHGVAR',
      'type:VAR',
      'var:&X',
      'type:VALUE',
      "str:'a''b'",
      'comment:/* note */',
      'kw:CALL',
      'type:PGM',
      'op:+',
      'type:PARM',
      'atom:*LIBL',
      'num:12',
      'label:TAG:',
      'kw:IF',
      'type:COND',
      'var:&X',
      'atom:*EQ',
      "str:'y'",
      'type:THEN',
      'kw:DLTF',
      'type:FILE',
      'kw:ENDPGM',
    ]);
  });
});

describe('RPG mode', () => {
  it('fixed form: the spec letter, * comments, the C-spec opcode, D-spec keywords', () => {
    const src = ['     H DFTACTGRP(*NO)', '     D x               S             10A   INZ(\'ab\')', '     C                   EVAL      x = %trim(y)', '     C* old comment'].join('\n');
    expect(tokens(rpgLanguage, src)).toEqual([
      'meta:     ',
      'kw:H',
      'type:DFTACTGRP',
      'atom:*NO',
      'meta:     ',
      'kw:D',
      'num:10',
      'type:INZ',
      "str:'ab'",
      'meta:     ',
      'kw:C',
      'kw:EVAL',
      'op:=',
      'fn:%trim',
      'comment:     C* old comment',
    ]);
  });

  it('free form: declarations, control words, types, built-ins, comments, EXEC SQL', () => {
    const src = ['**free', "dcl-s x char(10) inz('a');", '// note', 'if x = *blank;', '  exsr foo;', 'endif;', 'exec sql select count(*) into :n from qsys2.systables;'].join('\n');
    expect(tokens(rpgLanguage, src)).toEqual([
      'meta:**free',
      'kw:dcl-s',
      'type:char',
      'num:10',
      'type:inz',
      "str:'a'",
      'comment:// note',
      'kw:if',
      'op:=',
      'atom:*blank',
      'kw:exsr',
      'kw:endif',
      'kw:exec sql',
      'kw:select',
      'kw:count',
      'op:*',
      'kw:into',
      'op::',
      'kw:from',
    ]);
  });
});

describe('batch mode', () => {
  it('colours commands, variables, labels, strings and comments', () => {
    const src = ['@echo off', 'rem hi', 'set X=%1', 'if exist "%X%" goto :end', ':end'].join('\n');
    expect(tokens(batchLanguage, src)).toEqual(['meta:@', 'kw:echo', 'comment:rem hi', 'kw:set', 'var:%1', 'kw:if', 'kw:exist', 'str:"%X%"', 'kw:goto', 'label::end']);
  });
});

describe('languageFor', () => {
  it('picks by extension, case-insensitively, and leaves unknown files plain', () => {
    expect(languageFor('a.JSON').name).toBe('JSON');
    expect(languageFor('PGM.CLLE').name).toBe('CL');
    expect(languageFor('x.sqlrpgle').name).toBe('RPG (SQL)');
    expect(languageFor('run.bat').name).toBe('Batch');
    expect(languageFor('data.csv').kind).toBe('csv');
    expect(languageFor('notes.txt')).toEqual({ kind: 'plain', name: 'Text' });
    expect(languageFor('weird.xyz')).toEqual({ kind: 'plain', name: 'Text (.xyz)' });
  });
});
