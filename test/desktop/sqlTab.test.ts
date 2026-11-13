// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlResult } from '../../src/desktop/bridge';
import { SqlTab, outcomeText } from '../../src/desktop/sqlTab';

/** A fake database host server behind window.go: answers by the first word of the statement. */
function fakeHost() {
  let pending: ((r: SqlResult) => void) | undefined;
  const rows = (n: number, from = 1): (string | null)[][] => Array.from({ length: n }, (_, i) => [String(from + i), i % 2 ? null : `name ${from + i}`]);
  const columns = [
    { name: 'ID', type: 'INTEGER', length: 10, scale: 0, nullable: false },
    { name: 'NAME', type: 'VARCHAR', length: 20, scale: 0, nullable: true },
  ];
  const answer = (stmt: string): SqlResult => {
    const word = stmt.trim().split(/\s+/)[0]!.toUpperCase();
    switch (word) {
      case 'SELECT':
        return { kind: 'rows', columns, rows: rows(2), more: true, cursor: 'db', updateCount: 0, messages: [], elapsedMs: 12 };
      case 'DELETE':
        return { kind: 'count', more: false, updateCount: 3, messages: [], elapsedMs: 24 };
      case 'CREATE':
        return { kind: 'none', more: false, updateCount: 0, messages: [], elapsedMs: 7 };
      default:
        return { kind: 'error', more: false, updateCount: 0, messages: [{ id: '42704', code: -204, severity: 0, text: 'NOPE in QGPL type *FILE not found.' }], elapsedMs: 5 };
    }
  };
  const app = {
    SqlConnect: vi.fn(async () => 'S1'),
    SqlClose: vi.fn(async () => undefined),
    SqlCancel: vi.fn(async () => undefined),
    SqlInfo: vi.fn(async () => ({ transport: 'database', release: 'V7R5M0', job: '726603/QUSER/QZDASOINIT', ccsid: 37, warnings: [] })),
    SqlRun: vi.fn((_id: string, stmt: string) => {
      if (stmt.startsWith('WAIT')) return new Promise<SqlResult>((resolve) => (pending = resolve));
      return Promise.resolve(answer(stmt));
    }),
    SqlFetch: vi.fn(async (): Promise<SqlResult> => ({ kind: 'rows', columns, rows: rows(3, 3), more: false, updateCount: 0, messages: [], elapsedMs: 8 })),
    CmdRun: vi.fn(async (): Promise<SqlResult> => ({ kind: 'rows', columns: [{ name: 'OUTPUT', type: 'VARCHAR', length: 378, scale: 0, nullable: false }], rows: [['QSYS'], ['QGPL']], more: false, updateCount: 0, messages: [{ id: '', code: 0, severity: 0, text: 'Output: spooled file QPDSPLIB, 2 lines.' }], elapsedMs: 30 })),
    ClipboardSet: vi.fn(async () => undefined),
    SaveTextFile: vi.fn(async () => true),
  };
  window.go = { main: { App: app as never } };
  window.runtime = { EventsOn: () => () => undefined } as never;
  // jsdom has no layout: the Output pane scrolls its newest line into view, and
  // CodeMirror measures text ranges.
  Element.prototype.scrollIntoView = () => undefined;
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as never;
  Range.prototype.getBoundingClientRect = () => rect as never;
  return { app, finish: (r: SqlResult) => pending?.(r) };
}

const host = { notify: vi.fn(), log: vi.fn(), changed: vi.fn() };
const request = { host: 'pub400.com', tls: false, trustAnyCertificate: false, user: 'jsmith', password: 'x', timeoutMs: 1000, naming: 'sql', defaultSchema: '' };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function openTab(): Promise<SqlTab> {
  const tab = new SqlTab(host, request);
  document.body.append(tab.frame);
  await tab.start();
  return tab;
}

/** The status line of the pane on show (a result tab). */
const status = (tab: SqlTab): string => tab.frame.querySelector('.sql-pane:not([hidden]) .sql-results-status')?.textContent ?? '';
const foot = (tab: SqlTab): string => tab.frame.querySelector('.sql-foot span')!.textContent ?? '';
const job = (tab: SqlTab): string => tab.frame.querySelector('.sql-job')!.textContent ?? '';
const selectedPane = (tab: SqlTab): string => tab.frame.querySelector('.sql-tabs button[aria-selected="true"]')!.firstChild?.textContent ?? '';
const resultTabs = (tab: SqlTab): string[] => [...tab.frame.querySelectorAll('.sql-tabs button[role="tab"]')].map((b) => b.firstChild?.textContent ?? '').filter((t) => t.startsWith('Result'));
const gridRows = (tab: SqlTab): number => tab.frame.querySelectorAll('.sql-pane:not([hidden]) .sql-grid tbody tr').length;
const outputLines = (tab: SqlTab): string[] => [...tab.frame.querySelectorAll('.sql-output .sql-out-line')].map((e) => e.textContent ?? '');
const lastLine = (tab: SqlTab): string => outputLines(tab).at(-1) ?? '';

describe('Run SQL Scripts: one Output pane and numbered Result tabs', () => {
  let fake: ReturnType<typeof fakeHost>;
  beforeEach(() => {
    document.body.replaceChildren();
    fake = fakeHost();
  });
  afterEach(() => vi.useRealTimers());

  it('shows the server job in the foot after sign-on', async () => {
    const tab = await openTab();
    expect(job(tab)).toBe('726603/QUSER/QZDASOINIT · database server V7R5M0');
    expect(foot(tab)).toBe('Ready');
    expect(selectedPane(tab)).toBe('Output');
  });

  it('a SELECT opens Result 1 with the rows and reports it in Output', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    expect(resultTabs(tab)).toEqual(['Result 1']);
    expect(selectedPane(tab)).toBe('Result 1');
    expect(gridRows(tab)).toBe(2);
    expect(status(tab)).toBe('Loaded 2 rows in 12 ms. More rows available.');
    expect(foot(tab)).toBe('1 of 1 statement ran');
    expect(lastLine(tab)).toBe('✓ Loaded 2 rows in 12 ms. More rows available. Result 1');
    // The statement is echoed with its keywords coloured.
    expect(tab.frame.querySelector('.sql-out-stmt .sq-kw')?.textContent).toBe('SELECT');
    expect(tab.frame.querySelector('.sql-out-head')?.textContent).toMatch(/] {2}Run All…$/);
  });

  it('Fetch more adds the rows and the time, then says End of data', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    (tab.frame.querySelector('.sql-pane:not([hidden]) .sql-more button') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(gridRows(tab)).toBe(5);
    expect(status(tab)).toBe('Loaded 5 rows in 12 ms + 8 ms. End of data.');
    expect(tab.frame.querySelector('.sql-pane:not([hidden]) .sql-more button')!.textContent).not.toMatch(/more rows/);
  });

  it('a DELETE stays in Output with the rows affected and opens no result', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    tab.setScript('DELETE FROM MYLIB.T WHERE ID = 1;');
    await tab.runAll();
    expect(resultTabs(tab)).toEqual(['Result 1']);
    expect(selectedPane(tab)).toBe('Output');
    expect(lastLine(tab)).toBe('✓ 3 rows affected in 24 ms.');
  });

  it('a statement without rows or a count says it ran', async () => {
    const tab = await openTab();
    tab.setScript('CREATE TABLE QTEMP.T (A INT);');
    await tab.runAll();
    expect(lastLine(tab)).toBe('✓ Statement ran in 7 ms.');
  });

  it('an SQL error is reported in Output, which stays on show', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    tab.setScript('DROP TABLE QGPL.NOPE;');
    await tab.runAll();
    expect(selectedPane(tab)).toBe('Output');
    expect(lastLine(tab)).toBe('✗ 42704 (SQLCODE -204): NOPE in QGPL type *FILE not found. · 5 ms');
    expect(foot(tab)).toBe('0 of 1 statement ran');
  });

  it('CL output lines stay inline in Output', async () => {
    const tab = await openTab();
    tab.setScript('CL: DSPLIBL;');
    await tab.runAll();
    expect(resultTabs(tab)).toEqual([]);
    expect(lastLine(tab)).toBe('✓ Output: 2 lines in 30 ms.');
    expect(tab.frame.querySelector('.sql-out-lines')?.textContent).toBe('QSYS\nQGPL');
    expect(tab.frame.querySelector('.sql-out-msg')?.textContent).toBe('Output: spooled file QPDSPLIB, 2 lines.');
    expect(tab.frame.querySelector('.sql-out-stmt .sq-cmd')?.textContent).toBe('CL: ');
    expect(tab.frame.querySelector('.sql-out-stmt .sq-kw')?.textContent).toBe('DSPLIBL'); // the CL mode colours the echo
    // The editor colours the CL line the same way.
    expect([...tab.frame.querySelectorAll('.cm-cl-line .sq-kw')].map((e) => e.textContent)).toEqual(['DSPLIBL']);
  });

  it('several statements run in order, each SELECT gets its own tab, the newest comes to the front', async () => {
    const tab = await openTab();
    tab.setScript('SELECT 1 FROM A;\nDELETE FROM B;\nSELECT 2 FROM C;');
    await tab.runAll();
    expect(resultTabs(tab)).toEqual(['Result 1', 'Result 2']);
    expect(selectedPane(tab)).toBe('Result 2');
    expect(tab.frame.querySelector('.sql-out-head')?.textContent).toMatch(/Run All… \(3 statements\)$/);
    expect(outputLines(tab)).toEqual(['✓ Loaded 2 rows in 12 ms. More rows available. Result 1', '✓ 3 rows affected in 24 ms.', '✓ Loaded 2 rows in 12 ms. More rows available. Result 2']);
    expect(foot(tab)).toBe('3 of 3 statements ran');
    // Closing the tab on show returns to Output; Clear empties everything.
    (tab.frame.querySelector('.sql-tabs button[aria-selected="true"] .close') as HTMLElement).click();
    expect(resultTabs(tab)).toEqual(['Result 1']);
    expect(selectedPane(tab)).toBe('Output');
    (tab.frame.querySelector('.sql-tabs-clear') as HTMLButtonElement).click();
    expect(resultTabs(tab)).toEqual([]);
    expect(tab.frame.querySelector('.sql-out-head')?.textContent).toBe('No statement has run yet.');
  });

  it('Run with the cursor in a statement runs just that one, selected in the editor', async () => {
    const tab = await openTab();
    tab.setScript('SELECT 1 FROM A;\nDELETE FROM B;');
    tab['editor'].setCursor(20);
    await tab.runSelected();
    expect(outputLines(tab)).toEqual(['✓ 3 rows affected in 24 ms.']);
    expect(tab.frame.querySelector('.sql-out-head')?.textContent).toMatch(/Run…$/);
    expect(tab['editor'].selection()).toEqual({ start: 17, end: 30 });
  });

  it('copies the rows as an aligned table, Markdown or TSV', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    const buttons = [...tab.frame.querySelectorAll('.sql-pane:not([hidden]) .sql-more button')] as HTMLButtonElement[];
    const by = (text: string): HTMLButtonElement => buttons.find((b) => b.textContent === text)!;
    by('Copy').click();
    await tick();
    expect(fake.app.ClipboardSet).toHaveBeenLastCalledWith('ID  NAME\r\n--  ------\r\n 1  name 1\r\n 2  -\r\n');
    by('Copy as Markdown').click();
    await tick();
    expect(fake.app.ClipboardSet).toHaveBeenLastCalledWith('| ID | NAME |\r\n| ---: | --- |\r\n| 1 | name 1 |\r\n| 2 |  |\r\n');
    by('Copy as TSV').click();
    await tick();
    expect(fake.app.ClipboardSet).toHaveBeenLastCalledWith('ID\tNAME\r\n1\tname 1\r\n2\t\r\n');
    // A selected row narrows the copy.
    (tab.frame.querySelector('.sql-pane:not([hidden]) .sql-grid tbody tr') as HTMLElement).click();
    expect(status(tab)).toBe('Loaded 2 rows in 12 ms. More rows available. 1 row selected.');
    by('Copy').click();
    await tick();
    expect(fake.app.ClipboardSet).toHaveBeenLastCalledWith('ID  NAME\r\n--  ------\r\n 1  name 1\r\n');
  });

  it('while a statement runs it is tinted in the editor, Output says so and the foot counts the seconds', async () => {
    vi.useFakeTimers();
    const tab = await openTab();
    tab.setScript('WAIT FOR A LOCK;');
    const run = tab.runAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(tab.frame.querySelector('.cm-running')?.textContent).toBe('WAIT FOR A LOCK');
    expect(foot(tab)).toBe('Running 1 of 1: WAIT FOR A LOCK');
    expect(lastLine(tab)).toBe('Running…');
    vi.advanceTimersByTime(3000);
    expect(foot(tab)).toBe('Running 1 of 1: WAIT FOR A LOCK (3 s)');
    expect(lastLine(tab)).toBe('Running… (3 s)');
    (tab.frame.querySelector('.sql-top button[title^="Cancel"]') as HTMLButtonElement).click();
    expect(foot(tab)).toMatch(/^Stopping after 1 of 1/);
    fake.finish({ kind: 'error', more: false, updateCount: 0, messages: [{ id: '57014', code: -952, severity: 0, text: 'Processing of the SQL statement ended.' }], elapsedMs: 3000 });
    await run;
    expect(tab.frame.querySelector('.cm-running')).toBeNull();
    expect(lastLine(tab)).toMatch(/^✗ 57014 \(SQLCODE -952\)/);
    expect(fake.app.SqlCancel).toHaveBeenCalled();
  });
});

describe('outcomeText', () => {
  it('formats counts with separators and singulars', () => {
    expect(outcomeText({ kind: 'rows', columns: [{ name: 'A', type: 'CHAR', length: 1, scale: 0, nullable: false }], rows: [['x']], more: false, updateCount: 0, messages: [], elapsedMs: 1234 }, 0)).toBe('Loaded 1 row in 1,234 ms. End of data.');
    expect(outcomeText({ kind: 'count', more: false, updateCount: 1, messages: [], elapsedMs: 3 }, 0)).toBe('1 row affected in 3 ms.');
    expect(outcomeText({ kind: 'error', more: false, updateCount: 0, messages: [], elapsedMs: 3 }, 0)).toBe('Failed after 3 ms.');
  });
});
