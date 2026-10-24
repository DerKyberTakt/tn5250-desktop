import { errorText, goApp, type SqlColumn, type SqlConnectRequest, type SqlResult } from './bridge';
import { confirmDialog } from './dialogs';
import { splitStatements, statementLabel, statementsFrom, statementsIn, type Statement } from './sqlScript';
import { explainToolError } from './toolErrors';

export interface SqlHost {
  notify(text: string): void;
  log(line: string): void;
  changed(tab: SqlTab): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const NUMERIC_TYPES = new Set(['SMALLINT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'REAL', 'DOUBLE', 'FLOAT', 'DECFLOAT']);
/** Rows asked for per fetch; ACS shows 500 and offers more. */
const FETCH_ROWS = 500;

/** An ACS-style Run SQL Scripts tab: editor on top, results and messages below. */
export class SqlTab {
  readonly frame: HTMLDivElement;
  title: string;
  private connection = '';
  private busy = false;
  private stopRequested = false;
  private filePath = '';
  private dirty = false;
  private result: SqlResult | undefined;
  private readonly editor: HTMLTextAreaElement;
  private readonly grid: HTMLDivElement;
  private readonly messages: HTMLUListElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly connEl: HTMLSpanElement;
  private readonly naming: HTMLSelectElement;
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  private readonly panes: Record<'results' | 'messages', { button: HTMLButtonElement; pane: HTMLElement }>;

  constructor(
    private readonly host: SqlHost,
    private readonly request: SqlConnectRequest,
    /** Told whether the first sign-on worked (error = why not). */
    private readonly onSignon?: (error?: unknown) => void,
  ) {
    this.title = `SQL - ${request.host}`;
    this.frame = el('div', 'terminal-frame sql');
    this.frame.tabIndex = -1;

    const top = el('div', 'sql-top');
    const btn = (key: string, text: string, title: string, run: () => void, primary = false): HTMLButtonElement => {
      const b = el('button', primary ? 'primary' : undefined, text);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', run);
      this.buttons[key] = b;
      return b;
    };
    const run = el('div', 'group');
    run.append(
      btn('runSel', '▶ Run', 'Run the selected statements, or the one at the cursor (Ctrl+R)', () => void this.runSelected(), true),
      btn('runAll', 'Run All', 'Run every statement (Ctrl+Shift+R)', () => void this.runAll()),
      btn('runFrom', 'Run From Cursor', 'Run from the statement at the cursor to the end (Ctrl+Alt+R)', () => void this.runFromCursor()),
      btn('stop', 'Stop', 'Stop after the current statement', () => {
        this.stopRequested = true;
        void goApp().SqlCancel(this.connection);
      }),
    );
    const file = el('div', 'group');
    file.append(
      btn('open', 'Open…', 'Open a .sql file', () => void this.open()),
      btn('save', 'Save', 'Save the script (Ctrl+S)', () => void this.save(false)),
      btn('saveAs', 'Save As…', 'Save the script under a new name', () => void this.save(true)),
    );
    this.naming = el('select');
    this.naming.title = 'Naming: SQL (schema.table) or system (library/file)';
    for (const [v, t] of [['sql', 'SQL naming'], ['sys', 'System naming']] as const) {
      const o = el('option', undefined, t);
      o.value = v;
      this.naming.append(o);
    }
    this.naming.value = request.naming || 'sql';
    this.naming.addEventListener('change', () => void this.reconnect());
    this.connEl = el('span', 'conn', `${request.user.toUpperCase()}@${request.host} · not connected`);
    top.append(run, el('span', 'sep'), file, el('span', 'sep'), this.naming, this.connEl);

    this.editor = el('textarea', 'sql-editor');
    this.editor.spellcheck = false;
    this.editor.placeholder = 'SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 50 ROWS ONLY;\nCL: DSPLIBL;';
    this.editor.addEventListener('input', () => {
      this.dirty = true;
      this.updateTitle();
    });
    this.editor.addEventListener('keydown', (e) => this.onEditorKey(e));

    const split = el('div', 'sql-split');
    split.title = 'Drag to resize';
    split.addEventListener('mousedown', (e) => this.startResize(e));

    const bottom = el('div', 'sql-bottom');
    const tabs = el('div', 'sql-tabs');
    this.grid = el('div', 'sql-pane');
    this.messages = el('ul', 'sql-messages');
    const messagesPane = el('div', 'sql-pane');
    messagesPane.append(this.messages);
    const tab = (label: string): HTMLButtonElement => {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      tabs.append(b);
      return b;
    };
    this.panes = {
      results: { button: tab('Results'), pane: this.grid },
      messages: { button: tab('Messages'), pane: messagesPane },
    };
    for (const key of ['results', 'messages'] as const) this.panes[key].button.addEventListener('click', () => this.showPane(key));
    bottom.append(tabs, this.grid, messagesPane);
    this.showPane('messages');

    const foot = el('div', 'sql-foot');
    this.statusEl = el('span', undefined, 'Ready');
    foot.append(this.statusEl);

    this.frame.append(top, this.editor, split, bottom, foot);
    this.updateButtons();
  }

  focus(): void {
    this.editor.focus();
  }

  /** Signs on; called when the tab opens so a bad password shows at once. */
  async start(): Promise<void> {
    await this.connect();
  }

  dispose(): void {
    if (this.connection) void goApp().SqlClose(this.connection);
    this.frame.remove();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Puts text into the editor (Open, or a statement handed over by another tool). */
  setScript(text: string, path = ''): void {
    this.editor.value = text;
    this.filePath = path;
    this.dirty = false;
    this.updateTitle();
  }

  // ---- connection --------------------------------------------------------------

  private async connect(): Promise<boolean> {
    if (this.connection) return true;
    this.setBusy(true, `Signing on to ${this.request.host}…`);
    try {
      this.connection = await goApp().SqlConnect({ ...this.request, naming: this.naming.value });
      this.connEl.textContent = `${this.request.user.toUpperCase()}@${this.request.host} · ${this.naming.value === 'sys' ? 'system' : 'SQL'} naming`;
      this.host.log(`[SQL ${this.request.host}] signed on as ${this.request.user.toUpperCase()}`);
      this.onSignon?.();
      return true;
    } catch (err) {
      const why = explainToolError('SQL', this.request.host, errorText(err));
      this.addMessage('error', `Could not connect: ${why.message}${why.hint ? ` ${why.hint}` : ''}`);
      this.showPane('messages');
      this.onSignon?.(err);
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  private async reconnect(): Promise<void> {
    if (this.connection) {
      void goApp().SqlClose(this.connection);
      this.connection = '';
    }
    await this.connect();
  }

  // ---- running -------------------------------------------------------------------

  private statements(): Statement[] {
    return splitStatements(this.editor.value);
  }

  async runSelected(): Promise<void> {
    const src = this.editor.value;
    await this.runList(statementsIn(this.statements(), this.editor.selectionStart, this.editor.selectionEnd, src));
  }

  async runAll(): Promise<void> {
    await this.runList(this.statements());
  }

  async runFromCursor(): Promise<void> {
    await this.runList(statementsFrom(this.statements(), this.editor.selectionStart, this.editor.value));
  }

  private async runList(list: Statement[]): Promise<void> {
    if (this.busy) return;
    if (!list.length) {
      this.host.notify('Nothing to run: put the cursor in a statement or select some');
      return;
    }
    if (!(await this.connect())) return;
    this.stopRequested = false;
    this.setBusy(true);
    let ok = 0;
    try {
      for (const [i, s] of list.entries()) {
        if (this.stopRequested) {
          this.addMessage('ok', `Stopped before statement ${i + 1} of ${list.length}.`);
          break;
        }
        this.statusEl.textContent = `Running ${i + 1} of ${list.length}: ${statementLabel(s)}`;
        let r: SqlResult;
        try {
          r = s.kind === 'cl' ? await goApp().CmdRun(this.connection, s.text) : await goApp().SqlRun(this.connection, s.text, FETCH_ROWS);
        } catch (err) {
          const why = explainToolError(s.kind === 'cl' ? 'CL' : 'SQL', this.request.host, errorText(err));
          this.addMessage('error', `[line ${s.line}] ${statementLabel(s)}\n${why.message}${why.hint ? `\n${why.hint}` : ''}`);
          this.showPane('messages');
          if (!(await confirmDialog('Statement failed', 'Continue with the next statement?', 'Continue'))) break;
          continue;
        }
        this.report(s, r);
        if (r.kind === 'error') {
          this.showPane('messages');
          if (i < list.length - 1 && !(await confirmDialog('Statement failed', 'Continue with the next statement?', 'Continue'))) break;
          continue;
        }
        ok++;
        if (r.kind === 'rows') {
          this.result = r;
          this.renderGrid();
          this.showPane('results');
        }
      }
    } finally {
      this.setBusy(false);
      this.statusEl.textContent = `${ok} of ${list.length} statement${list.length === 1 ? '' : 's'} ran`;
    }
  }

  private report(s: Statement, r: SqlResult): void {
    const where = `[line ${s.line}] ${statementLabel(s)}`;
    const ms = `${r.elapsedMs} ms`;
    if (r.kind === 'error') {
      const m = r.messages[0];
      this.addMessage('error', `${where}\n${m ? `${m.id}${m.code ? ` (SQLCODE ${m.code})` : ''}: ${m.text}` : 'failed'} · ${ms}`);
      return;
    }
    const extra = r.messages.filter((m) => m.text).map((m) => `\n${m.id}: ${m.text}`).join('');
    if (r.kind === 'rows') this.addMessage('ok', `${where}\n${r.rows?.length ?? 0}${r.more ? '+' : ''} row(s) · ${ms}${extra}`);
    else if (r.kind === 'count') this.addMessage('ok', `${where}\n${r.updateCount} row(s) affected · ${ms}${extra}`);
    else this.addMessage('ok', `${where}\nOK · ${ms}${extra}`);
  }

  private async fetchMore(): Promise<void> {
    const r = this.result;
    if (!r?.more || !r.cursor || this.busy) return;
    this.setBusy(true, 'Fetching more rows…');
    try {
      const next = await goApp().SqlFetch(this.connection, r.cursor, FETCH_ROWS);
      r.rows = [...(r.rows ?? []), ...(next.rows ?? [])];
      r.more = next.more;
      r.cursor = next.cursor;
      this.renderGrid();
    } catch (err) {
      this.addMessage('error', `Fetch failed: ${errorText(err)}`);
      this.showPane('messages');
    } finally {
      this.setBusy(false);
    }
  }

  // ---- results --------------------------------------------------------------------

  private renderGrid(): void {
    const r = this.result;
    this.grid.replaceChildren();
    if (!r?.columns) return;
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
    const numeric = r.columns.map((c) => NUMERIC_TYPES.has(c.type.toUpperCase()));
    for (const row of r.rows ?? []) {
      const tr = el('tr');
      row.forEach((v, i) => {
        const td = el('td', v === null ? 'null' : numeric[i] ? 'num' : undefined, v === null ? 'NULL' : v);
        tr.append(td);
      });
      body.append(tr);
    }
    table.append(head, body);
    this.grid.append(table);
    const tools = el('div', 'sql-more');
    if (r.more) {
      const more = el('button', undefined, `Fetch ${FETCH_ROWS} more rows`);
      more.type = 'button';
      more.addEventListener('click', () => void this.fetchMore());
      tools.append(more, ' ');
    }
    const copy = el('button', undefined, 'Copy as text');
    copy.type = 'button';
    copy.title = 'Copy the result (tab separated) to the clipboard';
    copy.addEventListener('click', () => void goApp().ClipboardSet(this.resultAsText('\t')).then(() => this.host.notify('Result copied')));
    const csv = el('button', undefined, 'Save as CSV…');
    csv.type = 'button';
    csv.addEventListener('click', () => void goApp().SaveTextFile('Save result', 'result.csv', this.resultAsText(','), [{ name: 'CSV', patterns: '*.csv' }]));
    tools.append(copy, ' ', csv);
    this.grid.append(tools);
  }

  private resultAsText(sep: string): string {
    const r = this.result;
    if (!r?.columns) return '';
    const cell = (v: string | null): string => {
      const s = v ?? '';
      return sep === ',' && /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [r.columns.map((c) => cell(c.label || c.name)).join(sep)];
    for (const row of r.rows ?? []) lines.push(row.map(cell).join(sep));
    return lines.join('\r\n') + '\r\n';
  }

  private addMessage(kind: 'ok' | 'error', text: string): void {
    const li = el('li', kind);
    const stamp = new Date().toLocaleTimeString();
    li.append(el('span', 'where', `${stamp}  `), document.createTextNode(text));
    this.messages.append(li);
    li.scrollIntoView({ block: 'nearest' });
  }

  private showPane(key: 'results' | 'messages'): void {
    for (const [k, p] of Object.entries(this.panes)) {
      p.pane.hidden = k !== key;
      p.button.setAttribute('aria-selected', String(k === key));
    }
  }

  // ---- files ------------------------------------------------------------------------

  private async open(): Promise<void> {
    if (this.dirty && !(await confirmDialog('Open script', 'Discard the unsaved changes in this editor?', 'Discard'))) return;
    const path = await goApp().PickFile('Open SQL script', [{ name: 'SQL scripts', patterns: '*.sql' }, { name: 'All files', patterns: '*.*' }]);
    if (!path) return;
    try {
      this.setScript(await goApp().ReadTextFile(path), path);
    } catch (err) {
      this.host.notify(`Could not open ${path}: ${errorText(err)}`);
    }
  }

  private async save(as: boolean): Promise<void> {
    const name = this.filePath ? this.filePath.split(/[\\/]/).pop() ?? 'script.sql' : 'script.sql';
    const saved = await goApp().SaveTextFile('Save SQL script', as ? name : this.filePath || name, this.editor.value, [{ name: 'SQL scripts', patterns: '*.sql' }]);
    if (saved) {
      this.dirty = false;
      this.updateTitle();
      this.host.notify('Script saved');
    }
  }

  // ---- misc ------------------------------------------------------------------------

  private onEditorKey(e: KeyboardEvent): void {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      void this.runSelected();
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      void this.runAll();
    } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      void this.runFromCursor();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save(false);
    } else if (e.key === 'Tab') {
      // Tab types spaces instead of leaving the editor.
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = this.editor;
      this.editor.value = `${value.slice(0, a)}    ${value.slice(b)}`;
      this.editor.selectionStart = this.editor.selectionEnd = a + 4;
      this.dirty = true;
    }
  }

  private startResize(e: MouseEvent): void {
    e.preventDefault();
    const startY = e.clientY;
    const startH = this.editor.getBoundingClientRect().height;
    const move = (ev: MouseEvent): void => {
      const h = Math.max(60, startH + ev.clientY - startY);
      this.editor.style.flex = `0 0 ${h}px`;
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private setBusy(b: boolean, status?: string): void {
    this.busy = b;
    this.frame.classList.toggle('busy', b);
    if (status) this.statusEl.textContent = status;
    this.updateButtons();
  }

  private updateButtons(): void {
    for (const key of ['runSel', 'runAll', 'runFrom', 'open']) this.buttons[key]!.disabled = this.busy;
    this.buttons.stop!.disabled = !this.busy;
  }

  private updateTitle(): void {
    const name = this.filePath ? this.filePath.split(/[\\/]/).pop() : '';
    const next = `SQL - ${name || this.request.host}${this.dirty ? ' *' : ''}`;
    if (next !== this.title) {
      this.title = next;
      this.host.changed(this);
    }
  }
}

function typeLabel(c: SqlColumn): string {
  const t = c.type.toUpperCase();
  if (NUMERIC_TYPES.has(t) && (t === 'DECIMAL' || t === 'NUMERIC')) return `${t}(${c.length},${c.scale})`;
  if (['CHAR', 'VARCHAR', 'GRAPHIC', 'VARGRAPHIC', 'BINARY', 'VARBINARY'].includes(t)) return `${t}(${c.length})`;
  return t;
}
