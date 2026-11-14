/**
 * A CSV / TSV file as a grid: the delimiter sniffed, RFC 4180 quotes honoured, the first
 * row as the headings (switchable), a filter box per column, the rows that match counted,
 * and a copy as an aligned text table. In edit mode a cell opens on a double-click, F2,
 * Enter or a typed character (Enter moves down, Tab right, Escape puts the old value back),
 * and every change is handed back as the whole file's text, delimiter and line ends kept.
 */
import { actionButton } from './icons';
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

/** A field as RFC 4180 writes it: quoted when it holds the delimiter, a quote, a line break or edge spaces. */
export function csvField(v: string, delimiter: string): string {
  return v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r') || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The rows as text, one line each, ended the way the file was. */
export function serializeCsv(csv: Csv, lineEnd = '\n'): string {
  return csv.rows.map((r) => r.map((v) => csvField(v, csv.delimiter)).join(csv.delimiter) + lineEnd).join('');
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
  private lineEnd = '\n';
  private headerRow = true;
  private filters: string[] = [];
  private editable = false;

  constructor(
    private readonly onCopy?: (text: string) => void,
    /** Told the whole text after a cell changed (edit mode). */
    private readonly onChange?: (text: string) => void,
  ) {
    this.element = el('div', 'csv-grid');
    this.bar = el('div', 'csv-bar icon-actions');
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
    const copy = actionButton('copy', 'Copy the rows on show as an aligned text table', 'blue');
    copy.classList.add('csv-copy');
    copy.addEventListener('click', () => this.onCopy?.(this.alignedText()));
    this.bar.append(header, this.count, copy);
    this.scroll = el('div', 'csv-scroll');
    this.element.append(this.bar, this.scroll);
  }

  setText(text: string): void {
    this.csv = parseCsv(text);
    this.lineEnd = text.includes('\r\n') ? '\r\n' : '\n';
    this.filters = [];
    this.render();
  }

  /** The file as the grid holds it now. */
  get text(): string {
    return serializeCsv(this.csv, this.lineEnd);
  }

  /** Edit mode: cells open on a double-click, F2, Enter or a typed character. */
  setEditable(on: boolean): void {
    if (this.editable === on) return;
    this.editable = on;
    this.element.classList.toggle('editable', on);
    this.renderRows();
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

  /** The rows every filter accepts (case-insensitive "contains" per column), with their index in the file. */
  private visible(): { row: string[]; index: number }[] {
    const first = this.headerRow ? 1 : 0;
    const active = this.filters.map((f) => f.trim().toLowerCase());
    const all = this.dataRows().map((row, i) => ({ row, index: i + first }));
    if (active.every((f) => !f)) return all;
    return all.filter(({ row }) => active.every((f, i) => !f || (row[i] ?? '').toLowerCase().includes(f)));
  }

  visibleRows(): string[][] {
    return this.visible().map((v) => v.row);
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
    const rows = this.visible();
    const total = this.dataRows().length;
    body.replaceChildren();
    for (const { row, index } of rows.slice(0, RENDER_LIMIT)) {
      const tr = el('tr');
      heads.forEach((_, i) => {
        const td = el('td', undefined, row[i] ?? '');
        if (this.editable) {
          td.tabIndex = 0;
          td.dataset.row = String(index);
          td.dataset.col = String(i);
          td.addEventListener('dblclick', () => this.editCell(td));
          td.addEventListener('keydown', (e) => this.cellKey(td, e));
        }
        tr.append(td);
      });
      body.append(tr);
    }
    const limit = rows.length > RENDER_LIMIT ? ` (the first ${RENDER_LIMIT.toLocaleString('en-US')} shown; filter to narrow)` : '';
    if (this.editable) this.count.title = 'Double-click a cell (or F2, Enter, or just type) to change it; Enter moves down, Tab right, Escape puts the old value back';
    this.count.textContent = rows.length === total ? `${total.toLocaleString('en-US')} rows${limit}` : `${rows.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} rows${limit}`;
  }

  /** Keys on a focused cell: open it, or move to a neighbour. */
  private cellKey(td: HTMLTableCellElement, e: KeyboardEvent): void {
    if (td.querySelector('input')) return;
    if (e.key === 'F2' || e.key === 'Enter') {
      e.preventDefault();
      this.editCell(td);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.editCell(td, e.key);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.moveFocus(td, e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0, e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
    }
  }

  private moveFocus(td: HTMLTableCellElement, dRow: number, dCol: number): void {
    const tr = td.parentElement as HTMLTableRowElement | null;
    if (!tr) return;
    const rowEl = dRow > 0 ? tr.nextElementSibling : dRow < 0 ? tr.previousElementSibling : tr;
    const cell = (rowEl as HTMLTableRowElement | null)?.cells[td.cellIndex + dCol];
    cell?.focus();
  }

  /** Opens a cell for typing; `start` replaces the value with the character typed. */
  private editCell(td: HTMLTableCellElement, start?: string): void {
    if (!this.editable || td.querySelector('input')) return;
    const old = td.textContent ?? '';
    const input = el('input', 'csv-cell');
    input.value = start ?? old;
    td.replaceChildren(input);
    td.classList.add('editing');
    let done = false;
    const finish = (commit: boolean, then?: () => void): void => {
      if (done) return;
      done = true;
      const value = commit ? input.value : old;
      td.replaceChildren(value);
      td.classList.remove('editing');
      if (commit && value !== old) {
        const r = Number(td.dataset.row);
        const c = Number(td.dataset.col);
        const row = this.csv.rows[r] ?? (this.csv.rows[r] = []);
        while (row.length <= c) row.push('');
        row[c] = value;
        this.onChange?.(this.text);
      }
      td.focus();
      then?.();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, () => this.moveFocus(td, 1, 0));
      } else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, () => this.moveFocus(td, 0, e.shiftKey ? -1 : 1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.focus();
    if (start === undefined) input.select();
  }
}
