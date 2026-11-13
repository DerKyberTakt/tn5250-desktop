import { errorText, goApp, type SqlConnInfo, type SqlConnectRequest, type SqlResult } from './bridge';
import { confirmDialog } from './dialogs';
import { SqlEditor, highlightedSql } from './sqlEditor';
import { ResultView, type ResultHost } from './sqlResult';
import { splitStatements, statementLabel, statementsFrom, statementsIn, type Statement } from './sqlScript';
import { isOutputLines, outcomeText } from './sqlText';
import { explainToolError } from './toolErrors';

export { outcomeText } from './sqlText';

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

/** Rows asked for per fetch; ACS shows 500 and offers more. */
const FETCH_ROWS = 500;
const NOTHING_YET = 'No statement has run yet.';

/** One statement's entry in the Output pane: its text, then what became of it. */
interface OutputEntry {
  box: HTMLDivElement;
  line: HTMLDivElement;
}

/**
 * An ACS-style Run SQL Scripts tab: the editor on top; below it one Output pane that
 * tells the whole story in order (each statement as run, its outcome, its messages,
 * the lines a CL command printed) and a numbered Result tab for every statement that
 * returned rows.
 */
export class SqlTab {
  readonly frame: HTMLDivElement;
  title: string;
  private connection = '';
  private busy = false;
  private stopRequested = false;
  private filePath = '';
  private dirty = false;
  private readonly editor: SqlEditor;
  private readonly tabs: HTMLDivElement;
  private readonly outputButton: HTMLButtonElement;
  private readonly outputPane: HTMLDivElement;
  private readonly output: HTMLDivElement;
  private readonly bottom: HTMLDivElement;
  private results: ResultView[] = [];
  private resultSeq = 0;
  private readonly statusEl: HTMLSpanElement;
  /** Right side of the foot: the server job and the transport. */
  private readonly jobEl: HTMLSpanElement;
  private readonly connEl: HTMLSpanElement;
  private runStart = 0;
  private runLabel = '';
  private running: OutputEntry | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly naming: HTMLSelectElement;
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  /** Shown while the session runs on the CL fallback instead of the database server. */
  private readonly notice: HTMLElement;

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
      btn('runSel', '▶ Run', 'Run the selected statements in order, or the one at the cursor (Ctrl+R)', () => void this.runSelected(), true),
      btn('runAll', 'Run All', 'Run every statement (Ctrl+Shift+R)', () => void this.runAll()),
      btn('runFrom', 'Run From Cursor', 'Run from the statement at the cursor to the end (Ctrl+Alt+R)', () => void this.runFromCursor()),
      btn('stop', 'Stop', 'Cancel the current statement and stop', () => {
        this.stopRequested = true;
        void goApp().SqlCancel(this.connection);
        if (this.busy) this.tick();
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
    this.notice = el('div', 'sql-notice');
    this.notice.setAttribute('role', 'status');
    this.notice.hidden = true;

    this.editor = new SqlEditor({
      placeholder: 'SELECT * FROM QSYS2.SYSTABLES FETCH FIRST 50 ROWS ONLY;\nCL: DSPLIBL OUTPUT(*PRINT);\nQSH: ls -l /home',
      onChange: () => {
        this.dirty = true;
        this.updateTitle();
      },
      keys: {
        run: () => void this.runSelected(),
        runAll: () => void this.runAll(),
        runFrom: () => void this.runFromCursor(),
        save: () => void this.save(false),
      },
    });

    const split = el('div', 'sql-split');
    split.title = 'Drag to resize';
    split.addEventListener('mousedown', (e) => this.startResize(e));

    this.bottom = el('div', 'sql-bottom');
    this.tabs = el('div', 'sql-tabs');
    this.outputButton = el('button', undefined, 'Output');
    this.outputButton.type = 'button';
    this.outputButton.setAttribute('role', 'tab');
    this.outputButton.title = 'Every statement as it ran, its outcome and its messages';
    this.outputButton.addEventListener('click', () => this.showOutput());
    const clear = el('button', 'sql-tabs-clear', 'Clear');
    clear.type = 'button';
    clear.title = 'Empty the Output pane and close every Result tab';
    clear.addEventListener('click', () => this.clearAll());
    this.tabs.append(this.outputButton, clear);
    this.outputPane = el('div', 'sql-pane sql-output-pane');
    this.output = el('div', 'sql-output');
    this.output.append(el('div', 'sql-out-head', NOTHING_YET));
    this.outputPane.append(this.output);
    this.bottom.append(this.tabs, this.outputPane);
    this.showOutput();

    const foot = el('div', 'sql-foot');
    this.statusEl = el('span', undefined, 'Ready');
    this.jobEl = el('span', 'sql-job');
    this.jobEl.title = 'The server job this session runs in';
    foot.append(this.statusEl, this.jobEl);

    this.frame.append(top, this.notice, this.editor.element, split, this.bottom, foot);
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
    this.endStatement();
    this.editor.destroy();
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
      await this.showTransport();
      this.statusEl.textContent = 'Ready';
      this.onSignon?.();
      return true;
    } catch (err) {
      const why = explainToolError('SQL', this.request.host, errorText(err));
      this.outputLine('error', `Could not connect: ${why.message}${why.hint ? ` ${why.hint}` : ''}`);
      this.showOutput();
      this.onSignon?.(err);
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  /** Tells the user which path the session took: the database server, or the fallback and why. */
  private async showTransport(): Promise<void> {
    let info: SqlConnInfo;
    try {
      info = await goApp().SqlInfo(this.connection);
    } catch {
      return;
    }
    if (info.transport === 'database') {
      this.notice.hidden = true;
      this.notice.textContent = '';
      const job = info.job ? ` · job ${info.job}` : '';
      this.connEl.textContent += ` · database server${info.release ? ` ${info.release}` : ''}`;
      this.jobEl.textContent = `${info.job ? `${info.job} · ` : ''}database server${info.release ? ` ${info.release}` : ''}`;
      this.host.log(`[SQL ${this.request.host}] database host server${info.release ? ` ${info.release}` : ''}${job}`);
      for (const w of info.warnings ?? []) this.outputLine('info', `${w.id ? `${w.id}: ` : ''}${w.text}`);
      return;
    }
    const why = info.reason ? ` (${info.reason})` : '';
    this.notice.textContent = `The database host server could not be reached${why}. Running on the CL fallback: statements go through RUNSQL and CPYTOIMPF, so they are slower and column types are not available. Start it on the host with STRHOSTSVR SERVER(*DATABASE).`;
    this.notice.hidden = false;
    this.connEl.textContent += ' · CL fallback';
    this.jobEl.textContent = 'CL fallback';
    this.host.log(`[SQL ${this.request.host}] database host server unavailable${why}; using the CL fallback`);
    this.outputLine('error', `Database host server unavailable${why}. Using the CL fallback (slower, untyped columns).`);
  }

  private async reconnect(): Promise<void> {
    if (this.connection) {
      void goApp().SqlClose(this.connection);
      this.connection = '';
      this.jobEl.textContent = '';
    }
    await this.connect();
  }

  // ---- running -------------------------------------------------------------------

  private statements(): Statement[] {
    return splitStatements(this.editor.value);
  }

  /** The statement at the cursor, or every statement the selection touches, in order. */
  async runSelected(): Promise<void> {
    const { start, end } = this.editor.selection();
    await this.runList(statementsIn(this.statements(), start, end, this.editor.value), start === end ? 'Run' : 'Run Selected');
  }

  async runAll(): Promise<void> {
    await this.runList(this.statements(), 'Run All');
  }

  async runFromCursor(): Promise<void> {
    await this.runList(statementsFrom(this.statements(), this.editor.selection().start, this.editor.value), 'Run From Cursor');
  }

  private async runList(list: Statement[], label: string): Promise<void> {
    if (this.busy) return;
    if (!list.length) {
      this.host.notify('Nothing to run: put the cursor in a statement or select some');
      return;
    }
    if (!(await this.connect())) return;
    this.stopRequested = false;
    this.setBusy(true);
    this.outputHead(`${label}…${list.length > 1 ? ` (${list.length} statements)` : ''}`);
    let ok = 0;
    let failed = false;
    let last: ResultView | undefined;
    try {
      for (const [i, s] of list.entries()) {
        if (this.stopRequested) {
          this.outputLine('info', `Stopped before statement ${i + 1} of ${list.length}.`);
          break;
        }
        const entry = this.beginStatement(i + 1, list.length, s);
        let r: SqlResult;
        try {
          r =
            s.kind === 'cl'
              ? await goApp().CmdRun(this.connection, s.text)
              : s.kind === 'qsh'
                ? await goApp().QshRun(this.connection, s.text)
                : await goApp().SqlRun(this.connection, s.text, FETCH_ROWS);
        } catch (err) {
          const why = explainToolError(s.kind === 'cl' ? 'CL' : s.kind === 'qsh' ? 'QSH' : 'SQL', this.request.host, errorText(err));
          this.endStatement();
          this.setOutcome(entry, 'error', `Failed: ${why.message}${why.hint ? ` ${why.hint}` : ''}`);
          failed = true;
          if (i < list.length - 1 && !(await confirmDialog('Statement failed', 'Continue with the next statement?', 'Continue'))) break;
          continue;
        }
        this.endStatement();
        last = this.report(entry, s, r) ?? last;
        if (r.kind === 'error') {
          failed = true;
          if (i < list.length - 1 && !(await confirmDialog('Statement failed', 'Continue with the next statement?', 'Continue'))) break;
          continue;
        }
        ok++;
      }
    } finally {
      this.endStatement();
      this.editor.clearRunning();
      this.setBusy(false);
      this.statusEl.textContent = `${ok} of ${list.length} statement${list.length === 1 ? '' : 's'} ran`;
      // ACS brings the newest result to the front; a failure anywhere keeps the story on show.
      if (!failed && last) this.showResult(last);
      else this.showOutput();
    }
  }

  /** A statement is on its way: selected and tinted in the editor, logged in Output, the foot counting the seconds. */
  private beginStatement(n: number, total: number, s: Statement): OutputEntry {
    this.editor.showRunning(s.start, s.end);
    const entry = this.outputEntry(s);
    this.running = entry;
    this.runLabel = `${n} of ${total}: ${statementLabel(s)}`;
    this.runStart = Date.now();
    this.tick();
    if (this.ticker === undefined) this.ticker = setInterval(() => this.tick(), 1000);
    return entry;
  }

  private tick(): void {
    const secs = Math.floor((Date.now() - this.runStart) / 1000);
    const t = secs >= 2 ? ` (${secs} s)` : '';
    this.statusEl.textContent = `${this.stopRequested ? 'Stopping after' : 'Running'} ${this.runLabel}${t}`;
    if (this.running) this.running.line.textContent = `Running…${t}`;
  }

  private endStatement(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.running = undefined;
  }

  /** Writes the outcome under the statement; rows become a Result tab, printed lines stay inline. */
  private report(entry: OutputEntry, s: Statement, r: SqlResult): ResultView | undefined {
    const extra = r.messages.filter((m) => m.text);
    const addMessages = (list: typeof extra): void => {
      for (const m of list) entry.box.append(el('div', 'sql-out-msg', `${m.id ? `${m.id}: ` : ''}${m.text}`));
    };
    if (r.kind === 'error') {
      this.setOutcome(entry, 'error', outcomeText(r, 0));
      addMessages(extra.slice(1));
      return undefined;
    }
    this.setOutcome(entry, 'ok', outcomeText(r, 0));
    if (r.kind === 'rows' && isOutputLines(r)) {
      addMessages(extra);
      entry.box.append(el('pre', 'sql-out-lines', (r.rows ?? []).map((row) => row[0] ?? '').join('\n')));
      return undefined;
    }
    if (r.kind === 'rows') {
      const view = this.addResult(statementLabel(s), r);
      const link = el('button', 'sql-out-link', `Result ${view.n}`);
      link.type = 'button';
      link.title = 'Show the rows';
      link.addEventListener('click', () => this.showResult(view));
      entry.line.append(' ', link);
      addMessages(extra);
      return view;
    }
    addMessages(extra);
    return undefined;
  }

  // ---- Output pane -----------------------------------------------------------------

  private freshOutput(): void {
    if (this.output.childElementCount === 1 && this.output.firstElementChild?.textContent === NOTHING_YET) this.output.replaceChildren();
  }

  /** A run header carries the time and what was asked, as ACS's message pane does. */
  private outputHead(text: string): void {
    this.freshOutput();
    const head = el('div', 'sql-out-head', `[ ${new Date().toLocaleString()} ]  ${text}`);
    this.output.append(head);
    head.scrollIntoView({ block: 'nearest' });
  }

  private outputLine(kind: 'ok' | 'error' | 'info', text: string): void {
    this.freshOutput();
    const line = el('div', `sql-out-line ${kind}`, `${kind === 'error' ? '✗ ' : kind === 'ok' ? '✓ ' : ''}${text}`);
    this.output.append(line);
    line.scrollIntoView({ block: 'nearest' });
  }

  private outputEntry(s: Statement): OutputEntry {
    const box = el('div', 'sql-out-entry');
    const stmt = el('pre', 'sql-out-stmt');
    if (s.kind === 'sql') stmt.append(highlightedSql(s.text));
    else stmt.append(el('span', 'sq-cmd', s.kind === 'cl' ? 'CL: ' : 'QSH: '), s.text);
    const line = el('div', 'sql-out-line running', 'Running…');
    box.append(stmt, line);
    this.output.append(box);
    box.scrollIntoView({ block: 'nearest' });
    return { box, line };
  }

  private setOutcome(entry: OutputEntry, kind: 'ok' | 'error', text: string): void {
    entry.line.className = `sql-out-line ${kind}`;
    entry.line.textContent = `${kind === 'ok' ? '✓' : '✗'} ${text}`;
    entry.box.scrollIntoView({ block: 'nearest' });
  }

  // ---- Result tabs -----------------------------------------------------------------

  private readonly resultHost: ResultHost = {
    fetchMore: async (cursor, max) => {
      if (this.busy) return undefined;
      this.setBusy(true, 'Fetching more rows…');
      try {
        return await goApp().SqlFetch(this.connection, cursor, max);
      } catch (err) {
        this.outputLine('error', `Fetch failed: ${errorText(err)}`);
        return undefined;
      } finally {
        this.setBusy(false);
        this.statusEl.textContent = 'Ready';
      }
    },
    notify: (text) => this.host.notify(text),
    activate: (view) => this.showResult(view),
    close: (view) => this.closeResult(view),
  };

  private addResult(label: string, r: SqlResult): ResultView {
    const view = new ResultView(++this.resultSeq, label, r, this.resultHost, FETCH_ROWS);
    this.results.push(view);
    this.tabs.insertBefore(view.button, this.tabs.lastElementChild);
    this.bottom.append(view.pane);
    return view;
  }

  private closeResult(view: ResultView): void {
    const shown = !view.pane.hidden;
    this.results = this.results.filter((v) => v !== view);
    view.button.remove();
    view.pane.remove();
    if (shown) this.showOutput();
  }

  private clearAll(): void {
    for (const v of [...this.results]) this.closeResult(v);
    this.resultSeq = 0;
    this.output.replaceChildren(el('div', 'sql-out-head', NOTHING_YET));
    this.showOutput();
  }

  private showOutput(): void {
    this.outputPane.hidden = false;
    this.outputButton.setAttribute('aria-selected', 'true');
    for (const v of this.results) {
      v.pane.hidden = true;
      v.button.setAttribute('aria-selected', 'false');
    }
  }

  private showResult(view: ResultView): void {
    this.outputPane.hidden = true;
    this.outputButton.setAttribute('aria-selected', 'false');
    for (const v of this.results) {
      v.pane.hidden = v !== view;
      v.button.setAttribute('aria-selected', String(v === view));
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

  private startResize(e: MouseEvent): void {
    e.preventDefault();
    const startY = e.clientY;
    const startH = this.editor.element.getBoundingClientRect().height;
    const move = (ev: MouseEvent): void => {
      const h = Math.max(60, startH + ev.clientY - startY);
      this.editor.element.style.flex = `0 0 ${h}px`;
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
