// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IfsViewTab } from '../../src/desktop/ifsViewTab';
import { toBase64 } from '../../src/desktop/ifsText';

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
  return { app, writes, setListing: (l: typeof listing) => (listing = l) };
}

const host = { notify: vi.fn(), changed: vi.fn() };
const info = { size: EBCDIC_HELLO.length, modified: '2026-11-08T10:00:00Z' };

beforeEach(() => {
  document.body.replaceChildren();
  host.notify.mockClear();
  host.changed.mockClear();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.returnValue = 'ok';
    this.dispatchEvent(new Event('close'));
  };
});

const button = (tab: IfsViewTab, icon: string): HTMLButtonElement => tab.frame.querySelector(`button.${icon}`) as HTMLButtonElement;
const area = (tab: IfsViewTab): HTMLTextAreaElement => tab.frame.querySelector('.ifsv-text') as HTMLTextAreaElement;

describe('IFS viewer tab', () => {
  it('decodes an EBCDIC file by its CCSID, numbers the lines and shows the encoding', async () => {
    fakeHost({ bytes: EBCDIC_HELLO, ccsid: 37 });
    const tab = new IfsViewTab(host, 'S1', '/home/JSMITH/a.txt', info);
    document.body.append(tab.frame);
    await tab.load();
    expect(tab.title).toBe('a.txt');
    expect(area(tab).value).toBe('Hello\nWorld');
    expect(area(tab).readOnly).toBe(true);
    expect(tab.frame.querySelector('.ifsv-gutter')?.textContent).toBe('1\n2');
    expect((tab.frame.querySelector('.ifsv-encoding') as HTMLSelectElement).value).toBe('37');
    expect(tab.frame.querySelector('.ifs-status')?.textContent).toContain('EBCDIC 37 (US, Canada)');
    expect(button(tab, 'save').disabled).toBe(true);
    expect(button(tab, 'pencil').disabled).toBe(false);
  });

  it('switching the encoding re-decodes; Find counts and selects matches', async () => {
    fakeHost({ bytes: new TextEncoder().encode('one two\nthree two'), ccsid: 1208 });
    const tab = new IfsViewTab(host, 'S1', '/x/b.txt', { size: 17, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    const sel = tab.frame.querySelector('.ifsv-encoding') as HTMLSelectElement;
    sel.value = '819';
    sel.dispatchEvent(new Event('change'));
    expect(area(tab).value).toBe('one two\nthree two'); // ASCII reads the same in Latin-1
    expect(tab.frame.querySelector('.ifs-status')?.textContent).toContain('ISO-8859-1 (819) (file says 1208)');
    button(tab, 'find').click();
    const input = tab.frame.querySelector('.ifsv-find-input') as HTMLInputElement;
    input.value = 'TWO';
    input.dispatchEvent(new Event('input'));
    expect(tab.frame.querySelector('.ifsv-find-count')?.textContent).toBe('1 of 2');
    expect([area(tab).selectionStart, area(tab).selectionEnd]).toEqual([4, 7]);
    tab.find(1);
    expect(tab.frame.querySelector('.ifsv-find-count')?.textContent).toBe('2 of 2');
    expect(area(tab).selectionStart).toBe(14);
  });

  it('edits and saves back in the file CCSID, keeping the NL line end; the title shows the dirty mark', async () => {
    const { writes, app } = fakeHost({ bytes: EBCDIC_HELLO, ccsid: 37 });
    const tab = new IfsViewTab(host, 'S1', '/home/JSMITH/a.txt', info);
    document.body.append(tab.frame);
    await tab.load();
    button(tab, 'pencil').click();
    expect(area(tab).readOnly).toBe(false);
    area(tab).value = 'Hello\nIBM i';
    area(tab).dispatchEvent(new Event('input'));
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

  it('shows a hex dump for binary files and turns editing off', async () => {
    fakeHost({ bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), ccsid: 0 });
    const tab = new IfsViewTab(host, 'S1', '/x/a.zip', { size: 6, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    expect(area(tab).value).toBe('00000000  50 4b 03 04 00 00                                PK....');
    expect(button(tab, 'pencil').disabled).toBe(true);
    expect(tab.frame.querySelector('.ifs-status')?.textContent).toContain('binary (hex)');
  });

  it('a truncated read shows the banner and disables editing', async () => {
    fakeHost({ bytes: new TextEncoder().encode('part'), ccsid: 1208, truncated: true });
    const tab = new IfsViewTab(host, 'S1', '/x/big.log', { size: 99999999, modified: '' });
    document.body.append(tab.frame);
    await tab.load();
    expect((tab.frame.querySelector('.ifsv-banner') as HTMLElement).hidden).toBe(false);
    expect(button(tab, 'pencil').disabled).toBe(true);
  });
});
