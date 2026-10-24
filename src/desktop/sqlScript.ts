/**
 * Splits the text of a Run SQL Scripts editor into runnable statements, the way ACS
 * does: statements end at a semicolon outside quotes and comments; a line starting
 * with `CL:` is a CL command (ending at its semicolon or line end); `--` and
 * block comments are skipped; statement boundaries keep their offsets so
 * "run selected" and "run from cursor" can pick by position.
 */

export interface Statement {
  kind: 'sql' | 'cl';
  /** The statement without its terminating semicolon (CL: without the prefix). */
  text: string;
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
    if (/^cl:/i.test(source.slice(i, i + 3))) {
      // CL: command, up to a semicolon or the end of the line.
      let j = i + 3;
      while (j < n && source[j] !== ';' && source[j] !== '\n') j++;
      const text = source.slice(i + 3, j).replace(/\r$/, '').trim();
      if (text) out.push({ kind: 'cl', text, start, end: j, line: lineAt(start) });
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
    const text = source.slice(i, j).trim();
    if (text) out.push({ kind: 'sql', text, start, end: j, line: lineAt(start) });
    i = j;
  }
  return out;
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
  const flat = (s.kind === 'cl' ? 'CL: ' : '') + s.text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
