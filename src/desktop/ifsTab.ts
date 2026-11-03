import { errorText, goApp, wailsRuntime, type IfsConnectRequest, type IfsEntry, type IfsProgress } from './bridge';
import { confirmDialog, messageDialog, promptDialog } from './dialogs';
import { IfsTreeModel, canMoveInto, crumbs, joinPath, parentPath, type TreeNode } from './ifsTree';
import { explainToolError } from './toolErrors';

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

const join = joinPath;
const parent = parentPath;
/** The MIME type of a drag that starts on our own rows (never set by the operating system). */
const DRAG_TYPE = 'application/x-tn5250-ifs';
/** Whether the folder tree pane is shown; remembered for the next tab of this run. */
let treeShown = true;

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
  private readonly crumbsEl: HTMLDivElement;
  private readonly treeEl: HTMLDivElement;
  private readonly treePane: HTMLDivElement;
  private readonly tree = new IfsTreeModel();
  private readonly body: HTMLTableSectionElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly progressEl: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  private stopProgress: (() => void) | undefined;

  constructor(
    private readonly host: IfsHost,
    private readonly request: IfsConnectRequest,
    /** Told whether the sign-on worked (error = why not). */
    private readonly onSignon?: (error?: unknown) => void,
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
    // The path: clickable segments; click the pencil (or press Ctrl+L) to type a path.
    const pathBox = el('div', 'ifs-pathbox');
    this.crumbsEl = el('div', 'ifs-crumbs');
    this.crumbsEl.title = 'Click a folder to go there';
    this.pathInput = el('input', 'ifs-path');
    this.pathInput.spellcheck = false;
    this.pathInput.hidden = true;
    this.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.editPath(false);
        void this.go(this.pathInput.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.editPath(false);
      }
    });
    this.pathInput.addEventListener('blur', () => this.editPath(false));
    const edit = el('button', 'ifs-path-edit', '\u270e');
    edit.type = 'button';
    edit.title = 'Type a path (Ctrl+L)';
    edit.addEventListener('click', () => this.editPath(true));
    pathBox.append(this.crumbsEl, this.pathInput, edit);
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
    bar.append(pathBox, fav);
    const actions = el('div', 'ifs-actions');
    actions.append(
      btn('tree', 'Folders', 'Show or hide the folder tree', () => this.toggleTree()),
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
    // Dropping rows on the blank part of the list moves nothing; dropping on a folder row does.
    scroller.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(DRAG_TYPE)) e.preventDefault();
    });

    // Folder tree on the left, a splitter, the list on the right.
    this.treePane = el('div', 'ifs-treepane');
    this.treeEl = el('div', 'ifs-tree');
    this.treeEl.setAttribute('role', 'tree');
    this.treePane.append(this.treeEl);
    this.treePane.hidden = !treeShown;
    const vsplit = el('div', 'ifs-vsplit');
    vsplit.title = 'Drag to resize';
    vsplit.hidden = !treeShown;
    vsplit.addEventListener('mousedown', (e) => this.startTreeResize(e));
    const main = el('div', 'ifs-main');
    main.append(this.treePane, vsplit, scroller);

    const foot = el('div', 'ifs-foot');
    this.statusEl = el('span', 'ifs-status', 'Connecting…');
    this.progressEl = el('div', 'ifs-progress');
    this.progressEl.hidden = true;
    foot.append(this.statusEl, this.progressEl);

    const top = el('div', 'ifs-top');
    top.append(bar, actions);
    this.frame.append(top, main, foot);
    this.frame.addEventListener('keydown', (e) => this.onKey(e));
    scroller.addEventListener('contextmenu', (e) => this.contextMenu(e));
    this.updateButtons();
    this.renderCrumbs();
    this.renderTree();
  }

  // ---- path, tree -------------------------------------------------------------

  private editPath(on: boolean): void {
    this.pathInput.hidden = !on;
    this.crumbsEl.hidden = on;
    if (on) {
      this.pathInput.value = this.cwd;
      this.pathInput.focus();
      this.pathInput.select();
    }
  }

  private renderCrumbs(): void {
    this.crumbsEl.replaceChildren();
    const list = crumbs(this.cwd);
    list.forEach((c, i) => {
      if (i > 0) this.crumbsEl.append(el('span', 'sep', '\u203a'));
      const b = el('button', `crumb${i === list.length - 1 ? ' current' : ''}`, c.name);
      b.type = 'button';
      b.dataset.path = c.path;
      b.title = c.path;
      b.addEventListener('click', () => void this.go(c.path));
      this.acceptDrops(b, c.path);
      this.crumbsEl.append(b);
    });
    // A click on the free space edits the path, as in a file manager.
    this.crumbsEl.onclick = (e) => {
      if (e.target === this.crumbsEl) this.editPath(true);
    };
  }

  private toggleTree(): void {
    treeShown = !treeShown;
    this.treePane.hidden = !treeShown;
    const split = this.treePane.nextElementSibling as HTMLElement | null;
    if (split) split.hidden = !treeShown;
    if (treeShown) this.renderTree();
  }

  private startTreeResize(e: MouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.treePane.getBoundingClientRect().width;
    const move = (ev: MouseEvent): void => {
      this.treePane.style.width = `${Math.max(120, Math.min(600, startW + ev.clientX - startX))}px`;
    };
    const up = (): void => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /** Lists the folders above the current one that the tree has only as placeholders (root first). */
  private async loadAncestors(): Promise<void> {
    if (this.treePane.hidden) return;
    for (const c of crumbs(this.cwd).slice(0, -1)) {
      const node = this.tree.find(c.path);
      if (node && !node.listed) await this.loadNode(node);
    }
  }

  /** Lists the sub-folders of a tree node that has not been listed yet. */
  private async loadNode(node: TreeNode): Promise<void> {
    if (!this.session || node.listed || node.loading) return;
    node.loading = true;
    this.renderTree();
    try {
      const list = await goApp().IfsList(this.session, node.path);
      this.tree.setChildren(node.path, list.filter((e) => e.dir).map((e) => e.name));
    } catch (err) {
      node.loading = false;
      node.error = errorText(err);
    }
    this.renderTree();
  }

  private renderTree(): void {
    if (this.treePane.hidden) return;
    this.treeEl.replaceChildren();
    for (const { node, depth } of this.tree.rows()) {
      const row = el('div', `ifs-node${node.path === this.cwd ? ' current' : ''}`);
      row.setAttribute('role', 'treeitem');
      row.dataset.path = node.path;
      row.style.paddingLeft = `${6 + depth * 14}px`;
      const arrow = el('span', 'arrow', node.loading ? '\u2026' : node.listed && !node.children?.length ? '' : node.expanded ? '\u25be' : '\u25b8');
      arrow.title = node.expanded ? 'Collapse' : 'Expand';
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.toggleNode(node);
      });
      const name = el('span', 'name', node.name);
      if (node.error) {
        row.classList.add('error');
        row.title = node.error;
      } else row.title = node.path;
      row.append(arrow, el('span', 'icon folder'), name);
      row.addEventListener('click', () => void this.go(node.path));
      row.addEventListener('dblclick', () => void this.toggleNode(node));
      row.addEventListener('contextmenu', (e) => this.contextMenu(e, node.path));
      this.acceptDrops(row, node.path);
      this.treeEl.append(row);
    }
  }

  private async toggleNode(node: TreeNode): Promise<void> {
    if (!node.listed) {
      node.expanded = true;
      await this.loadNode(node);
      return;
    }
    this.tree.toggle(node.path);
    this.renderTree();
  }

  // ---- drag and drop between folders ----------------------------------------------

  /** Makes an element a drop target for rows dragged from the list: dropping moves them into `target`. */
  private acceptDrops(elm: HTMLElement, target: string): void {
    elm.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      elm.classList.add('drop-target');
    });
    elm.addEventListener('dragleave', () => elm.classList.remove('drop-target'));
    elm.addEventListener('drop', (e) => {
      elm.classList.remove('drop-target');
      const raw = e.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      let paths: string[];
      try {
        paths = JSON.parse(raw) as string[];
      } catch {
        return;
      }
      void this.moveInto(paths, target);
    });
  }

  /** Moves items into a folder (a rename on the host); asks first. */
  async moveInto(paths: string[], target: string): Promise<void> {
    const movable = paths.filter((p) => canMoveInto(p, target));
    if (!movable.length || !this.session) return;
    const what = movable.length === 1 ? `"${movable[0]?.split('/').pop()}"` : `${movable.length} items`;
    if (!(await confirmDialog('Move', `Move ${what} to ${target}?`, 'Move'))) return;
    this.setBusy(true);
    let moved = 0;
    try {
      for (const p of movable) {
        await goApp().IfsRename(this.session, p, join(target, p.split('/').pop() ?? ''));
        moved++;
      }
      this.host.notify(`Moved ${moved} item(s) to ${target}`);
    } catch (err) {
      this.host.notify(`${moved ? `Moved ${moved}, then: ` : ''}${errorText(err)}`);
    } finally {
      this.setBusy(false);
      for (const p of movable) this.tree.forget(parent(p));
      this.tree.forget(target);
      await this.go(this.cwd, false);
    }
  }

  focus(): void {
    this.frame.focus();
  }

  async start(): Promise<void> {
    const { host, user, timeoutMs } = this.request;
    this.setBusy(true);
    this.statusEl.textContent = 'Connecting…';
    this.showLoading(`Signing on to ${host} as ${user.toUpperCase()}…`);
    const slow = setTimeout(
      () => this.showLoading(`Still signing on to ${host}… The network or VPN is slow; this gives up after ${Math.round(timeoutMs / 1000)} seconds.`),
      5000,
    );
    try {
      this.session = await goApp().IfsConnect(this.request);
      this.messageEl.hidden = true;
      this.host.log(`[IFS ${this.request.host}] signed on as ${this.request.user.toUpperCase()}`);
      this.onSignon?.();
      await this.go(`/home/${this.request.user.toUpperCase()}`, false, true);
    } catch (err) {
      const raw = errorText(err);
      // A refused sign-on is not retried with the same password (the host counts failed
      // attempts and may disable the profile); the shell asks for the password again.
      const refused = /sign-on refused/i.test(raw);
      const why = explainToolError('IFS', host, raw);
      this.showMessage(`Could not open the IFS on ${host}: ${why.message}${why.hint ? ` ${why.hint}` : ''}`, !refused);
      this.statusEl.textContent = 'Not connected';
      this.onSignon?.(err);
    } finally {
      clearTimeout(slow);
      this.setBusy(false);
    }
  }

  /** The centre message with a moving bar, while signing on. */
  private showLoading(text: string): void {
    this.messageEl.replaceChildren(el('div', 'ifs-loader'), el('p', undefined, text));
    this.messageEl.hidden = false;
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
      this.tree.setChildren(this.cwd, list.filter((e) => e.dir).map((e) => e.name)).expanded = true;
      this.render();
      void this.loadAncestors();
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
    this.renderCrumbs();
    this.renderTree();
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
      // Rows can be dragged onto a folder row, a tree node or a path segment to move them.
      tr.draggable = true;
      tr.addEventListener('dragstart', (ev) => {
        if (!this.selected.has(e.name)) {
          this.selected = new Set([e.name]);
          this.anchor = e.name;
          for (const r of this.body.rows) r.classList.toggle('selected', r === tr);
        }
        const paths = this.selection().map((s) => join(this.cwd, s.name));
        ev.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(paths));
        ev.dataTransfer?.setData('text/plain', paths.join('\n'));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      if (e.dir) this.acceptDrops(tr, join(this.cwd, e.name));
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
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      this.editPath(true);
    } else if (e.key === 'F5') {
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

  private contextMenu(e: MouseEvent, folder?: string): void {
    e.preventDefault();
    e.stopPropagation();
    document.querySelector('.ifs-menu')?.remove();
    const menu = el('div', 'ifs-menu');
    if (folder !== undefined) {
      // A tree node: the menu is about that folder.
      const item = (text: string, run: () => void): void => {
        const b = el('button', undefined, text);
        b.type = 'button';
        b.addEventListener('click', () => {
          menu.remove();
          run();
        });
        menu.append(b);
      };
      item('Open', () => void this.go(folder));
      item('Refresh', () => {
        this.tree.forget(folder);
        const node = this.tree.find(folder);
        if (node) void this.loadNode(node);
      });
      item('Copy path', () => void goApp().ClipboardSet(folder));
      this.placeMenu(menu, e);
      return;
    }
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
    this.placeMenu(menu, e);
  }

  private placeMenu(menu: HTMLElement, e: MouseEvent): void {
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
    this.tree.forget(this.cwd);
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
