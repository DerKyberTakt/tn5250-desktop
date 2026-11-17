/**
 * Splits the text of a Run SQL Scripts editor into runnable statements, the way ACS
 * does: statements end at a semicolon outside quotes and comments; a line that reads
 * like a CL command (`DSPLIBL OUTPUT(*PRINT)`, or prefixed `CL:`) is one (ending at its
 * semicolon or line end, continued over a line ending in `+`); a line that reads like a
 * shell command (`ls -l /home`, or prefixed `QSH:`) is a Qshell / PASE command line (to
 * the end of the line, so it may itself contain semicolons; continued over a line
 * ending in `\`); `--` and block comments are skipped; statement boundaries keep their
 * offsets so "run selected" and "run from cursor" can pick by position. The kind of a
 * line comes from `classify` in runKind.ts.
 */

import { classify } from './runKind';

export interface Statement {
  kind: 'sql' | 'cl' | 'qsh' | 'pase';
  /** The statement without its terminating semicolon (CL: / QSH: without the prefix). */
  text: string;
  /** What decided the kind ("CL verb DSPLIBL", "prefix QSH:", ...). */
  why: string;
  /** Offsets into the editor text: first character of the statement and the one after it. */
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
}

export function splitStatements(source: string): Statement[] {
  const out: Statement[] = [];
  const n = source.length;
  let i = 0;
  const lineAt = (pos: number): number => {
    let line = 1;
    for (let k = 0; k < pos; k++) if (source.charCodeAt(k) === 10) line++;
    return line;
  };
  while (i < n) {
    // Skip whitespace, comments and stray semicolons between statements.
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ';') {
      i++;
      continue;
    }
    if (source.startsWith('--', i)) {
      i = endOfLine(source, i);
      continue;
    }
    if (source.startsWith('/*', i)) {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    const start = i;
    const firstLine = source.slice(i, endOfLine(source, i)).replace(/\r?\n$/, '');
    const probe = classify(firstLine.replace(/\s*[+\\]\s*$/, '').replace(/\s*;\s*$/, ''));
    if (probe.kind === 'qsh' || probe.kind === 'pase') {
      // A shell command line, to the end of the line; `\` continues it.
      let j = endOfLine(source, i);
      while (/\\\s*$/.test(source.slice(i, j).replace(/\r?\n$/, '')) && j < n) j = endOfLine(source, j);
      const text = joinContinued(source.slice(i, j), '\\');
      const { text: body, why } = classify(text);
      if (body) out.push({ kind: probe.kind, text: body, why, start, end: j, line: lineAt(start) });
      i = j;
      continue;
    }
    if (probe.kind === 'cl') {
      // A CL command, up to a semicolon or the end of the line; `+` continues it.
      let j = i;
      for (;;) {
        while (j < n && source[j] !== ';' && source[j] !== '\n') j++;
        if (j < n && source[j] === '\n' && /\+\s*$/.test(source.slice(i, j).split('\n').pop() ?? '')) {
          j++;
          continue;
        }
        break;
      }
      const text = joinContinued(source.slice(i, j), '+');
      const { text: body, why } = classify(text);
      if (body) out.push({ kind: 'cl', text: body, why, start, end: j, line: lineAt(start) });
      i = j;
      continue;
    }
    // SQL: to the next semicolon outside quotes and comments.
    let j = i;
    let quote: string | undefined;
    while (j < n) {
      const c = source[j]!;
      if (quote) {
        if (c === quote) {
          if (source[j + 1] === quote) j++; // doubled quote inside a literal
          else quote = undefined;
        }
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (source.startsWith('--', j)) {
        j = endOfLine(source, j) - 1;
      } else if (source.startsWith('/*', j)) {
        const close = source.indexOf('*/', j + 2);
        j = close < 0 ? n - 1 : close + 1;
      } else if (c === ';') {
        break;
      }
      j++;
    }
    const raw = source.slice(i, j).trim();
    if (raw) {
      const { kind, text, why } = classify(raw);
      out.push({ kind, text, why, start, end: j, line: lineAt(start) });
    }
    i = j;
  }
  return out;
}

/** Folds continuation lines (`+` for CL, `\` for a shell line) into one line. */
function joinContinued(text: string, mark: '+' | '\\'): string {
  const lines = text.replace(/\r/g, '').split('\n');
  return lines
    .map((l, k) => {
      let t = l.replace(/\s+$/, '');
      if (k < lines.length - 1 && t.endsWith(mark)) t = t.slice(0, -1).replace(/\s+$/, '');
      return k > 0 ? t.replace(/^\s+/, '') : t;
    })
    .join(' ')
    .trim();
}

function endOfLine(s: string, from: number): number {
  const nl = s.indexOf('\n', from);
  return nl < 0 ? s.length : nl + 1;
}

/**
 * The statement under a caret position; a caret just after the semicolon, still on
 * the statement's last line, counts as inside it (`source` is the editor text).
 */
export function statementAt(statements: Statement[], pos: number, source: string): Statement | undefined {
  const inside = statements.find((s) => pos >= s.start && pos <= s.end);
  if (inside) return inside;
  return [...statements].reverse().find((s) => s.end <= pos && !source.slice(s.end, pos).includes('\n'));
}

/** Statements overlapping a selection [from, to); a collapsed selection is a caret. */
export function statementsIn(statements: Statement[], from: number, to: number, source: string): Statement[] {
  if (from === to) {
    const one = statementAt(statements, from, source);
    return one ? [one] : [];
  }
  return statements.filter((s) => s.end > from && s.start < to);
}

/** Statements from the one under the caret (or the next one after it) to the end. */
export function statementsFrom(statements: Statement[], pos: number, source: string): Statement[] {
  const first = statementAt(statements, pos, source) ?? statements.find((s) => s.start >= pos);
  return first ? statements.filter((s) => s.start >= first.start) : [];
}

/** A short label for the Messages pane: the first words of the statement. */
export function statementLabel(s: Statement, max = 60): string {
  const flat = (s.kind === 'cl' ? 'CL: ' : s.kind === 'qsh' ? 'QSH: ' : s.kind === 'pase' ? 'PASE: ' : '') + s.text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
