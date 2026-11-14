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
    IfsSearch: vi.fn(async (_id: string, dir: string, text: string, subtree: boolean) => {
      calls.push(`search ${dir} ${text}${subtree ? ' subtree' : ''}`);
      const hits = subtree ? ['src/notes.txt', 'src/deep/notes.bak'] : ['notes.txt'];
      return hits.map((name) => ({ name, dir: false, size: 3, modified: '2026-11-03T09:00:00Z' }));
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

  it('typing in the search box filters the rows; Enter asks the host, Escape puts the folder back', async () => {
    const { calls } = fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': ['src/', 'notes.txt', 'readme.md'] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    const names = (): (string | null | undefined)[] => [...tab.frame.querySelectorAll<HTMLTableRowElement>('.ifs-list tbody tr')].map((r) => r.querySelector('.col-name')?.textContent);
    const box = tab.frame.querySelector<HTMLInputElement>('.ifs-search')!;
    box.value = 'note';
    box.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['notes.txt']);
    expect(calls.filter((c) => c.startsWith('search'))).toEqual([]);
    // Enter: the host filters the folder; the Subfolders switch searches the tree below.
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    await tick();
    expect(calls.at(-1)).toBe('search /home/JSMITH note');
    expect(names()).toEqual(['notes.txt']);
    expect(host.notify).toHaveBeenLastCalledWith('1 name containing "note" in /home/JSMITH');
    tab.frame.querySelector<HTMLButtonElement>('.ifs-search-sub')!.click();
    await tick();
    await tick();
    expect(calls.at(-1)).toBe('search /home/JSMITH note subtree');
    expect(names()).toEqual(['src/deep/notes.bak', 'src/notes.txt']);
    expect(tab.frame.classList.contains('searching')).toBe(true);
    // Escape: the folder is listed again and the box is empty.
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();
    await tick();
    expect(calls.at(-1)).toBe('list /home/JSMITH');
    expect(names()).toEqual(['src', 'notes.txt', 'readme.md']);
    expect(box.value).toBe('');
    expect(tab.frame.classList.contains('searching')).toBe(false);
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
    // No pencil for the path (Ctrl+L and a click on the crumbs do it); the name filter has its own row above the headers.
    expect(tab.frame.querySelector('.ifs-path-edit')).toBeNull();
    const listPane = tab.frame.querySelector('.ifs-listpane')!;
    expect(listPane.firstElementChild?.className).toBe('ifs-filter-row icon-actions');
    expect(listPane.querySelector('.ifs-filter-row .ifs-search')).not.toBeNull();
    expect(listPane.querySelector('.ifs-filter-row button.act.subtree')).not.toBeNull();
    expect(listPane.children[1]?.className).toBe('ifs-scroll');
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

  it('Ctrl+L switches the crumbs to a text box that completes names; Escape puts the crumbs back', async () => {
    const { calls } = fakeHost({ '/': ['home/', 'tmp/'], '/home': ['JSMITH/', 'JDOE/', 'readme.txt'], '/home/JSMITH': [] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    const input = tab.frame.querySelector<HTMLInputElement>('.ifs-path')!;
    expect(input.hidden).toBe(true);
    tab.frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    expect(input.hidden).toBe(false);
    expect(input.value).toBe('/home/JSMITH');
    // Typing offers the names under the folder typed so far, folders first.
    input.value = '/home/J';
    input.dispatchEvent(new Event('input'));
    await tick();
    await tick();
    const list = tab.frame.querySelector<HTMLElement>('.ifs-path-complete')!;
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['JDOE', 'JSMITH']);
    // Tab completes as far as the names agree; a second Tab with one left takes it.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(input.value).toBe('/home/J');
    input.value = '/home/JS';
    input.dispatchEvent(new Event('input'));
    await tick();
    await tick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(input.value).toBe('/home/JSMITH/');
    // Listings came from what the tab had seen; /home was asked once.
    expect(calls.filter((c) => c === 'list /home')).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.hidden).toBe(true);
    expect(list.hidden).toBe(true);
    expect(tab.frame.querySelector<HTMLElement>('.ifs-crumbs')?.hidden).toBe(false);
  });

  it('an empty folder shows "This folder is empty." and no stale rows; a filter with no hit says so and clears', async () => {
    fakeHost({ '/': ['home/'], '/home': ['JSMITH/'], '/home/JSMITH': ['empty/', 'notes.txt'], '/home/JSMITH/empty': [] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    expect(tab.frame.querySelectorAll('.ifs-list tbody tr')).toHaveLength(2);
    const search = tab.frame.querySelector<HTMLInputElement>('.ifs-search')!;
    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    expect(tab.frame.querySelectorAll('.ifs-list tbody tr')).toHaveLength(0);
    const message = tab.frame.querySelector<HTMLElement>('.ifs-message')!;
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe('No name here contains "zzz".');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(message.hidden).toBe(true);
    expect(tab.frame.querySelectorAll('.ifs-list tbody tr')).toHaveLength(2);
    await tab.go('/home/JSMITH/empty');
    expect(tab.frame.querySelectorAll('.ifs-list tbody tr')).toHaveLength(0);
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe('This folder is empty.');
    await tab.go('/home/JSMITH');
    expect(message.hidden).toBe(true);
  });

  it('the tree filter narrows the folders shown and keeps the way down to each match', async () => {
    fakeHost({ '/': ['home/', 'tmp/', 'QSYS.LIB/'], '/home': ['JSMITH/'], '/home/JSMITH': ['src/', 'docs/'] });
    const tab = new IfsTab(host, request);
    document.body.append(tab.frame);
    await tab.start();
    await tick();
    await tick();
    await tick();
    const filter = tab.frame.querySelector<HTMLInputElement>('.ifs-tree-filter')!;
    filter.value = 'doc';
    filter.dispatchEvent(new Event('input'));
    expect([...tab.frame.querySelectorAll<HTMLElement>('.ifs-node')].map((n) => n.dataset.path)).toEqual(['/', '/home', '/home/JSMITH', '/home/JSMITH/docs']);
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tab.frame.querySelectorAll('.ifs-node')).toHaveLength(7);
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
