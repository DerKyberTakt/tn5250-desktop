import { describe, expect, it } from 'vitest';
import type { ScreenSnapshot, SnapshotField } from '../../src/shared/protocol';
import { detectSeu, highlightLines, highlightScreen, languageFromContent, languageFromFile, languageFromFormatLine, Tok, type SourceLang } from '../../src/shared/sourceHighlight';

/** Token kind of the first character of `needle` in line `text`. */
function kindOf(lang: SourceLang, text: string, needle: string, lines: string[] = [text]): number {
  const idx = lines.indexOf(text);
  const kinds = highlightLines(lang, lines, 1)[idx] as Uint8Array;
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" not in "${text}"`);
  return kinds[at] as number;
}

const col = (n: number, s: string): string => ' '.repeat(n - 1) + s;

describe('RPG fixed format', () => {
  const c = '     C     *ENTRY        PLIST';
  const eval1 = "     C                   EVAL      TOTAL = %TRIM(NAME) + 'X'";
  const ind = '     C   N50CUSTNO        CHAIN     CUSTMAST                           90';
  it('colours spec, factor 1 specials, opcodes and indicators', () => {
    expect(kindOf('rpg', c, 'C')).toBe(Tok.Spec);
    expect(kindOf('rpg', c, '*ENTRY')).toBe(Tok.Special);
    expect(kindOf('rpg', c, 'PLIST')).toBe(Tok.Keyword);
    expect(kindOf('rpg', ind, 'N50')).toBe(Tok.Indicator);
    expect(kindOf('rpg', ind, 'CHAIN')).toBe(Tok.Keyword);
    expect(kindOf('rpg', ind, '90')).toBe(Tok.Indicator);
  });
  it('treats extended factor 2 as an expression', () => {
    expect(kindOf('rpg', eval1, 'EVAL')).toBe(Tok.Keyword);
    expect(kindOf('rpg', eval1, '%TRIM')).toBe(Tok.Builtin);
    expect(kindOf('rpg', eval1, "'X'")).toBe(Tok.String);
    expect(kindOf('rpg', eval1, 'TOTAL')).toBe(Tok.None);
  });
  it('colours comments, markers and directives', () => {
    expect(kindOf('rpg', '     C* a comment', 'a comment')).toBe(Tok.Comment);
    expect(kindOf('rpg', 'KW1  C                   EVAL      X = 1', 'KW1')).toBe(Tok.Marker);
    expect(kindOf('rpg', '      /COPY QRPGLESRC,MYCOPY', '/COPY')).toBe(Tok.Keyword);
  });
  it('colours D and F specs by column', () => {
    const d = '     D CUSTREC         DS                  QUALIFIED';
    expect(kindOf('rpg', d, 'CUSTREC')).toBe(Tok.Name);
    expect(kindOf('rpg', d, 'DS ')).toBe(Tok.Keyword);
    expect(kindOf('rpg', d, 'QUALIFIED')).toBe(Tok.Keyword);
    const f = '     FCUSTMAST  IF   E           K DISK    USROPN';
    expect(kindOf('rpg', f, 'CUSTMAST')).toBe(Tok.Name);
    expect(kindOf('rpg', f, 'DISK')).toBe(Tok.Keyword);
    expect(kindOf('rpg', f, 'USROPN')).toBe(Tok.Keyword);
  });
  it('colours embedded SQL between C/EXEC SQL and C/END-EXEC', () => {
    const lines = ['     C/EXEC SQL', '     C+ SELECT NAME INTO :WNAME FROM CUSTMAST', '     C/END-EXEC'];
    expect(kindOf('rpg', lines[0] as string, 'EXEC')).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[1] as string, 'SELECT', lines)).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[1] as string, ':WNAME', lines)).toBe(Tok.Variable);
    expect(kindOf('rpg', lines[2] as string, 'END-EXEC', lines)).toBe(Tok.Keyword);
  });
});

describe('RPG free format', () => {
  it('colours column-limited free form (columns 8-80)', () => {
    const t = "       dcl-s total packed(9:2) inz(0); // running total";
    expect(kindOf('rpg', t, 'dcl-s')).toBe(Tok.Keyword);
    expect(kindOf('rpg', t, 'packed')).toBe(Tok.Keyword);
    expect(kindOf('rpg', t, '9')).toBe(Tok.Number);
    expect(kindOf('rpg', t, '// running')).toBe(Tok.Comment);
  });
  it('colours fully free (**FREE) source from column 1', () => {
    const lines = ['**FREE', "if %found(custmast) and name <> *blanks;", "  exec sql update custmast set name = 'A' where id = :id;", 'endif;'];
    expect(kindOf('rpg', lines[0] as string, '**FREE', lines)).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[1] as string, 'if', lines)).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[1] as string, '%found', lines)).toBe(Tok.Builtin);
    expect(kindOf('rpg', lines[1] as string, '*blanks', lines)).toBe(Tok.Special);
    expect(kindOf('rpg', lines[2] as string, 'update', lines)).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[2] as string, ':id', lines)).toBe(Tok.Variable);
    expect(kindOf('rpg', lines[3] as string, 'endif', lines)).toBe(Tok.Keyword);
  });
  it('keeps embedded SQL across lines until the semicolon', () => {
    const lines = ['       exec sql', '         select count(*) into :n', '           from custmast;', '       n += 1;'];
    expect(kindOf('rpg', lines[1] as string, 'select', lines)).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[1] as string, 'count', lines)).toBe(Tok.Builtin);
    expect(kindOf('rpg', lines[2] as string, 'from', lines)).toBe(Tok.Keyword);
    expect(kindOf('rpg', lines[3] as string, '1', lines)).toBe(Tok.Number);
  });
});

describe('CL', () => {
  it('colours labels, commands, parameters, variables and specials', () => {
    const t = "LOOP:       CHGVAR     VAR(&COUNT) VALUE(&COUNT + 1)";
    expect(kindOf('cl', t, 'LOOP')).toBe(Tok.Name);
    expect(kindOf('cl', t, 'CHGVAR')).toBe(Tok.Keyword);
    expect(kindOf('cl', t, 'VAR(')).toBe(Tok.Name);
    expect(kindOf('cl', t, '&COUNT')).toBe(Tok.Variable);
    expect(kindOf('cl', t, '1)')).toBe(Tok.Number);
    const ifl = "            IF         COND(&X *EQ 'Y') THEN(GOTO CMDLBL(END))";
    expect(kindOf('cl', ifl, '*EQ')).toBe(Tok.Special);
    expect(kindOf('cl', ifl, "'Y'")).toBe(Tok.String);
    expect(kindOf('cl', ifl, 'THEN')).toBe(Tok.Keyword);
    expect(kindOf('cl', ifl, 'GOTO')).toBe(Tok.Keyword);
    const mon = '            MONMSG     MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))';
    expect(kindOf('cl', mon, 'MONMSG')).toBe(Tok.Keyword);
    expect(kindOf('cl', mon, 'GOTO')).toBe(Tok.Keyword);
  });
  it('handles comments across lines and continuations', () => {
    const lines = ['/* start of a', '   long comment */ PGM', "            SNDPGMMSG  MSG('one') +", '                         MSGTYPE(*INFO)'];
    expect(kindOf('cl', lines[1] as string, 'long', lines)).toBe(Tok.Comment);
    expect(kindOf('cl', lines[1] as string, 'PGM', lines)).toBe(Tok.Keyword);
    // The continued line does not start a new command.
    expect(kindOf('cl', lines[3] as string, 'MSGTYPE', lines)).toBe(Tok.Name);
    expect(kindOf('cl', lines[3] as string, '*INFO', lines)).toBe(Tok.Special);
  });
  it('does not treat /* inside a string as a comment', () => {
    const t = "            CHGVAR     VAR(&P) VALUE('/*ALL')";
    expect(kindOf('cl', t, "'/*ALL'")).toBe(Tok.String);
  });
});

describe('DDS', () => {
  it('colours record formats, names, indicators, keywords and constants', () => {
    const r = col(6, 'A          R SCREEN1                   SFL');
    expect(kindOf('dds', r, 'R ')).toBe(Tok.Keyword);
    expect(kindOf('dds', r, 'SCREEN1')).toBe(Tok.Name);
    expect(kindOf('dds', r, 'SFL')).toBe(Tok.Keyword);
    const k = col(6, "A N83                                  DSPATR(HI) TEXT('Customer')");
    expect(kindOf('dds', k, 'N83')).toBe(Tok.Indicator);
    expect(kindOf('dds', k, 'DSPATR')).toBe(Tok.Keyword);
    expect(kindOf('dds', k, "'Customer'")).toBe(Tok.String);
    expect(kindOf('dds', col(6, 'A* a comment'), 'a comment')).toBe(Tok.Comment);
    const f = col(6, 'A            CUSNO          7S 0B  5 10');
    expect(kindOf('dds', f, '7S')).toBe(Tok.Number);
    expect(kindOf('dds', f, 'S 0')).toBe(Tok.Special);
  });
});

describe('SQL', () => {
  it('colours keywords, functions, strings, numbers and comments', () => {
    const lines = ["SELECT TRIM(NAME), 42 FROM MYLIB.CUSTMAST -- customers", "WHERE STATUS = 'A' /* active", '   only */ ORDER BY NAME;'];
    expect(kindOf('sql', lines[0] as string, 'SELECT', lines)).toBe(Tok.Keyword);
    expect(kindOf('sql', lines[0] as string, 'TRIM', lines)).toBe(Tok.Builtin);
    expect(kindOf('sql', lines[0] as string, '42', lines)).toBe(Tok.Number);
    expect(kindOf('sql', lines[0] as string, '-- customers', lines)).toBe(Tok.Comment);
    expect(kindOf('sql', lines[1] as string, "'A'", lines)).toBe(Tok.String);
    expect(kindOf('sql', lines[2] as string, 'only', lines)).toBe(Tok.Comment);
    expect(kindOf('sql', lines[2] as string, 'ORDER', lines)).toBe(Tok.Keyword);
  });
});

describe('language detection', () => {
  it('uses the source file name', () => {
    expect(languageFromFile('QRPGLESRC')).toBe('rpg');
    expect(languageFromFile('QSQLRPGLE')).toBe('rpg');
    expect(languageFromFile('QCLLESRC')).toBe('cl');
    expect(languageFromFile('QCLSRC')).toBe('cl');
    expect(languageFromFile('QDDSSRC')).toBe('dds');
    expect(languageFromFile('QSQLSRC')).toBe('sql');
    expect(languageFromFile('QCMDSRC')).toBe('cl');
    expect(languageFromFile('H')).toBe('c');
    expect(languageFromFile('SYS')).toBe('c');
    expect(languageFromFile('QCSRC')).toBe('c');
    expect(languageFromFile('QCPPSRC')).toBe('c');
    expect(languageFromFile('MYSRC')).toBeUndefined();
  });
  it("uses SEU's format line", () => {
    expect(languageFromFormatLine(' FMT H  HKeywords++++++++++++++++++++++++++++++')).toBe('rpg');
    expect(languageFromFormatLine(' FMT C  CL0N01Factor1+++++++Opcode&ExtFactor2+++')).toBe('rpg');
    expect(languageFromFormatLine(' FMT A  AAN01N02N03T.Name++++++RLen++TDpBLinPosFunctions+++')).toBe('dds');
    expect(languageFromFormatLine(' FMT **  ...+... 1 ...+... 2 ...+... 3')).toBeUndefined();
    expect(languageFromFormatLine(' SEU==>')).toBeUndefined();
  });
  it('falls back to the content', () => {
    expect(languageFromContent(['             PGM', '             DCL        VAR(&A) TYPE(*CHAR)'], 1)).toBe('cl');
    expect(languageFromContent([col(6, 'A          R REC1'), col(6, 'A            FLD1          10A')], 1)).toBe('dds');
    expect(languageFromContent(['     C                   EVAL      X = 1'], 1)).toBe('rpg');
    expect(languageFromContent(['select * from t'], 1)).toBe('sql');
    expect(languageFromContent(['#include <stdio.h>', 'typedef struct {', '  int a;', '} T;'], 1)).toBe('c');
  });
  it('gives no language for text it cannot place', () => {
    expect(languageFromContent(['/*                  Qus_OBJD0100                          */', '/* Function Prototype List: QUSROBJD                      */'], 1)).toBeUndefined();
    expect(languageFromContent(['Dear Sir,', 'this is a text member.'], 1)).toBeUndefined();
  });
});

describe('C', () => {
  it('colours comments, strings, keywords, calls and preprocessor lines', () => {
    const lines = ['#include <stdio.h>', 'typedef struct { /* layout', '  int  a; */ char *p;', '  char s[] = "a /* not a comment */";', "  return printf(\"%d\\n\", 'x'); // done"];
    expect(kindOf('c', lines[0] as string, '#include', lines)).toBe(Tok.Marker);
    expect(kindOf('c', lines[0] as string, '<stdio.h>', lines)).toBe(Tok.String);
    expect(kindOf('c', lines[1] as string, 'typedef', lines)).toBe(Tok.Keyword);
    expect(kindOf('c', lines[1] as string, '/* layout', lines)).toBe(Tok.Comment);
    expect(kindOf('c', lines[2] as string, 'int', lines)).toBe(Tok.Comment);
    expect(kindOf('c', lines[2] as string, 'char', lines)).toBe(Tok.Keyword);
    expect(kindOf('c', lines[2] as string, '*p', lines)).toBe(Tok.None);
    expect(kindOf('c', lines[3] as string, '"a /*', lines)).toBe(Tok.String);
    expect(kindOf('c', lines[3] as string, 'not a', lines)).toBe(Tok.String);
    expect(kindOf('c', lines[4] as string, 'printf', lines)).toBe(Tok.Builtin);
    expect(kindOf('c', lines[4] as string, "'x'", lines)).toBe(Tok.String);
    expect(kindOf('c', lines[4] as string, '// done', lines)).toBe(Tok.Comment);
  });
});

/** A synthetic 24x80 SEU edit screen: sequence-number field + source field per data line. */
function seuScreen(file: string, source: string[], fmt = ' FMT **  ...+... 1 ...+... 2 ...+... 3 ...+... 4 ...+... 5 ...+... 6 ...+... 7'): ScreenSnapshot {
  const rows = 24;
  const cols = 80;
  const lines: string[] = Array.from({ length: rows }, () => ' '.repeat(cols));
  const fields: SnapshotField[] = [];
  const put = (r: number, text: string): void => {
    lines[r] = (text + ' '.repeat(cols)).slice(0, cols);
  };
  put(0, ` Columns . . . :    1  71           Edit                       MYLIB/${file}`);
  put(1, ' SEU==>                                                              MYMBR');
  fields.push({ start: 1 * cols + 8, length: 60, bypass: false });
  put(2, fmt);
  put(3, '        *************** Beginning of data *************************************');
  source.forEach((s, i) => {
    const r = 4 + i;
    put(r, `${String(i + 1).padStart(4, '0')}.00 ${s}`.replace(/^(.{7}) /, '$1 '));
    lines[r] = (`${String(i + 1).padStart(4, '0')}.00` + ' ' + s + ' '.repeat(cols)).slice(0, cols);
    fields.push({ start: r * cols, length: 7, bypass: false });
    fields.push({ start: r * cols + 8, length: 71, bypass: false });
  });
  put(4 + source.length, '        ****************** End of data ****************************************');
  put(21, ' F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F10=Cursor   F11=Toggle');
  return { rows, cols, text: lines.join(''), fields, attrs: new Array(rows * cols).fill(0), cursor: { row: 4, col: 8 } };
}

describe('SEU screen detection', () => {
  it('finds the source lines, the first column and the language', () => {
    const s = seuScreen('QCLLESRC', ['             PGM', "             SNDPGMMSG  MSG('Hi')", '             ENDPGM']);
    const seu = detectSeu(s);
    expect(seu?.lang).toBe('cl');
    expect(seu?.firstColumn).toBe(1);
    expect(seu?.sourceFile).toBe('QCLLESRC');
    expect(seu?.lines.map((l) => l.row)).toEqual([4, 5, 6]);
    expect(seu?.lines[0]?.col).toBe(8);
  });
  it('colours cells on the screen', () => {
    const s = seuScreen('QCLLESRC', ['             PGM']);
    const cells = highlightScreen(s) as Uint8Array;
    const pgmCol = 8 + 13;
    expect(cells[4 * 80 + pgmCol]).toBe(Tok.Keyword);
    // Header and function-key rows are left alone.
    expect(cells.slice(0, 4 * 80).every((k) => k === 0)).toBe(true);
    expect(cells.slice(21 * 80, 22 * 80).every((k) => k === 0)).toBe(true);
  });
  it('takes the language from the FMT line when the file name says nothing', () => {
    const s = seuScreen('MYSRC', ['     C                   EVAL      X = 1'], ' FMT C  CL0N01Factor1+++++++Opcode&ExtFactor2+++++++++++++++++++++++++++');
    expect(detectSeu(s)?.lang).toBe('rpg');
  });
  it('leaves a member it cannot place in the host colours (QSYSINC/H header)', () => {
    const s = seuScreen('H', ['/*                  Qus_OBJD0100                          */', '/* Function Prototype List: QUSROBJD                      */']);
    expect(detectSeu(s)?.lang).toBe('c');
    const cells = highlightScreen(s) as Uint8Array;
    expect(cells[4 * 80 + 8]).toBe(Tok.Comment);
    const unknown = seuScreen('MYSRC', ['Dear Sir,', 'this is a text member.']);
    expect(detectSeu(unknown)?.lang).toBeUndefined();
    expect(highlightScreen(unknown)).toBeUndefined();
  });
  it('ignores screens that are not SEU', () => {
    const s = seuScreen('QCLLESRC', ['             PGM']);
    const plain = { ...s, text: ' '.repeat(80) + s.text.slice(80) };
    expect(detectSeu(plain)).toBeUndefined();
    expect(highlightScreen(plain)).toBeUndefined();
  });
});
