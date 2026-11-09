// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IfsEntry } from '../../src/desktop/bridge';
import { IfsTab } from '../../src/desktop/ifsTab';

/** A tiny in-memory file server behind window.go, like PUB400's IFS would answer. */
function fakeHost(tree: Record<string, string[]>) {
  const entry = (name: string, dir: boolean): IfsEntry => ({ name, dir, symlink: false, size: dir ? 0 : 12, modified: '2026-11-03T09:00:00Z', created: '', type: dir ? 2 : 1, readOnly: false, hidden: false });
  const calls: string[] = [];
  const app = {
    IfsConnect: vi.fn(async () => 'S1'),
    IfsClose: vi.fn(async () => undefined),
    IfsList: vi.fn(async (_id: string, dir: string) => {
      calls.push(`list ${dir}`);
      const names = tree[dir];
      if (!names) throw new Error(`${dir}: not found`);
      return names.map((n) => entry(n.replace(/\/$/, ''), n.endsWith('/')));
    }),
    IfsRename: vi.fn(async (_id: string, from: string, to: string) => {
      calls.push(`rename ${from} ${to}`);
    }),
    ClipboardSet: vi.fn(async () => undefined),
    IfsReadBytes: vi.fn(async () => ({ data: btoa('hello'), ccsid: 1208, size: 5, truncated: false })),
    SaveTextFile: vi.fn(async () => true),
  };
  window.go = { main: { App: app as never } };
  window.runtime = { EventsOn: () => () => undefined } as never;
  return { app, calls };
}

const host = { notify: vi.fn(), log: vi.fn(), changed: vi.fn(), openViewer: vi.fn() };
const request = { host: 'pub400.com', tls: false, trustAnyCertificate: false, user: 'jsmith', password: 'x', timeoutMs: 1000 };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('IFS tab: mouse navigation', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    host.notify.mockClear();
  });

  it('opens the home folder, shows it as crumbs and in the tree, and a crumb click goes up', async () => {
    const { calls } = fakeHost({ '/': ['home/', 'tmp/', 'QSYS.LIB/'], '/home': ['JSMITH/'], '/home/JSMITH': ['src/', 'notes.txt'] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    expect(calls[0]).toBe('list /home/JSMITH');
    await tick();
    await tick();
    await tick();
    // The folders above were listed afterwards, root first, so the tree shows the neighbours too.
    expect(calls).toEqual(['list /home/JSMITH', 'list /', 'list /home']);
    const crumbs = [...tab.frame.querySelectorAll<HTMLButtonElement>('.ifs-crumbs .crumb')].map((b) => b.textContent);
    expect(crumbs).toEqual(['/', 'home', 'JSMITH']);
    // The tree knows the way down to the current folder and its sub-folders.
    const nodes = [...tab.frame.querySelectorAll<HTMLElement>('.ifs-node')].map((n) => n.dataset.path);
    expect(nodes).toEqual(['/', '/home', '/home/JSMITH', '/home/JSMITH/src', '/QSYS.LIB', '/tmp']);
    expect(tab.frame.querySelector('.ifs-node.current')?.getAttribute('data-path')).toBe('/home/JSMITH');
    // Rows: folder first, then the file.
    const rows = [...tab.frame.querySelectorAll<HTMLTableRowElement>('.ifs-list tbody tr')].map((r) => r.querySelector('.col-name')?.textContent);
    expect(rows).toEqual(['src', 'notes.txt']);

    tab.frame.querySelector<HTMLButtonElement>('.ifs-crumbs .crumb[data-path="/home"]')?.click();
    await tick();
    await tick();
    expect(calls.at(-1)).toBe('list /home');
    expect(tab.frame.querySelector('.ifs-node.current')?.getAttribute('data-path')).toBe('/home');
  });

  it('a click only highlights the row, so a double-click still reaches it: folders open, files go to the viewer', async () => {
    const { calls } = fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': ['src/', 'notes.txt'], '/home/JSMITH/src': [] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    const row = (name: string): HTMLTableRowElement => [...tab.frame.querySelectorAll<HTMLTableRowElement>('.ifs-list tbody tr')].find((r) => r.dataset.name === name) as HTMLTableRowElement;
    const notes = row('notes.txt');
    notes.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    // The same element is still in the table (no rebuild) and is now selected.
    expect(row('notes.txt')).toBe(notes);
    expect(notes.classList.contains('selected')).toBe(true);
    expect((tab.frame.querySelector('button.eye') as HTMLButtonElement).disabled).toBe(false);
    notes.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(host.openViewer).toHaveBeenCalledWith(tab, '/home/JSMITH/notes.txt', { size: 12, modified: '2026-11-03T09:00:00Z' });
    const src = row('src');
    src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    src.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await tick();
    await tick();
    expect(calls.at(-1)).toBe('list /home/JSMITH/src');
  });

  it('draws the tool bars as icon buttons that share the Macros dialog look', async () => {
    fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': [] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    expect(tab.frame.querySelector('.ifs-top')?.classList.contains('icon-actions')).toBe(true);
    const icons = [...tab.frame.querySelectorAll<HTMLButtonElement>('.ifs-top button.act')].map((b) => b.className.split(' ')[1]);
    expect(icons).toEqual(['back', 'up', 'refresh', 'folderTree', 'exportFile', 'importFile', 'newFolder', 'pencil', 'trash', 'eye']);
    expect(tab.frame.querySelectorAll('.ifs-top button.act svg .ring')).toHaveLength(10);
    // Nothing selected: view, rename, delete and download are off; upload and new folder are on.
    const state = Object.fromEntries([...tab.frame.querySelectorAll<HTMLButtonElement>('.ifs-top button.act')].map((b) => [b.className.split(' ')[1], b.disabled]));
    expect(state).toMatchObject({ eye: true, pencil: true, trash: true, importFile: true, exportFile: false, newFolder: false });
  });

  it('expands a tree node on its arrow and navigates on its name', async () => {
    const { calls } = fakeHost({ '/': ['home/', 'tmp/'], '/home': ['JSMITH/'], '/home/JSMITH': [], '/tmp': ['a/', 'b/'] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    await tick();
    await tick();
    await tick();
    const tmp = tab.frame.querySelector<HTMLElement>('.ifs-node[data-path="/tmp"]');
    expect(tmp).toBeTruthy();
    tmp?.querySelector<HTMLElement>('.arrow')?.click();
    await tick();
    await tick();
    expect(calls).toContain('list /tmp');
    const nodes = [...tab.frame.querySelectorAll<HTMLElement>('.ifs-node')].map((n) => n.dataset.path);
    expect(nodes).toContain('/tmp/a');
    expect(nodes).toContain('/tmp/b');
    // Expanding did not change the current folder; clicking the name does.
    expect(tab.frame.querySelector('.ifs-node.current')?.getAttribute('data-path')).toBe('/home/JSMITH');
    tab.frame.querySelector<HTMLElement>('.ifs-node[data-path="/tmp/a"]')?.click();
    await tick();
    await tick();
    expect(calls.at(-1)).toBe('list /tmp/a');
  });

  it('switches the crumbs to a text box on the pencil and back on Escape', async () => {
    fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': [] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    const input = tab.frame.querySelector<HTMLInputElement>('.ifs-path');
    expect(input?.hidden).toBe(true);
    tab.frame.querySelector<HTMLButtonElement>('.ifs-path-edit')?.click();
    expect(input?.hidden).toBe(false);
    expect(input?.value).toBe('/home/JSMITH');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input?.hidden).toBe(true);
    expect(tab.frame.querySelector<HTMLElement>('.ifs-crumbs')?.hidden).toBe(false);
  });

  it('moves dragged rows into a folder after confirmation', async () => {
    const { calls } = fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': ['src/', 'notes.txt', 'old.txt'] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    // The dialog is answered "Move" by closing it with the OK value.
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.returnValue = 'ok';
      this.dispatchEvent(new Event('close'));
    };
    try {
      await tab.moveInto(['/home/JSMITH/notes.txt', '/home/JSMITH/old.txt'], '/home/JSMITH/src');
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
    expect(calls.filter((c) => c.startsWith('rename'))).toEqual(['rename /home/JSMITH/notes.txt /home/JSMITH/src/notes.txt', 'rename /home/JSMITH/old.txt /home/JSMITH/src/old.txt']);
    expect(host.notify).toHaveBeenCalledWith('Moved 2 item(s) to /home/JSMITH/src');
  });

  it('never moves a folder into itself or where it already is', async () => {
    const { calls } = fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': ['src/'] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    await tab.moveInto(['/home/JSMITH/src'], '/home/JSMITH/src');
    await tab.moveInto(['/home/JSMITH/src'], '/home/JSMITH');
    expect(calls.filter((c) => c.startsWith('rename'))).toEqual([]);
  });
});
