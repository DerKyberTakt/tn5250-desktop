import { errorText, goApp, wailsRuntime, type IfsConnectRequest, type IfsEntry, type IfsProgress } from './bridge';
import { confirmDialog, messageDialog, promptDialog } from './dialogs';

export interface IfsHost {
  notify(text: string): void;
  log(line: string): void;
  changed(tab: IfsTab): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parent = (p: string): string => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function typeName(e: IfsEntry): string {
  if (e.symlink) return 'Link';
  if (e.dir) return 'Folder';
  if (e.type === 4) return 'Object';
  const dot = e.name.lastIndexOf('.');
  return dot > 0 ? `${e.name.slice(dot + 1).toUpperCase()} file` : 'File';
}

type SortKey = 'name' | 'size' | 'modified' | 'type';
let transferCounter = 0;

/** An ACS-style Integrated File System browser for one host, over the IBM i file server. */
export class IfsTab {
  readonly frame: HTMLDivElement;
  title: string;
  private session = '';
  private cwd = '/';
  private history: string[] = [];
  private entries: IfsEntry[] = [];
  private selected = new Set<string>();
  private anchor: string | undefined;
  private sort: { key: SortKey; asc: boolean } = { key: 'name', asc: true };
  private busy = false;

  private readonly pathInput: HTMLInputElement;
  private readonly body: HTMLTableSectionElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly progressEl: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  private stopProgress: (() => void) | undefined;

  constructor(
    private readonly host: IfsHost,
    private readonly request: IfsConnectRequest,
  ) {
    this.title = `IFS - ${request.host}`;
    this.frame = el('div', 'terminal-frame ifs');
    this.frame.tabIndex = -1;

    const bar = el('div', 'ifs-bar');
    const btn = (key: string, text: string, title: string, run: () => void): HTMLButtonElement => {
      const b = el('button', undefined, text);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', run);
      this.buttons[key] = b;
      return b;
    };
    bar.append(
      btn('back', '←', 'Back', () => void this.back()),
      btn('up', '↑', 'Up one level', () => void this.go(parent(this.cwd))),
      btn('refresh', '⟳', 'Refresh (F5)', () => void this.go(this.cwd, false)),
    );
    this.pathInput = el('input', 'ifs-path');
    this.pathInput.spellcheck = false;
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.go(this.pathInput.value);
    });
    const fav = el('select', 'ifs-fav');
    fav.title = 'Go to';
    for (const [label, p] of [['Go to…', ''], ['Home', `/home/${request.user.toUpperCase()}`], ['/tmp', '/tmp'], ['QSYS.LIB (libraries)', '/QSYS.LIB'], ['QIBM/UserData', '/QIBM/UserData'], ['Root /', '/']] as const) {
      const o = el('option', undefined, label);
      o.value = p;
      fav.append(o);
    }
    fav.addEventListener('change', () => {
      if (fav.value) void this.go(fav.value);
      fav.value = '';
    });
    bar.append(this.pathInput, fav);
    const actions = el('div', 'ifs-actions');
    actions.append(
      btn('upload', 'Upload…', 'Upload files from this computer (or drop files here)', () => void this.upload([])),
      btn('download', 'Download…', 'Download the selected items', () => void this.download()),
      btn('mkdir', 'New folder', 'Create a folder here', () => void this.mkdir()),
      btn('rename', 'Rename', 'Rename the selected item (F2)', () => void this.rename()),
      btn('delete', 'Delete', 'Delete the selected items (Del)', () => void this.remove()),
      btn('view', 'View', 'Show the selected text file', () => void this.view()),
    );

    const table = el('table', 'ifs-list');
    const head = el('thead');
    const hr = el('tr');
    for (const [key, label] of [['name', 'Name'], ['size', 'Size'], ['modified', 'Modified'], ['type', 'Type']] as const) {
      const th = el('th', `col-${key}`, label);
      th.addEventListener('click', () => {
        this.sort = { key, asc: this.sort.key === key ? !this.sort.asc : true };
        this.render();
      });
      hr.append(th);
    }
    head.append(hr);
    this.body = el('tbody');
    table.append(head, this.body);
    const scroller = el('div', 'ifs-scroll');
    this.messageEl = el('div', 'ifs-message');
    this.messageEl.hidden = true;
    scroller.append(table, this.messageEl);

    const foot = el('div', 'ifs-foot');
    this.statusEl = el('span', 'ifs-status', 'Connecting…');
    this.progressEl = el('div', 'ifs-progress');
    this.progressEl.hidden = true;
    foot.append(this.statusEl, this.progressEl);

    const top = el('div', 'ifs-top');
    top.append(bar, actions);
    this.frame.append(top, scroller, foot);
    this.frame.addEventListener('keydown', (e) => this.onKey(e));
    scroller.addEventListener('contextmenu', (e) => this.contextMenu(e));
    this.updateButtons();
  }

  focus(): void {
    this.frame.focus();
  }

  async start(): Promise<void> {
    this.setBusy(true);
    try {
      this.session = await goApp().IfsConnect(this.request);
      this.host.log(`[IFS ${this.request.host}] signed on as ${this.request.user.toUpperCase()}`);
      await this.go(`/home/${this.request.user.toUpperCase()}`, false, true);
    } catch (err) {
      this.showMessage(`Could not open the IFS on ${this.request.host}: ${errorText(err)}`, true);
      this.statusEl.textContent = 'Not connected';
    } finally {
      this.setBusy(false);
    }
  }

  dispose(): void {
    this.stopProgress?.();
    if (this.session) void goApp().IfsClose(this.session);
    this.frame.remove();
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.frame.classList.toggle('busy', b);
    this.updateButtons();
  }

  private showMessage(text: string, retry = false): void {
    this.messageEl.replaceChildren(el('p', undefined, text));
    if (retry) {
      const b = el('button', undefined, 'Retry');
      b.type = 'button';
      b.addEventListener('click', () => void this.start());
      this.messageEl.append(b);
    }
    this.messageEl.hidden = false;
  }

  /** Lists a folder. Falls back to "/" when the home folder does not exist. */
  async go(path: string, pushHistory = true, fallbackToRoot = false): Promise<void> {
    if (!this.session) return;
    const target = path.trim() || '/';
    this.setBusy(true);
    try {
      const list = await goApp().IfsList(this.session, target);
      if (pushHistory && target !== this.cwd) this.history.push(this.cwd);
      this.cwd = normalise(target);
      this.entries = list;
      this.selected.clear();
      this.anchor = undefined;
      this.messageEl.hidden = true;
      this.render();
    } catch (err) {
      if (fallbackToRoot && target !== '/') {
        this.setBusy(false);
        await this.go('/', false);
        return;
      }
      this.host.notify(errorText(err));
      this.pathInput.value = this.cwd;
    } finally {
      this.setBusy(false);
    }
  }

  private async back(): Promise<void> {
    const prev = this.history.pop();
    if (prev) await this.go(prev, false);
  }

  private sorted(): IfsEntry[] {
    const { key, asc } = this.sort;
    const dirFirst = (a: IfsEntry, b: IfsEntry): number => Number(b.dir) - Number(a.dir);
    const cmp = (a: IfsEntry, b: IfsEntry): number => {
      switch (key) {
        case 'size':
          return a.size - b.size;
        case 'modified':
          return Date.parse(a.modified) - Date.parse(b.modified);
        case 'type':
          return typeName(a).localeCompare(typeName(b));
        default:
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
      }
    };
    return [...this.entries].sort((a, b) => dirFirst(a, b) || (asc ? cmp(a, b) : -cmp(a, b)));
  }

  private render(): void {
    this.pathInput.value = this.cwd;
    this.body.replaceChildren();
    const rows = this.sorted();
    for (const e of rows) {
      const tr = el('tr', this.selected.has(e.name) ? 'selected' : undefined);
      const name = el('td', 'col-name');
      name.append(el('span', `icon ${e.dir ? 'folder' : 'file'}`), el('span', undefined, e.name));
      const modified = e.modified && !e.modified.startsWith('0001') ? new Date(e.modified).toLocaleString() : '';
      tr.append(name, el('td', 'col-size', e.dir ? '' : formatSize(e.size)), el('td', 'col-modified', modified), el('td', 'col-type', typeName(e)));
      tr.addEventListener('mousedown', (ev) => this.select(e.name, ev, rows));
      tr.addEventListener('dblclick', () => (e.dir ? void this.go(join(this.cwd, e.name)) : void this.view(e)));
      this.body.append(tr);
    }
    if (!rows.length) this.showMessage('This folder is empty.');
    const files = rows.filter((e) => !e.dir);
    const bytes = files.reduce((n, e) => n + e.size, 0);
    this.statusEl.textContent = `${rows.length} item(s), ${formatSize(bytes)} · ${this.request.user.toUpperCase()}@${this.request.host}${this.request.tls ? ' (TLS)' : ''}`;
    this.updateButtons();
    this.host.changed(this);
  }

  private select(name: string, ev: MouseEvent, rows: IfsEntry[]): void {
    if (ev.button === 2 && this.selected.has(name)) return; // keep the selection for the context menu
    if (ev.shiftKey && this.anchor) {
      const names = rows.map((r) => r.name);
      const i = names.indexOf(this.anchor);
      const j = names.indexOf(name);
      if (!ev.ctrlKey) this.selected.clear();
      for (const n of names.slice(Math.min(i, j), Math.max(i, j) + 1)) this.selected.add(n);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (this.selected.has(name)) this.selected.delete(name);
      else this.selected.add(name);
      this.anchor = name;
    } else {
      this.selected = new Set([name]);
      this.anchor = name;
    }
    this.render();
  }

  private selection(): IfsEntry[] {
    return this.entries.filter((e) => this.selected.has(e.name));
  }

  private updateButtons(): void {
    const sel = this.selection();
    const off = !this.session || this.busy;
    const set = (k: string, enabled: boolean): void => {
      const b = this.buttons[k];
      if (b) b.disabled = !enabled;
    };
    set('back', !off && this.history.length > 0);
    set('up', !off && this.cwd !== '/');
    set('refresh', !!this.session && !this.busy);
    set('upload', !off);
    set('download', !off && sel.length > 0);
    set('mkdir', !off);
    set('rename', !off && sel.length === 1);
    set('delete', !off && sel.length > 0);
    set('view', !off && sel.length === 1 && !sel[0]?.dir);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'F5') {
      e.preventDefault();
      void this.go(this.cwd, false);
    } else if (e.key === 'Delete') {
      void this.remove();
    } else if (e.key === 'F2') {
      void this.rename();
    } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
      e.preventDefault();
      void this.go(parent(this.cwd));
    } else if (e.key === 'Enter') {
      const [one] = this.selection();
      if (one?.dir) void this.go(join(this.cwd, one.name));
      else if (one) void this.view(one);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selected = new Set(this.entries.map((x) => x.name));
      this.render();
    }
  }

  private contextMenu(e: MouseEvent): void {
    e.preventDefault();
    document.querySelector('.ifs-menu')?.remove();
    const menu = el('div', 'ifs-menu');
    const sel = this.selection();
    const item = (text: string, enabled: boolean, run: () => void): void => {
      const b = el('button', undefined, text);
      b.type = 'button';
      b.disabled = !enabled;
      b.addEventListener('click', () => {
        menu.remove();
        run();
      });
      menu.append(b);
    };
    item('Open', sel.length === 1, () => (sel[0]?.dir ? void this.go(join(this.cwd, sel[0].name)) : void this.view(sel[0])));
    item('Download…', sel.length > 0, () => void this.download());
    item('Upload here…', true, () => void this.upload([]));
    item('New folder', true, () => void this.mkdir());
    item('Rename', sel.length === 1, () => void this.rename());
    item('Delete', sel.length > 0, () => void this.remove());
    item('Copy path', true, () => void goApp().ClipboardSet(sel.length === 1 && sel[0] ? join(this.cwd, sel[0].name) : this.cwd));
    item('Refresh', true, () => void this.go(this.cwd, false));
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.append(menu);
    const close = (ev: MouseEvent): void => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close));
  }

  // ---- actions --------------------------------------------------------------

  private async mkdir(): Promise<void> {
    const name = await promptDialog('New folder', `Folder name in ${this.cwd}`);
    if (!name?.trim()) return;
    await this.run(() => goApp().IfsMkdir(this.session, join(this.cwd, name.trim())), `Created ${name.trim()}`);
  }

  private async rename(): Promise<void> {
    const [one] = this.selection();
    if (!one) return;
    const name = await promptDialog('Rename', `New name for ${one.name}`, { value: one.name });
    if (!name?.trim() || name.trim() === one.name) return;
    await this.run(() => goApp().IfsRename(this.session, join(this.cwd, one.name), join(this.cwd, name.trim())), `Renamed to ${name.trim()}`);
  }

  private async remove(): Promise<void> {
    const sel = this.selection();
    if (!sel.length) return;
    const what = sel.length === 1 ? `"${sel[0]?.name}"` : `${sel.length} items`;
    if (!(await confirmDialog('Delete', `Delete ${what} from ${this.cwd}? This cannot be undone.`, 'Delete'))) return;
    this.setBusy(true);
    try {
      for (const e of sel) {
        const p = join(this.cwd, e.name);
        try {
          await goApp().IfsDelete(this.session, p, e.dir, false);
        } catch (err) {
          if (e.dir && /not empty/.test(errorText(err))) {
            if (!(await confirmDialog('Folder is not empty', `"${e.name}" contains files. Delete the folder and everything in it?`, 'Delete all'))) continue;
            await goApp().IfsDelete(this.session, p, true, true);
          } else {
            throw err;
          }
        }
      }
      this.host.notify(`Deleted ${what}`);
    } catch (err) {
      this.host.notify(errorText(err));
    } finally {
      this.setBusy(false);
      await this.go(this.cwd, false);
    }
  }

  private async run(action: () => Promise<unknown>, done: string): Promise<void> {
    this.setBusy(true);
    try {
      await action();
      this.host.notify(done);
    } catch (err) {
      this.host.notify(errorText(err));
    } finally {
      this.setBusy(false);
      await this.go(this.cwd, false);
    }
  }

  private async view(entry?: IfsEntry): Promise<void> {
    const e = entry ?? this.selection()[0];
    if (!e || e.dir) return;
    const p = join(this.cwd, e.name);
    this.setBusy(true);
    let text: string;
    try {
      text = await goApp().IfsReadText(this.session, p);
    } catch (err) {
      this.host.notify(errorText(err));
      return;
    } finally {
      this.setBusy(false);
    }
    const dialog = el('dialog', 'modal ifs-viewer');
    const form = el('form');
    form.method = 'dialog';
    form.append(el('h2', undefined, p), el('pre', undefined, text));
    const buttons = el('div', 'buttons');
    const copy = el('button', undefined, 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => void goApp().ClipboardSet(text).then(() => this.host.notify('Copied')));
    buttons.append(copy, el('button', 'primary', 'Close'));
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  }

  // ---- transfers ------------------------------------------------------------

  private beginTransfer(label: string): string {
    const id = `t${++transferCounter}`;
    this.progressEl.replaceChildren();
    const text = el('span', 'ifs-progress-text', label);
    const bar = el('div', 'ifs-progress-bar');
    const fill = el('div', 'fill');
    bar.append(fill);
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => void goApp().IfsCancel(id));
    this.progressEl.append(text, bar, cancel);
    this.progressEl.hidden = false;
    this.stopProgress?.();
    this.stopProgress = wailsRuntime().EventsOn('ifs:progress', (raw) => {
      const p = raw as IfsProgress;
      if (p.transfer !== id) return;
      const pct = p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 100;
      fill.style.width = `${pct.toFixed(1)}%`;
      text.textContent = `${label} ${p.filesNow}/${p.files} · ${formatSize(p.done)} of ${formatSize(p.total)}`;
    });
    return id;
  }

  private endTransfer(): void {
    this.stopProgress?.();
    this.stopProgress = undefined;
    this.progressEl.hidden = true;
  }

  private async download(): Promise<void> {
    const sel = this.selection();
    if (!sel.length) return;
    const id = this.beginTransfer('Downloading');
    try {
      const n = await goApp().IfsDownload(this.session, sel.map((e) => join(this.cwd, e.name)), id);
      if (n > 0) this.host.notify(`Downloaded ${n} file(s)`);
    } catch (err) {
      this.host.notify(errorText(err) === 'cancelled' ? 'Download cancelled' : errorText(err));
    } finally {
      this.endTransfer();
    }
  }

  /** Uploads local paths (or asks for files when empty) into the current folder. */
  async upload(paths: string[]): Promise<void> {
    if (!this.session || this.busy) return;
    const id = this.beginTransfer('Uploading');
    try {
      let n: number;
      try {
        n = await goApp().IfsUpload(this.session, this.cwd, paths, false, id);
      } catch (err) {
        const text = errorText(err);
        if (!text.startsWith('EXISTS: ')) throw err;
        const ok = await confirmDialog('Replace files?', `These already exist in ${this.cwd}: ${text.slice(8)}. Replace them?`, 'Replace');
        if (!ok) return;
        n = await goApp().IfsUpload(this.session, this.cwd, paths, true, id);
      }
      if (n > 0) this.host.notify(`Uploaded ${n} file(s) to ${this.cwd}`);
    } catch (err) {
      const text = errorText(err);
      if (text === 'cancelled') this.host.notify('Upload cancelled');
      else await messageDialog('Upload failed', [text]);
    } finally {
      this.endTransfer();
      await this.go(this.cwd, false);
    }
  }
}

/** Absolute, forward slashes, "." and ".." resolved, no trailing slash (like ifs.Clean in Go). */
export function normalise(p: string): string {
  const out: string[] = [];
  for (const part of p.trim().replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}
