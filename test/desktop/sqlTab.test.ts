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
  // jsdom has no layout: the Messages list scrolls its newest line into view.
  Element.prototype.scrollIntoView = () => undefined;
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

const status = (tab: SqlTab): string => tab.frame.querySelector('.sql-results-status')!.textContent ?? '';
const foot = (tab: SqlTab): string => tab.frame.querySelector('.sql-foot span')!.textContent ?? '';
const job = (tab: SqlTab): string => tab.frame.querySelector('.sql-job')!.textContent ?? '';
const selectedPane = (tab: SqlTab): string => tab.frame.querySelector('.sql-tabs button[aria-selected="true"]')!.textContent ?? '';
const gridRows = (tab: SqlTab): number => tab.frame.querySelectorAll('.sql-grid tbody tr').length;

describe('Run SQL Scripts: feedback like Db2 for i', () => {
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
  });

  it('a SELECT reports rows loaded, time and whether more are available', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    expect(gridRows(tab)).toBe(2);
    expect(status(tab)).toBe('Loaded 2 rows in 12 ms. More rows available.');
    expect(selectedPane(tab)).toBe('Results');
    expect(foot(tab)).toBe('1 of 1 statement ran');
  });

  it('Fetch more adds the rows and the time, then says End of data', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    (tab.frame.querySelector('.sql-more button') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(gridRows(tab)).toBe(5);
    expect(status(tab)).toBe('Loaded 5 rows in 12 ms + 8 ms. End of data.');
    expect(tab.frame.querySelector('.sql-more button')!.textContent).not.toMatch(/more rows/);
  });

  it('a DELETE clears the old grid and reports the rows affected', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    tab.setScript('DELETE FROM MYLIB.T WHERE ID = 1;');
    await tab.runAll();
    expect(gridRows(tab)).toBe(0);
    expect(status(tab)).toBe('3 rows affected in 24 ms.');
    expect(selectedPane(tab)).toBe('Results');
  });

  it('a statement without rows or a count says it ran', async () => {
    const tab = await openTab();
    tab.setScript('CREATE TABLE QTEMP.T (A INT);');
    await tab.runAll();
    expect(status(tab)).toBe('Statement ran in 7 ms.');
  });

  it('an SQL error shows up in the status line and opens Messages', async () => {
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    tab.setScript('DROP TABLE QGPL.NOPE;');
    await tab.runAll();
    expect(gridRows(tab)).toBe(0);
    expect(status(tab)).toBe('42704 (SQLCODE -204): NOPE in QGPL type *FILE not found. · 5 ms');
    expect(selectedPane(tab)).toBe('Messages');
    expect(foot(tab)).toBe('0 of 1 statement ran');
  });

  it('CL output counts lines', async () => {
    const tab = await openTab();
    tab.setScript('CL: DSPLIBL;');
    await tab.runAll();
    expect(gridRows(tab)).toBe(2);
    expect(status(tab)).toBe('Output: 2 lines in 30 ms.');
  });

  it('while a statement runs the old grid is stale and the foot counts the seconds', async () => {
    vi.useFakeTimers();
    const tab = await openTab();
    tab.setScript('SELECT * FROM QSYS2.SYSTABLES;');
    await tab.runAll();
    tab.setScript('WAIT FOR A LOCK;');
    const run = tab.runAll();
    await Promise.resolve();
    await Promise.resolve();
    const grid = tab.frame.querySelector('.sql-grid-wrap')!;
    expect(grid.classList.contains('stale')).toBe(true);
    expect(foot(tab)).toBe('Running 1 of 1: WAIT FOR A LOCK');
    expect(status(tab)).toBe('Running…');
    vi.advanceTimersByTime(3000);
    expect(foot(tab)).toBe('Running 1 of 1: WAIT FOR A LOCK (3 s)');
    expect(status(tab)).toBe('Running… 3 s');
    (tab.frame.querySelector('.sql-top button[title^="Cancel"]') as HTMLButtonElement).click();
    expect(foot(tab)).toMatch(/^Stopping after 1 of 1/);
    fake.finish({ kind: 'error', more: false, updateCount: 0, messages: [{ id: '57014', code: -952, severity: 0, text: 'Processing of the SQL statement ended.' }], elapsedMs: 3000 });
    await run;
    expect(grid.classList.contains('stale')).toBe(false);
    expect(status(tab)).toMatch(/^57014 \(SQLCODE -952\)/);
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
