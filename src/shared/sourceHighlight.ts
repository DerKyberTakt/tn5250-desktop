import type { ScreenSnapshot } from './protocol';
import { rowText } from './screenText';

/**
 * Syntax colouring for the SEU (Source Entry Utility) edit and browse screens:
 * CL, DDS, RPG/RPGLE (fixed, free and fully free) and DB2 SQL, including SQL
 * embedded in RPG. Colouring only: nothing is sent to the host. The terminal
 * works out the language from the source file name in the SEU header
 * (QRPGLESRC, QCLLESRC, QDDSSRC, QSQLSRC ...) and falls back to the content.
 */

export type SourceLang = 'rpg' | 'cl' | 'dds' | 'sql';

/** Token kinds; 0 means "leave the host colour". */
export const Tok = {
  None: 0,
  Comment: 1,
  Keyword: 2,
  Builtin: 3,
  String: 4,
  Number: 5,
  Special: 6,
  Variable: 7,
  Indicator: 8,
  Name: 9,
  Marker: 10,
  Spec: 11,
} as const;
export type Tok = (typeof Tok)[keyof typeof Tok];

export interface SeuLine {
  row: number;
  /** Screen column of the first visible source character. */
  col: number;
  text: string;
}

export interface SeuScreen {
  lang: SourceLang;
  /** Source column of the first visible character ("Columns . . . : 1 71"). */
  firstColumn: number;
  sourceFile: string;
  lines: SeuLine[];
}

// ---------------------------------------------------------------------------
// Word lists

const words = (s: string): Set<string> => new Set(s.trim().split(/\s+/).map((w) => w.toUpperCase()));

const RPG_KEYWORDS = words(`
  dcl-s dcl-c dcl-ds dcl-f dcl-pr dcl-pi dcl-proc dcl-subf dcl-parm dcl-enum end-ds end-pr end-pi end-proc end-enum
  ctl-opt if elseif else endif dow dou enddo for to downto by endfor select when when-is when-in other endsl
  monitor on-error on-exit endmon begsr endsr exsr leavesr return leave iter eval evalr eval-corr callp call callb
  chain read reade readp readpe readc setll setgt write update delete unlock open close commit rolbk exfmt
  sorta clear reset dsply dump except feod post in out acq rel force next test xml-into xml-sax data-into data-gen
  snd-msg sorta cab cabeq cabne caseq cas endcs comp do doweq downe doueq goto tag lookup mvr move movel movea
  add sub mult div z-add z-sub scan xlate check checkr cat subst time occur kfld klist plist parm define
  adddur subdur extrct bitoff biton testb testn testz shtdn deallocate alloc realloc
  char varchar graph vargraph ucs2 varucs2 int uns packed zoned bindec float date time timestamp ind pointer object
  like likeds likerec likefile dim qualified inz template const value options extpgm extproc export import based
  overlay pos static varying noopt ascend descend ctdata perrcd alt extname extfld prefix occurs nullind samepos
  dftactgrp actgrp bnddir option datfmt timfmt decedit copyright main nomain alwnull debug expropts ccsid text
  usropn infds infsr sfile rename extfile extmbr indds keyed usage workstn printer disk seq special oflind extdesc
  handler block commit maxdev devid sfile rcdlen saveds saveind ignore include pgmname procptr opdesc rtnparm
  nopass omit varsize string trim exact
`);

const SQL_KEYWORDS = words(`
  select insert update delete merge from where and or not in is null like between exists join left right inner
  outer full cross on using group by order having union intersect except all distinct as case when then else end
  into values set create replace table view index procedure function trigger alter drop declare cursor for open
  fetch close next prior first last rows row only with exec sql begin commit rollback savepoint label comment grant
  revoke return returns language specific deterministic called reads modifies contains data external name
  parameter style asc desc limit offset call if elseif while loop repeat until leave iterate signal resignal
  handler continue exit condition default primary key foreign references constraint unique check generated always
  identity char character varchar integer int bigint smallint decimal dec numeric date time timestamp clob blob
  double real float boolean graphic vargraphic varbinary binary current schema system nolock ur cs rs rr nc
  include sqlca sqlda describe prepare execute immediate get diagnostics connect disconnect release lock share
  exclusive mode result sets new old referencing each statement after before instead of option naming
`);

const DDS_KEYWORDS_HINT = /^[A-Z][A-Z0-9]{1,9}$/;

// ---------------------------------------------------------------------------
// Small helpers

type Out = Uint8Array;

function paint(out: Out, from: number, to: number, kind: Tok): void {
  for (let i = Math.max(0, from); i < Math.min(out.length, to); i++) out[i] = kind;
}

const isWordStart = (c: string): boolean => /[A-Za-z@#$_]/.test(c);
const isWord = (c: string): boolean => /[A-Za-z0-9@#$_-]/.test(c);

/** Reads a quoted string starting at i (doubled quote = literal quote). Returns the end index. */
function readString(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

interface ExprOptions {
  keywords: Set<string>;
  /** "//" starts a comment. */
  slashComments?: boolean;
  /** Words followed by "(" that are not keywords count as functions. */
  callsAreBuiltins?: boolean;
  /** CL: "&NAME" variables, "%BUILTIN". */
  cl?: boolean;
  /** SQL: ":host" variables, "--" comments. */
  sql?: boolean;
}

/** Tokenizes an expression region [from, to) of a line. Returns the index where a ";" ended embedded SQL, if any. */
function scanExpr(text: string, from: number, to: number, out: Out, o: ExprOptions): void {
  let i = from;
  const end = Math.min(to, text.length);
  while (i < end) {
    const c = text[i] as string;
    if (c === ' ') {
      i++;
      continue;
    }
    if (o.slashComments && c === '/' && text[i + 1] === '/') {
      paint(out, i, end, Tok.Comment);
      return;
    }
    if (o.sql && c === '-' && text[i + 1] === '-') {
      paint(out, i, end, Tok.Comment);
      return;
    }
    if (c === "'") {
      const j = Math.min(readString(text, i, "'"), end);
      paint(out, i, j, Tok.String);
      i = j;
      continue;
    }
    if (c === '%' && /[A-Za-z]/.test(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < end && /[A-Za-z0-9]/.test(text[j] as string)) j++;
      paint(out, i, j, Tok.Builtin);
      i = j;
      continue;
    }
    if (c === '*' && /[A-Za-z]/.test(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < end && /[A-Za-z0-9]/.test(text[j] as string)) j++;
      paint(out, i, j, /^\*IN(\d\d|[A-Z]\d|LR|RT|H\d|U\d)$/i.test(text.slice(i, j)) ? Tok.Indicator : Tok.Special);
      i = j;
      continue;
    }
    if (o.cl && c === '&' && isWordStart(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < end && /[A-Za-z0-9@#$_]/.test(text[j] as string)) j++;
      paint(out, i, j, Tok.Variable);
      i = j;
      continue;
    }
    if (o.sql && c === ':' && isWordStart(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < end && /[A-Za-z0-9@#$_.]/.test(text[j] as string)) j++;
      paint(out, i, j, Tok.Variable);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) && !isWord(text[i - 1] ?? ' ')) {
      let j = i;
      while (j < end && /[0-9.]/.test(text[j] as string)) j++;
      if (!isWord(text[j] ?? ' ')) paint(out, i, j, Tok.Number);
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i;
      // SQL and CL words have no "-" inside; RPG has dcl-s, end-proc, on-error ...
      const wordChar = o.sql || o.cl ? (ch: string): boolean => /[A-Za-z0-9@#$_]/.test(ch) : isWord;
      while (j < end && wordChar(text[j] as string)) j++;
      const word = text.slice(i, j).toUpperCase();
      if (o.keywords.has(word)) paint(out, i, j, Tok.Keyword);
      else if (o.callsAreBuiltins && text[j] === '(') paint(out, i, j, Tok.Builtin);
      i = j;
      continue;
    }
    i++;
  }
}

// ---------------------------------------------------------------------------
// SQL

interface SqlState {
  inComment: boolean;
}

function highlightSqlRange(text: string, from: number, out: Out, st: SqlState): void {
  let i = from;
  while (i < text.length) {
    if (st.inComment) {
      const close = text.indexOf('*/', i);
      const j = close < 0 ? text.length : close + 2;
      paint(out, i, j, Tok.Comment);
      if (close < 0) return;
      st.inComment = false;
      i = j;
      continue;
    }
    const open = text.indexOf('/*', i);
    const stop = open < 0 ? text.length : open;
    scanExpr(text, i, stop, out, { keywords: SQL_KEYWORDS, sql: true, callsAreBuiltins: true });
    // A "--" comment found by scanExpr hides any later "/*".
    if (out[stop - 1] === Tok.Comment || open < 0) return;
    st.inComment = true;
    i = open;
  }
}

function highlightSql(lines: string[]): Out[] {
  const st: SqlState = { inComment: false };
  return lines.map((text) => {
    const out = new Uint8Array(text.length);
    highlightSqlRange(text, 0, out, st);
    return out;
  });
}

// ---------------------------------------------------------------------------
// CL

function highlightCl(lines: string[]): Out[] {
  let inComment = false;
  let continued = false;
  return lines.map((text) => {
    const out = new Uint8Array(text.length);
    // Comments first (they can span lines); the rest is scanned around them.
    const code: Array<[number, number]> = [];
    let i = 0;
    while (i < text.length) {
      if (inComment) {
        const close = text.indexOf('*/', i);
        const j = close < 0 ? text.length : close + 2;
        paint(out, i, j, Tok.Comment);
        if (close < 0) break;
        inComment = false;
        i = j;
        continue;
      }
      // Skip strings so "/*" inside quotes is not a comment.
      let j = i;
      let open = -1;
      while (j < text.length) {
        if (text[j] === "'") {
          j = readString(text, j, "'");
          continue;
        }
        if (text[j] === '/' && text[j + 1] === '*') {
          open = j;
          break;
        }
        j++;
      }
      code.push([i, open < 0 ? text.length : open]);
      if (open < 0) break;
      inComment = true;
      i = open;
    }
    for (const [a, b] of code) scanExpr(text, a, b, out, { keywords: new Set(), cl: true });
    // Command names: the first word of a statement (after an optional label), and the command inside THEN(...) / ELSE / DO.
    const firstCode = code[0];
    if (!continued && firstCode) {
      const seg = text.slice(firstCode[0], firstCode[1]);
      const m = /^(\s*)(?:([A-Za-z@#$][A-Za-z0-9@#$_]*):\s*)?((?:[A-Za-z@#$][A-Za-z0-9@#$_]*\/)?[A-Za-z@#$][A-Za-z0-9@#$_]*)/.exec(seg);
      if (m) {
        const labelStart = firstCode[0] + (m[1] as string).length;
        if (m[2]) paint(out, labelStart, labelStart + m[2].length + 1, Tok.Name);
        const cmd = m[3] as string;
        const cmdStart = firstCode[0] + (m[0] as string).length - cmd.length;
        if (cmd) paint(out, cmdStart, cmdStart + cmd.length, Tok.Keyword);
      }
    }
    // The command inside THEN(...), EXEC(...), CMD(...) and after ELSE.
    for (const m of text.matchAll(/\b(THEN|ELSE|EXEC|CMD)\b(\s*\(\s*|\s+)?([A-Za-z@#$][A-Za-z0-9@#$_]*)?/gi)) {
      if (out[m.index] === Tok.Comment || out[m.index] === Tok.String) continue;
      const kw = m[1] as string;
      const flow = /^(THEN|ELSE)$/i.test(kw);
      if (!flow && m[2]?.includes('(') !== true) continue;
      paint(out, m.index, m.index + kw.length, flow ? Tok.Keyword : Tok.Name);
      if (m[3] && m[2] && (m[2].includes('(') || kw.toUpperCase() === 'ELSE')) {
        const s = m.index + (m[0] as string).length - m[3].length;
        paint(out, s, s + m[3].length, Tok.Keyword);
      }
    }
    // Parameter keywords: NAME( outside strings and comments.
    for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9]*)\(/g)) {
      const at = m.index;
      if (out[at] === Tok.None) paint(out, at, at + (m[1] as string).length, Tok.Name);
    }
    const trimmed = text.replace(/\/\*.*$/, '').trimEnd();
    // Only a trailing + or - continues the command; an open comment does not.
    continued = /[+-]$/.test(trimmed);
    return out;
  });
}

// ---------------------------------------------------------------------------
// DDS (A-specs)

function highlightDds(lines: string[], firstColumn: number): Out[] {
  return lines.map((text) => {
    const out = new Uint8Array(text.length);
    const at = (c: number): number => c - firstColumn; // source column (1-based) -> index
    const seg = (c1: number, c2: number): string => text.slice(Math.max(0, at(c1)), Math.max(0, at(c2) + 1));
    const put = (c1: number, c2: number, kind: Tok): void => {
      const s = seg(c1, c2);
      if (s.trim()) paint(out, Math.max(0, at(c1)), at(c2) + 1, kind);
    };
    put(1, 5, Tok.Marker);
    if (seg(7, 7) === '*') {
      put(6, 6, Tok.Spec);
      paint(out, Math.max(0, at(7)), text.length, Tok.Comment);
      return out;
    }
    put(6, 6, Tok.Spec);
    put(7, 7, Tok.Keyword); // A/O conditioning
    for (const c of [8, 11, 14]) put(c, c + 2, Tok.Indicator);
    put(17, 17, Tok.Keyword); // R K S O J H
    put(19, 28, Tok.Name);
    put(29, 29, Tok.Special);
    put(30, 34, Tok.Number);
    put(35, 35, Tok.Special);
    put(36, 37, Tok.Number);
    put(38, 38, Tok.Special);
    put(39, 44, Tok.Number);
    // Functions area 45-80: keywords at paren depth 0, strings, numbers.
    const from = Math.max(0, at(45));
    const to = Math.min(text.length, at(80) + 1);
    let depth = 0;
    let i = from;
    while (i < to) {
      const c = text[i] as string;
      if (c === "'") {
        const j = Math.min(readString(text, i, "'"), to);
        paint(out, i, j, Tok.String);
        i = j;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      if (isWordStart(c)) {
        let j = i;
        while (j < to && /[A-Za-z0-9@#$_]/.test(text[j] as string)) j++;
        const w = text.slice(i, j);
        if (depth === 0 && DDS_KEYWORDS_HINT.test(w.toUpperCase())) paint(out, i, j, Tok.Keyword);
        i = j;
        continue;
      }
      if (c === '*' && /[A-Za-z]/.test(text[i + 1] ?? '')) {
        let j = i + 1;
        while (j < to && /[A-Za-z0-9]/.test(text[j] as string)) j++;
        paint(out, i, j, Tok.Special);
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) && !isWord(text[i - 1] ?? ' ')) {
        let j = i;
        while (j < to && /[0-9.]/.test(text[j] as string)) j++;
        paint(out, i, j, Tok.Number);
        i = j;
        continue;
      }
      i++;
    }
    if (text.length > to) paint(out, to, text.length, Tok.Comment);
    return out;
  });
}

// ---------------------------------------------------------------------------
// RPG (fixed, free, fully free; embedded SQL)

/** Fixed-format C-spec operations whose factor 2 is an expression (columns 36-80). */
const EXT_FACTOR2 = words('eval evalr eval-corr if elseif dow dou when for callp return on-error sorta xml-into data-into data-gen dsply snd-msg on-exit when-is when-in');

const FREE_START = /^(\*\*free|dcl-|end-|ctl-opt\b|if\b|elseif\b|else\b|endif\b|dow\b|dou\b|enddo\b|for\b|endfor\b|select\b|when\b|other\b|endsl\b|monitor\b|on-error\b|endmon\b|begsr\b|endsr\b|exsr\b|return\b|leave\b|iter\b|exec\s+sql\b|\/\/)/i;

function isFullyFree(lines: string[], firstColumn: number): boolean {
  if (firstColumn !== 1) return false;
  let free = 0;
  let fixed = 0;
  for (const t of lines) {
    if (/^\*\*free\b/i.test(t)) return true;
    const lead = t.search(/\S/);
    if (lead < 0) continue;
    if (/^[HFDICOP]$/i.test(t[5] ?? '') && (t[6] === ' ' || t[6] === '*' || t[6] === '/' || t[6] === '+')) fixed++;
    else if (lead < 5 && FREE_START.test(t.slice(lead))) free++;
  }
  return free > 0 && free >= fixed;
}

interface RpgState {
  sql: boolean;
  sqlComment: SqlState;
}

function freeLine(text: string, from: number, out: Out, st: RpgState): void {
  let start = from;
  if (st.sql) {
    const semi = text.indexOf(';', start);
    const stop = semi < 0 ? text.length : semi + 1;
    highlightSqlRange(text.slice(0, stop), start, out, st.sqlComment);
    if (semi < 0) return;
    st.sql = false;
    start = stop;
  }
  const m = /exec\s+sql\b/i.exec(text.slice(start));
  if (m) {
    const s = start + m.index;
    scanExpr(text, start, s, out, { keywords: RPG_KEYWORDS, slashComments: true });
    if (out[s] === Tok.Comment) return;
    paint(out, s, s + (m[0] as string).length, Tok.Keyword);
    st.sql = true;
    freeLine(text, s + (m[0] as string).length, out, st);
    return;
  }
  scanExpr(text, start, text.length, out, { keywords: RPG_KEYWORDS, slashComments: true });
}

function highlightRpg(lines: string[], firstColumn: number): Out[] {
  const st: RpgState = { sql: false, sqlComment: { inComment: false } };
  if (isFullyFree(lines, firstColumn)) {
    return lines.map((text) => {
      const out = new Uint8Array(text.length);
      if (/^\*\*free\b/i.test(text)) paint(out, 0, 6, Tok.Keyword);
      else freeLine(text, 0, out, st);
      return out;
    });
  }
  return lines.map((text) => {
    const out = new Uint8Array(text.length);
    const at = (c: number): number => c - firstColumn;
    const seg = (c1: number, c2: number): string => text.slice(Math.max(0, at(c1)), Math.max(0, at(c2) + 1));
    const put = (c1: number, c2: number, kind: Tok): void => {
      if (seg(c1, c2).trim()) paint(out, Math.max(0, at(c1)), at(c2) + 1, kind);
    };
    const expr = (c1: number, c2: number): void => scanExpr(text, Math.max(0, at(c1)), at(c2) + 1, out, { keywords: RPG_KEYWORDS, slashComments: false });
    const tail = (): void => {
      if (text.length > at(80) + 1) paint(out, at(81), text.length, Tok.Comment);
    };

    put(1, 5, Tok.Marker);
    const spec = seg(6, 6).toUpperCase();
    const c7 = seg(7, 7);

    // Embedded SQL in fixed form: C/EXEC SQL, C+ ..., C/END-EXEC.
    if (spec === 'C' && c7 === '/' && /^\/\s*exec\s+sql/i.test(seg(7, 80))) {
      put(6, 6, Tok.Spec);
      const m = /exec\s+sql/i.exec(text.slice(at(7)));
      const s = at(7) + (m?.index ?? 0);
      paint(out, at(7), at(7) + 1, Tok.Keyword);
      paint(out, s, s + (m?.[0].length ?? 0), Tok.Keyword);
      highlightSqlRange(text.slice(0, at(80) + 1), s + (m?.[0].length ?? 0), out, st.sqlComment);
      st.sql = true;
      tail();
      return out;
    }
    if (spec === 'C' && c7 === '/' && /^\/\s*end-exec/i.test(seg(7, 80))) {
      put(6, 6, Tok.Spec);
      put(7, 16, Tok.Keyword);
      st.sql = false;
      return out;
    }
    if (spec === 'C' && c7 === '+' && st.sql) {
      put(6, 7, Tok.Spec);
      highlightSqlRange(text.slice(0, at(80) + 1), Math.max(0, at(8)), out, st.sqlComment);
      tail();
      return out;
    }

    if (c7 === '*' && (spec === '' || spec === ' ' || /^[HFDICOP]$/.test(spec))) {
      put(6, 6, Tok.Spec);
      paint(out, Math.max(0, at(7)), text.length, Tok.Comment);
      return out;
    }
    if (c7 === '/') {
      put(6, 6, Tok.Spec);
      const m = /^\/[A-Za-z-]+/.exec(seg(7, 80));
      if (m) paint(out, at(7), at(7) + m[0].length, Tok.Keyword);
      expr(7 + (m?.[0].length ?? 1), 80);
      return out;
    }

    switch (spec) {
      case 'H':
        put(6, 6, Tok.Spec);
        expr(7, 80);
        break;
      case 'F':
        put(6, 6, Tok.Spec);
        put(7, 16, Tok.Name);
        for (const c of [17, 18, 19, 20, 22, 28, 34, 35]) put(c, c, Tok.Special);
        put(23, 27, Tok.Number);
        put(29, 33, Tok.Number);
        put(36, 42, Tok.Keyword);
        expr(44, 80);
        break;
      case 'D':
      case 'P':
        put(6, 6, Tok.Spec);
        put(7, 21, Tok.Name);
        put(22, 23, Tok.Special);
        put(24, 25, Tok.Keyword);
        put(26, 39, Tok.Number);
        put(40, 40, Tok.Special);
        put(41, 42, Tok.Number);
        expr(44, 80);
        break;
      case 'C': {
        put(6, 6, Tok.Spec);
        put(7, 8, Tok.Indicator);
        put(9, 11, Tok.Indicator);
        const opcode = seg(26, 35).trim();
        const opWord = (/^[A-Za-z-]+/.exec(opcode)?.[0] ?? '').toUpperCase();
        expr(12, 25);
        if (opcode) put(26, 35, Tok.Keyword);
        if (!opcode || EXT_FACTOR2.has(opWord)) {
          expr(36, 80);
        } else {
          expr(36, 49);
          expr(50, 63);
          put(64, 70, Tok.Number);
          put(71, 76, Tok.Indicator);
        }
        break;
      }
      case 'I':
      case 'O':
        put(6, 6, Tok.Spec);
        expr(7, 80);
        break;
      default:
        // Columns 6-7 blank: free-form code in columns 8-80.
        if (!seg(6, 7).trim()) freeLine(text.slice(0, at(80) + 1), Math.max(0, at(8)), out, st);
        break;
    }
    tail();
    return out;
  });
}

// ---------------------------------------------------------------------------
// Language detection

export function languageFromFile(sourceFile: string): SourceLang | undefined {
  const f = sourceFile.toUpperCase();
  if (/RPG/.test(f)) return 'rpg';
  if (/^Q?CL|CLLE|CLP|QCL/.test(f)) return 'cl';
  if (/DDS|DSPF|PRTF|QPF|QLF/.test(f)) return 'dds';
  if (/SQL/.test(f)) return 'sql';
  return undefined;
}

/** Guesses the language from the visible lines (source file names are not always standard). */
export function languageFromContent(lines: string[], firstColumn: number): SourceLang | undefined {
  let rpg = 0;
  let dds = 0;
  let cl = 0;
  let sql = 0;
  for (const t of lines) {
    const at = (c: number): string => t[c - firstColumn] ?? '';
    if (/^\s*(\*\*free|dcl-|ctl-opt)/i.test(t)) rpg += 3;
    if (at(6).toUpperCase() === 'A' && firstColumn <= 6) dds++;
    else if (/[HFDCP]/i.test(at(6)) && firstColumn <= 6) rpg++;
    if (/^\s*(\w+:\s*)?(PGM|ENDPGM|DCL|DCLF|CHGVAR|MONMSG|CALL|SNDPGMMSG|RTVJOBA|OVRDBF|DLTOVR|GOTO|IF|ELSE|DO|ENDDO)\b/i.test(t)) cl++;
    if (/^\s*(select|insert|update|delete|create|alter|drop|with|set|call|values|merge)\b/i.test(t)) sql++;
  }
  const best = Math.max(rpg, dds, cl, sql);
  if (best === 0) return undefined;
  if (best === rpg) return 'rpg';
  if (best === dds) return 'dds';
  if (best === cl) return 'cl';
  return 'sql';
}

// ---------------------------------------------------------------------------
// SEU screen detection

const SEQ = /^(\d{4}\.\d{2}|\d{6,7}|'{7}|,{7})/;

/** Recognises an SEU edit/browse screen and returns its source lines. */
export function detectSeu(s: ScreenSnapshot): SeuScreen | undefined {
  if (s.rows < 10) return undefined;
  const head = rowText(s, 0);
  const cm = /Columns\s*\.\s*\.\s*\.\s*:\s*(\d+)\s+(\d+)/.exec(head);
  if (!cm) return undefined;
  let seuLine = false;
  for (let r = 0; r < 3; r++) if (/SEU\s*==>/.test(rowText(s, r))) seuLine = true;
  if (!seuLine) return undefined;
  const firstColumn = Number(cm[1]);
  const fm = /(\S+)\/(\S+)\s*$/.exec(head);
  const sourceFile = fm ? (fm[2] as string) : '';

  // Long input fields per row: in edit mode each data line is [sequence/line command][source].
  const longFieldStart = new Map<number, number>();
  for (const f of s.fields) {
    if (f.bypass || f.length < 20) continue;
    const row = Math.floor(f.start / s.cols);
    const col = f.start % s.cols;
    if (col > 0 && col < 20 && !longFieldStart.has(row)) longFieldStart.set(row, col);
  }
  const lines: SeuLine[] = [];
  for (let r = 2; r < s.rows - 2; r++) {
    const t = rowText(s, r);
    const fieldCol = longFieldStart.get(r);
    const seqOk = SEQ.test(t.trimStart().slice(0, 7)) || SEQ.test(t.slice(0, 7));
    if (fieldCol === undefined && !seqOk) continue;
    if (/\*{5,}\s*(Beginning|End) of data/i.test(t)) continue;
    const col = fieldCol ?? 8;
    const raw = t.slice(col).replace(/\0/g, ' ');
    lines.push({ row: r, col, text: raw });
  }
  if (!lines.length) return undefined;
  const lang = languageFromFile(sourceFile) ?? languageFromContent(lines.map((l) => l.text), firstColumn) ?? 'rpg';
  return { lang, firstColumn, sourceFile, lines };
}

/** Token kinds for each line of source text (one entry per character). */
export function highlightLines(lang: SourceLang, lines: string[], firstColumn = 1): Uint8Array[] {
  switch (lang) {
    case 'cl':
      return highlightCl(lines);
    case 'dds':
      return highlightDds(lines, firstColumn);
    case 'sql':
      return highlightSql(lines);
    default:
      return highlightRpg(lines, firstColumn);
  }
}

/** Per-cell token kinds for an SEU screen, or undefined when the screen is not SEU. */
export function highlightScreen(s: ScreenSnapshot): Uint8Array | undefined {
  const seu = detectSeu(s);
  if (!seu) return undefined;
  const cells = new Uint8Array(s.rows * s.cols);
  const kinds = highlightLines(seu.lang, seu.lines.map((l) => l.text), seu.firstColumn);
  seu.lines.forEach((l, i) => {
    const k = kinds[i] as Uint8Array;
    const base = l.row * s.cols + l.col;
    cells.set(k.subarray(0, Math.min(k.length, s.cols - l.col)), base);
  });
  return cells;
}
