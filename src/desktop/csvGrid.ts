/**
 * A CSV / TSV file as a grid: the delimiter sniffed, RFC 4180 quotes honoured, the first
 * row as the headings (switchable), a filter box per column, the rows that match counted,
 * and a copy as an aligned text table. Nothing is written back from the grid: Text mode
 * edits the file.
 */
import { alignedTable } from './sqlText';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface Csv {
  delimiter: string;
  rows: string[][];
}

/** The delimiter that splits the first lines most evenly: comma, semicolon, tab or pipe. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) continue;
    const same = counts.every((c) => c === counts[0]);
    const score = total * (same ? 2 : 1);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/** Parses the text; a quoted field may hold the delimiter, doubled quotes and line breaks. */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): Csv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // A trailing empty line is not a row.
  while (rows.length && rows[rows.length - 1]!.every((f) => f === '')) rows.pop();
  return { delimiter, rows };
}

/** At most this many rows go into the table; a filter narrows the rest. */
const RENDER_LIMIT = 5000;

export class CsvGrid {
  readonly element: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private csv: Csv = { delimiter: ',', rows: [] };
  private headerRow = true;
  private filters: string[] = [];

  constructor(private readonly onCopy?: (text: string) => void) {
    this.element = el('div', 'csv-grid');
    this.bar = el('div', 'csv-bar');
    const header = el('label', 'csv-header-toggle');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      this.headerRow = box.checked;
      this.render();
    });
    header.append(box, ' First row is the header');
    this.count = el('span', 'csv-count');
    const copy = el('button', 'csv-copy', 'Copy as text');
    copy.type = 'button';
    copy.title = 'Copy the rows on show as an aligned text table';
    copy.addEventListener('click', () => this.onCopy?.(this.alignedText()));
    this.bar.append(header, this.count, copy);
    this.scroll = el('div', 'csv-scroll');
    this.element.append(this.bar, this.scroll);
  }

  setText(text: string): void {
    this.csv = parseCsv(text);
    this.filters = [];
    this.render();
  }

  get columns(): number {
    return this.csv.rows.reduce((w, r) => Math.max(w, r.length), 0);
  }

  private headings(): string[] {
    const w = this.columns;
    const first = this.headerRow ? (this.csv.rows[0] ?? []) : [];
    return Array.from({ length: w }, (_, i) => (this.headerRow ? first[i] || `Column ${i + 1}` : `Column ${i + 1}`));
  }

  private dataRows(): string[][] {
    return this.headerRow ? this.csv.rows.slice(1) : this.csv.rows;
  }

  /** The rows every filter accepts (case-insensitive "contains" per column). */
  visibleRows(): string[][] {
    const active = this.filters.map((f) => f.trim().toLowerCase());
    if (active.every((f) => !f)) return this.dataRows();
    return this.dataRows().filter((r) => active.every((f, i) => !f || (r[i] ?? '').toLowerCase().includes(f)));
  }

  alignedText(): string {
    const heads = this.headings();
    const cols = heads.map((h) => ({ name: h, type: 'CHAR', length: 0, scale: 0, nullable: false }));
    return alignedTable(cols, this.visibleRows().map((r) => heads.map((_, i) => r[i] ?? '')));
  }

  render(): void {
    const heads = this.headings();
    this.scroll.replaceChildren();
    const table = el('table', 'sql-grid csv-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of heads) hr.append(el('th', undefined, h));
    const fr = el('tr', 'csv-filters');
    heads.forEach((_, i) => {
      const th = el('th');
      const input = el('input', 'csv-filter');
      input.type = 'search';
      input.placeholder = 'filter';
      input.value = this.filters[i] ?? '';
      input.addEventListener('input', () => {
        this.filters[i] = input.value;
        this.renderRows();
      });
      th.append(input);
      fr.append(th);
    });
    thead.append(hr, fr);
    table.append(thead, el('tbody'));
    this.scroll.append(table);
    this.renderRows();
  }

  private renderRows(): void {
    const table = this.scroll.querySelector('table');
    const body = table?.querySelector('tbody');
    if (!body) return;
    const heads = this.headings();
    const rows = this.visibleRows();
    const total = this.dataRows().length;
    body.replaceChildren();
    for (const r of rows.slice(0, RENDER_LIMIT)) {
      const tr = el('tr');
      heads.forEach((_, i) => tr.append(el('td', undefined, r[i] ?? '')));
      body.append(tr);
    }
    const limit = rows.length > RENDER_LIMIT ? ` (the first ${RENDER_LIMIT.toLocaleString('en-US')} shown; filter to narrow)` : '';
    this.count.textContent = rows.length === total ? `${total.toLocaleString('en-US')} rows${limit}` : `${rows.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows${limit}`;
  }
}
