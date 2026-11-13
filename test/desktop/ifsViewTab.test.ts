// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IfsViewTab } from '../../src/desktop/ifsViewTab';
import { toBase64 } from '../../src/desktop/ifsText';

vi.mock('../../src/desktop/dialogs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/desktop/dialogs')>();
  return { ...real, promptDialog: vi.fn(async () => '/home/JSMITH/copy.txt'), confirmDialog: vi.fn(async () => true) };
});

const EBCDIC_HELLO = Uint8Array.from([0xc8, 0x85, 0x93, 0x93, 0x96, 0x15, 0xe6, 0x96, 0x99, 0x93, 0x84]); // "Hello\nWorld"

function fakeHost(file: { bytes: Uint8Array; ccsid: number; truncated?: boolean }) {
  const writes: Array<{ path: string; bytes: number[]; ccsid: number; replace: boolean }> = [];
  let listing = [{ name: 'a.txt', dir: false, symlink: false, size: file.bytes.length, modified: '2026-11-08T10:00:00Z', created: '', type: 1, readOnly: false, hidden: false }];
  const app = {
    IfsReadBytes: vi.fn(async () => ({ data: toBase64(file.bytes), ccsid: file.ccsid, size: file.bytes.length, truncated: !!file.truncated })),
    IfsWriteBytes: vi.fn(async (_id: string, path: string, b64: string, ccsid: number, replace: boolean) => {
      writes.push({ path, bytes: [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], ccsid, replace });
    }),
    IfsList: vi.fn(async () => listing),
    IfsDownload: vi.fn(async () => 1),
    SaveTextFile: vi.fn(async () => true),
    ClipboardSet: vi.fn(async () => undefined),
  };
  window.go = { main: { App: app as never } };
  // jsdom has no layout: CodeMirror measures text ranges.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as never;
  Range.prototype.getBoundingClientRect = () => rect as never;
  Element.prototype.scrollIntoView = () => undefined;
  return { app, writes, setListing: (l: typeof listing) => (listing = l) };
}

const host = { notify: vi.fn(), changed: vi.fn(), openPath: vi.fn() };
const info = { size: EBCDIC_HELLO.length, modified: '2026-11-08T10:00:00Z' };

beforeEach(() => {
  document.body.replaceChildren();
  host.notify.mockClear();
  host.changed.mockClear();
  host.openPath.mockClear();
});

const button = (tab: IfsViewTab, icon: string): HTMLButtonElement => tab.frame.querySelector(`button.${icon}`) as HTMLButtonElement;
const text = (tab: IfsViewTab): string => tab['editor'].value;
const editable = (tab: IfsViewTab): boolean => tab.frame.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true';
const status = (tab: IfsViewTab): string => tab.frame.querySelector('.ifs-status')?.textContent ?? '';

describe('IFS viewer tab', () => {
  it('decodes an EBCDIC file by its CCSID into a read-only editor with line numbers', async () => {
    fakeHost({ bytes: EBCDIC_HELLO, ccsid: 37 });
    const tab = new IfsViewTab(host, 'S1', '/home/JSMITH/a.txt', info);
    document.body.append(tab.frame);
    await tab.load();
    expect(tab.title).toBe('a.txt');
    expect(text(tab)).toBe('Hello\nWorld');
    expect(editable(tab)).toBe(false);
    expect([...tab.frame.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map((e) => e.textContent).slice(1)).toEqual(['1', '2']); // the first gutter element is CodeMirror's width spacer
    expect((tab.frame.querySelector('.ifsv-encoding') as HTMLSelectElement).value).toBe('37');
    expect(status(tab)).toContain('EBCDIC 37 (US, Canada)');
    expect(button(tab, 'save').disabled).toBe(true);
    expect(button(tab, 'pencil').disabled).toBe(false);
    expect(button(tab, 'saveAs').disabled).toBe(false);
    // Buttons: download wears the download icon; Save as… on the host sits next to Save.
    expect([...tab.frame.querySelectorAll<HTMLButtonElement>('.ifsv-bar button.act')].map((b) => b.className.split(' ')[1])).toEqual(['refresh', 'pencil', 'save', 'saveAs', 'importFile', 'copy', 'find', 'wrap']);
  });

  it('switching the encoding re-decodes; Find opens the search panel', async () => {
    fakeHost({ bytes: new TextEncoder().encode('one two\nthree two'), ccsid: 1208 });
    const tab = new IfsViewTab(host, 'S1', '/x/b.txt', { size: 17, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    const sel = tab.frame.querySelector('.ifsv-encoding') as HTMLSelectElement;
    sel.value = '819';
    sel.dispatchEvent(new Event('change'));
    expect(text(tab)).toBe('one two\nthree two'); // ASCII reads the same in Latin-1
    expect(status(tab)).toContain('ISO-8859-1 (819) (file says 1208)');
    sel.value = '1251';
    sel.dispatchEvent(new Event('change'));
    expect(status(tab)).toContain('Windows-1251 (Cyrillic)');
    expect(button(tab, 'pencil').disabled).toBe(false);
    sel.value = '943';
    sel.dispatchEvent(new Event('change'));
    expect(status(tab)).toContain('Shift_JIS (943, Japanese)');
    expect(button(tab, 'pencil').disabled).toBe(true); // read only: no encoder
    button(tab, 'find').click();
    expect(tab.frame.querySelector('.cm-panel.cm-search')).not.toBeNull();
  });

  it('edits and saves back in the file CCSID, keeping the NL line end; the title shows the dirty mark', async () => {
    const { writes, app } = fakeHost({ bytes: EBCDIC_HELLO, ccsid: 37 });
    const tab = new IfsViewTab(host, 'S1', '/home/JSMITH/a.txt', info);
    document.body.append(tab.frame);
    await tab.load();
    button(tab, 'pencil').click();
    expect(editable(tab)).toBe(true);
    tab['editor'].replaceAll('Hello\nIBM i');
    expect(tab.isDirty).toBe(true);
    expect(tab.title).toBe('● a.txt');
    expect(host.changed).toHaveBeenCalledWith(tab);
    expect(button(tab, 'save').disabled).toBe(false);
    await tab.save();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/home/JSMITH/a.txt', ccsid: 37, replace: true });
    expect(writes[0]?.bytes).toEqual([0xc8, 0x85, 0x93, 0x93, 0x96, 0x15, 0xc9, 0xc2, 0xd4, 0x40, 0x89]);
    expect(tab.isDirty).toBe(false);
    expect(tab.title).toBe('a.txt');
    expect(app.IfsList).toHaveBeenCalled(); // checked the host copy before writing
    expect(host.notify).toHaveBeenCalledWith(expect.stringContaining('Saved a.txt'));
  });

  it('Save as… on the host writes the text under the new path in the same code page and opens it', async () => {
    const { writes } = fakeHost({ bytes: EBCDIC_HELLO, ccsid: 37 });
    const tab = new IfsViewTab(host, 'S1', '/home/JSMITH/a.txt', info);
    document.body.append(tab.frame);
    await tab.load();
    await tab.saveAsHost();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/home/JSMITH/copy.txt', ccsid: 37 });
    expect(writes[0]?.bytes).toEqual([...EBCDIC_HELLO]);
    expect(host.openPath).toHaveBeenCalledWith('S1', '/home/JSMITH/copy.txt', expect.anything());
    expect(tab.isDirty).toBe(false);
  });

  it('shows a hex dump for binary files and turns editing off', async () => {
    fakeHost({ bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), ccsid: 0 });
    const tab = new IfsViewTab(host, 'S1', '/x/a.zip', { size: 6, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    expect(text(tab)).toBe('00000000  50 4b 03 04 00 00                                PK....');
    expect(button(tab, 'pencil').disabled).toBe(true);
    expect(status(tab)).toContain('binary (hex)');
  });

  it('a truncated read shows the banner and disables editing', async () => {
    fakeHost({ bytes: new TextEncoder().encode('part'), ccsid: 1208, truncated: true });
    const tab = new IfsViewTab(host, 'S1', '/x/big.log', { size: 99999999, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    expect((tab.frame.querySelector('.ifsv-banner') as HTMLElement).hidden).toBe(false);
    expect(button(tab, 'pencil').disabled).toBe(true);
  });

  it('names the language by the extension', async () => {
    fakeHost({ bytes: new TextEncoder().encode('{"a": 1}'), ccsid: 1208 });
    const tab = new IfsViewTab(host, 'S1', '/x/config.json', { size: 8, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    expect(status(tab)).toContain('· JSON');
  });

  it('a CSV opens as a grid with a filter per column; Text shows the file; Edit switches to Text', async () => {
    fakeHost({ bytes: new TextEncoder().encode('id,name\r\n1,"Acme, Inc."\r\n2,Zed\r\n'), ccsid: 1208 });
    const tab = new IfsViewTab(host, 'S1', '/x/list.csv', { size: 30, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    const rows = (): string[][] => [...tab.frame.querySelectorAll<HTMLTableRowElement>('.csv-table tbody tr')].map((r) => [...r.cells].map((c) => c.textContent ?? ''));
    expect(tab.frame.querySelector<HTMLElement>('.csv-grid')!.hidden).toBe(false);
    expect(tab.frame.querySelector<HTMLElement>('.code-editor')!.hidden).toBe(true);
    expect([...tab.frame.querySelectorAll('.csv-table thead tr:first-child th')].map((h) => h.textContent)).toEqual(['id', 'name']);
    expect(rows()).toEqual([
      ['1', 'Acme, Inc.'],
      ['2', 'Zed'],
    ]);
    expect(tab.frame.querySelector('.csv-count')?.textContent).toBe('2 rows');
    const filter = tab.frame.querySelectorAll<HTMLInputElement>('.csv-filter')[1]!;
    filter.value = 'acme';
    filter.dispatchEvent(new Event('input'));
    expect(rows()).toEqual([['1', 'Acme, Inc.']]);
    expect(tab.frame.querySelector('.csv-count')?.textContent).toBe('1 of 2 rows');
    expect(status(tab)).toContain('· CSV');
    button(tab, 'pencil').click();
    expect(tab.frame.querySelector<HTMLElement>('.csv-grid')!.hidden).toBe(true);
    expect(editable(tab)).toBe(true);
    expect(text(tab)).toBe('id,name\n1,"Acme, Inc."\n2,Zed\n'); // the editor keeps lines, not line ends
  });
});
