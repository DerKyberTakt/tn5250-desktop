/**
 * One result tab of Run SQL Scripts: the grid of a SELECT (or of a CL command's lines),
 * Fetch more, row selection, and the copies (aligned text, Markdown, TSV, CSV file).
 * ACS opens one such tab per statement that returns rows; this is that tab.
 */
import { goApp, type SqlResult } from './bridge';
import { alignedTable, delimitedTable, isNumeric, markdownTable, outcomeText, plural, typeLabel, type Row } from './sqlText';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface ResultHost {
  /** Fetches the next block of a cursor; undefined when the tab is busy with something else. */
  fetchMore(cursor: string, max: number): Promise<SqlResult | undefined>;
  notify(text: string): void;
  /** The tab was clicked (bring it to the front) or its ✕ was clicked (close it). */
  activate(view: ResultView): void;
  close(view: ResultView): void;
}

export type CopyKind = 'text' | 'markdown' | 'tsv';

export class ResultView {
  readonly button: HTMLButtonElement;
  readonly pane: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly status: HTMLDivElement;
  /** Milliseconds spent in Fetch more, added to the status line. */
  private fetchMs = 0;
  private readonly selected = new Set<number>();
  private anchor = -1;

  constructor(
    readonly n: number,
    /** The statement, shortened, for the tab's tooltip. */
    readonly label: string,
    private result: SqlResult,
    private readonly host: ResultHost,
    /** Rows asked for per Fetch more. */
    private readonly fetchRows: number,
  ) {
    this.button = el('button');
    this.button.type = 'button';
    this.button.setAttribute('role', 'tab');
    this.button.title = label;
    const close = el('span', 'close', '×');
    close.title = 'Close this result';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      host.close(this);
    });
    this.button.append(el('span', undefined, `Result ${n}`), close);
    this.button.addEventListener('click', () => host.activate(this));

    this.pane = el('div', 'sql-pane sql-results');
    this.pane.hidden = true;
    this.grid = el('div', 'sql-grid-wrap');
    this.status = el('div', 'sql-results-status');
    this.status.setAttribute('role', 'status');
    this.pane.append(this.grid, this.status);
    this.render();
  }

  get rows(): Row[] {
    return this.result.rows ?? [];
  }

  /** The selected rows in order, or every row when none is selected. */
  private rowsToCopy(): Row[] {
    const all = this.rows;
    if (!this.selected.size) return all;
    return all.filter((_, i) => this.selected.has(i));
  }

  private render(): void {
    const r = this.result;
    this.grid.replaceChildren();
    if (!r.columns) return;
    const table = el('table', 'sql-grid');
    const head = el('thead');
    const hr = el('tr');
    for (const c of r.columns) {
      const th = el('th', undefined, c.label || c.name);
      th.append(el('span', 'type', typeLabel(c)));
      hr.append(th);
    }
    head.append(hr);
    const body = el('tbody');
    const numeric = r.columns.map(isNumeric);
    this.rows.forEach((row, index) => {
      const tr = el('tr', this.selected.has(index) ? 'selected' : undefined);
      row.forEach((v, i) => {
        tr.append(el('td', v === null ? 'null' : numeric[i] ? 'num' : undefined, v === null ? 'NULL' : v));
      });
      tr.addEventListener('click', (e) => this.select(index, e));
      body.append(tr);
    });
    table.append(head, body);
    this.grid.append(table);

    const tools = el('div', 'sql-more');
    const button = (text: string, title: string, run: () => void): HTMLButtonElement => {
      const b = el('button', undefined, text);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', run);
      tools.append(b);
      return b;
    };
    if (r.more) button(`Fetch ${this.fetchRows} more rows`, 'Read the next block from the open cursor', () => void this.more());
    button('Copy', 'Copy the selected rows (or all) as an aligned text table, as it reads here', () => void this.copy('text'));
    button('Copy as Markdown', 'Copy the selected rows (or all) as a Markdown table', () => void this.copy('markdown'));
    button('Copy as TSV', 'Copy the selected rows (or all) tab separated, for a spreadsheet', () => void this.copy('tsv'));
    button('Save as CSV…', 'Write the selected rows (or all) to a .csv file', () => void this.saveCsv());
    this.grid.append(tools);
    this.renderStatus();
  }

  private renderStatus(): void {
    const sel = this.selected.size ? ` ${plural(this.selected.size, 'row')} selected.` : '';
    this.status.textContent = outcomeText(this.result, this.fetchMs) + sel;
  }

  /** Click selects a row, Shift+click a range from the last click, Ctrl+click adds or removes one. */
  private select(index: number, e: MouseEvent): void {
    if (e.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, index), Math.max(this.anchor, index)];
      if (!e.ctrlKey && !e.metaKey) this.selected.clear();
      for (let i = a; i <= b; i++) this.selected.add(i);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(index)) this.selected.delete(index);
      else this.selected.add(index);
      this.anchor = index;
    } else {
      const only = this.selected.size === 1 && this.selected.has(index);
      this.selected.clear();
      if (!only) this.selected.add(index);
      this.anchor = index;
    }
    this.grid.querySelectorAll('tbody tr').forEach((tr, i) => tr.classList.toggle('selected', this.selected.has(i)));
    this.renderStatus();
  }

  async more(): Promise<void> {
    const r = this.result;
    if (!r.more || !r.cursor) return;
    const next = await this.host.fetchMore(r.cursor, this.fetchRows);
    if (!next) return;
    r.rows = [...(r.rows ?? []), ...(next.rows ?? [])];
    r.more = next.more;
    r.cursor = next.cursor;
    this.fetchMs += next.elapsedMs;
    this.render();
  }

  text(kind: CopyKind): string {
    const cols = this.result.columns ?? [];
    const rows = this.rowsToCopy();
    return kind === 'text' ? alignedTable(cols, rows) : kind === 'markdown' ? markdownTable(cols, rows) : delimitedTable(cols, rows, '\t');
  }

  async copy(kind: CopyKind): Promise<void> {
    await goApp().ClipboardSet(this.text(kind));
    const n = this.rowsToCopy().length;
    this.host.notify(`Copied ${plural(n, 'row')}${kind === 'markdown' ? ' as Markdown' : kind === 'tsv' ? ' as TSV' : ''}`);
  }

  private async saveCsv(): Promise<void> {
    const csv = delimitedTable(this.result.columns ?? [], this.rowsToCopy(), ',');
    if (await goApp().SaveTextFile('Save result', `result-${this.n}.csv`, csv, [{ name: 'CSV', patterns: '*.csv' }])) this.host.notify('Result saved');
  }
}
