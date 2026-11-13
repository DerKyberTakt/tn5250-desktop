/**
 * Text forms of a result set for the clipboard and for files: an aligned fixed-width
 * table (what reads well in an editor, a chat or a ticket), a Markdown pipe table, and
 * delimiter-separated rows (TSV for spreadsheets, CSV with RFC 4180 quoting). Also the
 * one-line outcome of a statement, worded the way Db2 for i words it.
 */
import type { SqlColumn, SqlResult } from './bridge';

export const NUMERIC_TYPES = new Set(['SMALLINT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'REAL', 'DOUBLE', 'FLOAT', 'DECFLOAT']);

export type Row = (string | null)[];

/** Column headings as shown: the label when the host gives one, else the name. */
export function headings(columns: SqlColumn[]): string[] {
  return columns.map((c) => c.label || c.name);
}

export function isNumeric(c: SqlColumn): boolean {
  return NUMERIC_TYPES.has(c.type.toUpperCase());
}

/** A CL or QSH result: one OUTPUT column holding the lines the command printed. */
export function isOutputLines(r: SqlResult): boolean {
  return r.kind === 'rows' && r.columns?.length === 1 && r.columns[0]!.name.toUpperCase() === 'OUTPUT';
}

/** Line ends for the clipboard and files on every platform the app runs on. */
const EOL = '\r\n';

/**
 * Fixed-width table: headings, a dashed rule, then the rows; numbers right-aligned,
 * NULL shown as `-`, a line break inside a value shown as `⏎` so the rows stay lines.
 */
export function alignedTable(columns: SqlColumn[], rows: Row[]): string {
  const heads = headings(columns);
  const cell = (v: string | null): string => (v === null ? '-' : v.replace(/\r\n|\r|\n/g, '⏎'));
  const widths = heads.map((h, i) => rows.reduce((w, r) => Math.max(w, cell(r[i] ?? null).length), h.length));
  const right = columns.map(isNumeric);
  const line = (cells: string[]): string => cells.map((c, i) => (right[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ').replace(/\s+$/, '');
  const out = [line(heads), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(heads.map((_, i) => cell(r[i] ?? null))));
  return out.join(EOL) + EOL;
}

/** Markdown pipe table (numbers right-aligned by the `---:` rule); `|` inside a value is escaped. */
export function markdownTable(columns: SqlColumn[], rows: Row[]): string {
  const heads = headings(columns);
  const cell = (v: string | null): string => (v === null ? '' : v.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>'));
  const out = [`| ${heads.map(cell).join(' | ')} |`, `| ${columns.map((c) => (isNumeric(c) ? '---:' : '---')).join(' | ')} |`];
  for (const r of rows) out.push(`| ${heads.map((_, i) => cell(r[i] ?? null)).join(' | ')} |`);
  return out.join(EOL) + EOL;
}

/** Rows joined by `sep` (tab, comma, semicolon); CSV quoting when the value needs it; NULL empty. */
export function delimitedTable(columns: SqlColumn[], rows: Row[], sep: string): string {
  const quoteWhen = sep === '\t' ? /[\t\r\n"]/ : new RegExp(`["\\r\\n${sep}]`);
  const cell = (v: string | null): string => {
    const s = v ?? '';
    return quoteWhen.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headings(columns).map(cell).join(sep)];
  for (const r of rows) out.push(r.map(cell).join(sep));
  return out.join(EOL) + EOL;
}

export const fmt = (n: number): string => n.toLocaleString('en-US');

export function plural(n: number, word: string): string {
  return `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** The one-line outcome of a result, the way Db2 for i words it. */
export function outcomeText(r: SqlResult, fetchMs: number): string {
  const ms = `${fmt(r.elapsedMs)} ms`;
  switch (r.kind) {
    case 'rows': {
      const n = r.rows?.length ?? 0;
      if (isOutputLines(r)) return `Output: ${plural(n, 'line')} in ${ms}.`;
      const fetched = fetchMs ? ` + ${fmt(fetchMs)} ms` : '';
      return `Loaded ${plural(n, 'row')} in ${ms}${fetched}. ${r.more ? 'More rows available.' : 'End of data.'}`;
    }
    case 'count':
      return `${plural(r.updateCount, 'row')} affected in ${ms}.`;
    case 'error': {
      const m = r.messages[0];
      return m ? `${m.id}${m.code ? ` (SQLCODE ${m.code})` : ''}: ${m.text} · ${ms}` : `Failed after ${ms}.`;
    }
    default:
      return `Statement ran in ${ms}.`;
  }
}

export function typeLabel(c: SqlColumn): string {
  const t = c.type.toUpperCase();
  if (t === 'DECIMAL' || t === 'NUMERIC') return `${t}(${c.length},${c.scale})`;
  if (['CHAR', 'VARCHAR', 'GRAPHIC', 'VARGRAPHIC', 'BINARY', 'VARBINARY'].includes(t)) return `${t}(${c.length})`;
  return t;
}
