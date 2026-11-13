/**
 * Which language a stream file is in, by its extension, and the modes CodeMirror has
 * no package for: CL, RPG (fixed and free form) and Windows batch files, written as
 * stream parsers. The IFS viewer colours files with these; the SQL tab's CL: lines use
 * the CL mode too.
 */
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { Extension } from '@codemirror/state';
import { db2iLanguage } from './sqlDialect';

// ---- CL ---------------------------------------------------------------------------------

interface ClState {
  inComment: boolean;
  /** The next word is a command name (start of a statement). */
  expectCommand: boolean;
  /** The previous line ended with + or -: this line continues its statement. */
  continued: boolean;
}

const CL_BIF = /^%[a-z]+/i;

/**
 * CL: the command name of each statement (after an optional LABEL:), parameter keywords
 * before a parenthesis, *VALUES, &variables, %built-ins, strings with doubled quotes,
 * block comments, and + or - continuations.
 */
const clParser: StreamParser<ClState> = {
  name: 'cl',
  startState: () => ({ inComment: false, expectCommand: true, continued: false }),
  token(stream, state) {
    if (stream.sol() && !state.continued) state.expectCommand = true;
    if (stream.sol()) state.continued = false;
    if (state.inComment) {
      if (stream.match(/^.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('/*')) {
      state.inComment = !stream.match(/^.*?\*\//);
      return 'comment';
    }
    if (stream.match(/^'(?:[^']|'')*'?/)) return 'string';
    if (stream.match(/^&[a-z@#$][\w@#$]*/i)) return 'variableName';
    if (stream.match(/^\*[a-z][\w]*/i)) return 'atom';
    if (stream.match(CL_BIF)) return 'name.standard';
    if (stream.match(/^[+-]\s*$/)) {
      state.continued = true;
      return 'operator';
    }
    if (stream.match(/^\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^[a-z@#$][\w@#$]*/i)) {
      const word = stream.current();
      if (stream.match(/^\s*:/, false) && state.expectCommand) {
        stream.match(/^\s*:/);
        return 'labelName';
      }
      if (state.expectCommand) {
        state.expectCommand = false;
        return 'keyword';
      }
      if (stream.peek() === '(') {
        // THEN(cmd) and ELSE(cmd) hold a command of their own.
        if (/^(then|else)$/i.test(word)) state.expectCommand = true;
        return 'typeName';
      }
      if (/^(do|else|enddo|endpgm|endsubr|dountil|dowhile|dofor|iter|leave)$/i.test(word)) return 'keyword';
      return null;
    }
    // Parentheses and the / of a qualified name stay plain; expression operators are coloured.
    if (stream.match(/^(\*\*|\|\||\|<|\|>|<>|>=|<=|[-+*=<>¬])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { block: { open: '/*', close: '*/' } } },
};

export const clLanguage = StreamLanguage.define(clParser);

// ---- RPG ---------------------------------------------------------------------------------

const RPG_FREE_KEYWORDS = new Set(
  'dcl-s dcl-ds dcl-subf dcl-pr dcl-parm dcl-pi dcl-proc dcl-c dcl-f dcl-enum end-ds end-pr end-pi end-proc end-enum ctl-opt if else elseif endif dow dou enddo for endfor select when other endsl exsr begsr endsr return leave iter leavesr monitor on-error endmon on-exit eval eval-corr evalr callp chain read reade readp readpe readc write update delete setll setgt open close exfmt in out unlock clear reset dsply test sorta xml-into xml-sax data-into data-gen exec sql commit rolbk dump except post force next nextw acq rel feod snd-msg set get'.split(
    ' ',
  ),
);

const RPG_TYPES = new Set(
  'char varchar ucs2 varucs2 graph vargraph packed zoned bindec int uns float date time timestamp ind pointer object like likeds likerec likefile inz dim options const value extproc extpgm qualified template based overlay pos static export import ccsid dtaara psds varying len usage keyed keyword extname extfld extfile extdesc alias noopt dftactgrp actgrp bnddir datfmt timfmt option debug copyright main nomain alwnull decedit thread'.split(
    ' ',
  ),
);

const RPG_OPCODES = new Set(
  'acq add adddur alloc andxx begsr bitoff biton cabxx callb callp casxx cat chain check checkr clear close commit comp dealloc define delete div do dou douxx dow dowxx dsply dump else elseif end endcs enddo endfor endif endmon endsl endsr eval evalr eval-corr except exfmt exsr extrct feod for force goto if ifxx in iter kfld klist leave leavesr lookup mhhzo mhlzo mllzo mlhzo monitor move movea movel mult mvr next occur on-error open orxx other out parm plist post read readc reade readp readpe realloc rel reset return rolbk scan select setgt setll seton setoff shtdn sorta sqrt sub subdur subst tag test testb testn testz time unlock update when whenxx write xfoot xlate xml-into xml-sax z-add z-sub'.split(
    ' ',
  ),
);

const SQL_WORDS = new Set(
  'select from where into insert update delete declare cursor for fetch open close values set order by group having and or not null as join left right inner outer on first next rows only with ur cs rs rr commit rollback prepare execute immediate whenever sqlcode sqlstate exists in between like is distinct union all case when then else end cast coalesce count sum min max avg'.split(
    ' ',
  ),
);

interface RpgState {
  /** **FREE at the top: every line is free form. */
  free: boolean;
  /** Between /free and /end-free. */
  inFree: boolean;
  inSql: boolean;
  inComment: boolean;
  /** The current line's spec letter when it is fixed form (C, D, F, H, P, I, O, blank for free). */
  spec: string;
}

/**
 * RPG IV: fixed-form lines by their columns (sequence area, spec letter, * comments, the
 * C-spec opcode in columns 26-35, keyword( on D/F/H/P specs) and free-form lines by word
 * (declarations, control, opcodes, types, %built-ins, // comments, EXEC SQL words).
 */
const rpgParser: StreamParser<RpgState> = {
  name: 'rpg',
  startState: () => ({ free: false, inFree: false, inSql: false, inComment: false, spec: '' }),
  token(stream, state) {
    if (stream.sol()) {
      const line = stream.string;
      if (/^\*\*free/i.test(line)) {
        state.free = true;
        stream.skipToEnd();
        return 'meta';
      }
      if (/^\s*\/(free|end-free)\b/i.test(line)) {
        state.inFree = /^\s*\/free/i.test(line);
        stream.skipToEnd();
        return 'meta';
      }
      if (/^\s*\/(copy|include|define|undefine|if|elseif|else|endif|eof|space|eject|title|set|restore)\b/i.test(line)) {
        stream.skipToEnd();
        return 'meta';
      }
      const fixed = !state.free && !state.inFree && /^.{5}[hfdcpio]/i.test(line) && !/^.{5}[hfdcpio]\s*(\/\/|\/)/i.test(line.slice(0, 8));
      state.spec = fixed ? line.charAt(5).toUpperCase() : '';
      if (fixed) {
        // Columns 1-5 (sequence, change marker), 6 (the spec), 7 (* = comment).
        if (line.charAt(6) === '*') {
          stream.skipToEnd();
          return 'comment';
        }
        stream.pos = 5;
        return 'meta';
      }
    }
    if (state.spec && stream.pos === 5) {
      stream.next();
      return 'keyword';
    }
    if (state.inComment) {
      if (stream.match(/^.*?\*\//)) state.inComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inComment = !stream.match(/^.*?\*\//);
      return 'comment';
    }
    if (stream.match(/^'(?:[^']|'')*'?/)) return 'string';
    if (stream.match(/^%[a-z]+/i)) return 'name.standard';
    if (stream.match(/^\*(in\d\d|in[a-z]{2}|[a-z][\w]*)/i)) return 'atom';
    if (stream.match(/^\d+(\.\d+)?/)) return 'number';
    if (stream.match(/^[a-z@#$][\w@#$-]*/i)) {
      const word = stream.current().toLowerCase();
      const start = stream.start;
      if (state.spec === 'C') {
        // The opcode sits in columns 26-35; factor 1 before it, factor 2 and the result after.
        if (start >= 25 && start <= 34 && (RPG_OPCODES.has(word) || RPG_OPCODES.has(word.replace(/\(.*$/, '')))) return 'keyword';
        if (start >= 25 && start <= 34 && /^(if|dow|dou|when|cas|cab|and|or)(eq|ne|lt|le|gt|ge)?$/.test(word)) return 'keyword';
        return null;
      }
      if (state.spec) {
        if (stream.peek() === '(' && RPG_TYPES.has(word)) return 'typeName';
        if (stream.peek() === '(') return 'typeName';
        return null;
      }
      if (word === 'exec' && stream.match(/^\s+sql\b/i)) {
        state.inSql = true;
        return 'keyword';
      }
      if (state.inSql) {
        if (SQL_WORDS.has(word)) return 'keyword';
        return null;
      }
      if (RPG_FREE_KEYWORDS.has(word)) return 'keyword';
      if (RPG_TYPES.has(word)) return 'typeName';
      if (RPG_OPCODES.has(word) && /^(\s*\(|\s+[\w*'%])/.test(stream.string.slice(stream.pos)) && start === stream.string.search(/\S/)) return 'keyword';
      return null;
    }
    const ch = stream.next();
    if (ch === ';') state.inSql = false;
    if (ch && /[-+*/=<>:]/.test(ch)) return 'operator';
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
};

export const rpgLanguage = StreamLanguage.define(rpgParser);

// ---- Windows batch -------------------------------------------------------------------------

const BATCH_WORDS = new Set(
  'echo set if else for in do goto call exit pause start setlocal endlocal cd chdir md mkdir rd rmdir del erase copy move xcopy robocopy type find findstr not exist defined errorlevel equ neq lss leq gtr geq pushd popd shift choice timeout cls title color ren rename dir attrib more sort tasklist taskkill net sc ping curl wmic powershell pwsh cmd reg assoc ftype ver verify vol date time prompt path on off enabledelayedexpansion enableextensions disabledelayedexpansion'.split(
    ' ',
  ),
);

const batchParser: StreamParser<{ afterEcho: boolean }> = {
  name: 'batch',
  startState: () => ({ afterEcho: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.afterEcho = false;
      if (stream.match(/^\s*(@?rem\b|::)/i)) {
        stream.skipToEnd();
        return 'comment';
      }
      if (stream.match(/^\s*:[^:]\S*/)) return 'labelName';
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^%~?[a-z0-9_]+%?|^!\w+!|^%%?[a-z]/i)) return 'variableName';
    if (stream.match(/^"[^"]*"?/)) return 'string';
    if (stream.match(/^(&&|\|\||[&|<>]|2>&1|>>)/)) return 'operator';
    if (stream.eat('@')) return 'meta';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^[a-z_][\w.-]*/i)) {
      const word = stream.current().toLowerCase();
      if (state.afterEcho) return null;
      if (BATCH_WORDS.has(word)) {
        if (word === 'echo') state.afterEcho = true;
        return 'keyword';
      }
      return null;
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: 'rem ' } },
};

export const batchLanguage = StreamLanguage.define(batchParser);

/** The POSIX shell mode (QSH: lines and .sh files). */
export const shellLanguage = StreamLanguage.define(shell);

// ---- by extension --------------------------------------------------------------------------

export interface FileLanguage {
  /** `code` opens in the editor with the extension's colours, `csv` as a grid, `plain` as text. */
  kind: 'code' | 'csv' | 'plain';
  /** What the status line calls it. */
  name: string;
  extension?: Extension;
}

const BY_EXTENSION: Record<string, () => FileLanguage> = {
  json: () => ({ kind: 'code', name: 'JSON', extension: json() }),
  py: () => ({ kind: 'code', name: 'Python', extension: python() }),
  js: () => ({ kind: 'code', name: 'JavaScript', extension: javascript() }),
  mjs: () => ({ kind: 'code', name: 'JavaScript', extension: javascript() }),
  cjs: () => ({ kind: 'code', name: 'JavaScript', extension: javascript() }),
  ts: () => ({ kind: 'code', name: 'TypeScript', extension: javascript({ typescript: true }) }),
  xml: () => ({ kind: 'code', name: 'XML', extension: xml() }),
  xsd: () => ({ kind: 'code', name: 'XML', extension: xml() }),
  xsl: () => ({ kind: 'code', name: 'XML', extension: xml() }),
  svg: () => ({ kind: 'code', name: 'SVG', extension: xml() }),
  html: () => ({ kind: 'code', name: 'HTML', extension: html() }),
  htm: () => ({ kind: 'code', name: 'HTML', extension: html() }),
  yaml: () => ({ kind: 'code', name: 'YAML', extension: yaml() }),
  yml: () => ({ kind: 'code', name: 'YAML', extension: yaml() }),
  md: () => ({ kind: 'code', name: 'Markdown', extension: markdown() }),
  markdown: () => ({ kind: 'code', name: 'Markdown', extension: markdown() }),
  css: () => ({ kind: 'code', name: 'CSS', extension: css() }),
  sql: () => ({ kind: 'code', name: 'SQL', extension: db2iLanguage() }),
  sh: () => ({ kind: 'code', name: 'Shell', extension: shellLanguage }),
  bash: () => ({ kind: 'code', name: 'Shell', extension: shellLanguage }),
  ksh: () => ({ kind: 'code', name: 'Shell', extension: shellLanguage }),
  zsh: () => ({ kind: 'code', name: 'Shell', extension: shellLanguage }),
  qsh: () => ({ kind: 'code', name: 'Shell', extension: shellLanguage }),
  ps1: () => ({ kind: 'code', name: 'PowerShell', extension: StreamLanguage.define(powerShell) }),
  psm1: () => ({ kind: 'code', name: 'PowerShell', extension: StreamLanguage.define(powerShell) }),
  properties: () => ({ kind: 'code', name: 'Properties', extension: StreamLanguage.define(properties) }),
  ini: () => ({ kind: 'code', name: 'INI', extension: StreamLanguage.define(properties) }),
  cfg: () => ({ kind: 'code', name: 'Config', extension: StreamLanguage.define(properties) }),
  conf: () => ({ kind: 'code', name: 'Config', extension: StreamLanguage.define(properties) }),
  env: () => ({ kind: 'code', name: 'Properties', extension: StreamLanguage.define(properties) }),
  bat: () => ({ kind: 'code', name: 'Batch', extension: batchLanguage }),
  cmd: () => ({ kind: 'code', name: 'Batch', extension: batchLanguage }),
  cl: () => ({ kind: 'code', name: 'CL', extension: clLanguage }),
  clle: () => ({ kind: 'code', name: 'CL', extension: clLanguage }),
  clp: () => ({ kind: 'code', name: 'CL', extension: clLanguage }),
  cle: () => ({ kind: 'code', name: 'CL', extension: clLanguage }),
  clp38: () => ({ kind: 'code', name: 'CL', extension: clLanguage }),
  rpg: () => ({ kind: 'code', name: 'RPG', extension: rpgLanguage }),
  rpgle: () => ({ kind: 'code', name: 'RPG', extension: rpgLanguage }),
  sqlrpgle: () => ({ kind: 'code', name: 'RPG (SQL)', extension: rpgLanguage }),
  rpg38: () => ({ kind: 'code', name: 'RPG', extension: rpgLanguage }),
  rpgiv: () => ({ kind: 'code', name: 'RPG', extension: rpgLanguage }),
  csv: () => ({ kind: 'csv', name: 'CSV' }),
  tsv: () => ({ kind: 'csv', name: 'TSV' }),
};

/** The language of a file by its name (`notes.txt` is plain text; `a.CLLE` is CL). */
export function languageFor(name: string): FileLanguage {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const make = BY_EXTENSION[ext];
  if (make) return make();
  return { kind: 'plain', name: ext === 'txt' || ext === 'log' || !ext ? 'Text' : `Text (.${ext})` };
}
