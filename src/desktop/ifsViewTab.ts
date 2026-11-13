import { errorText, goApp } from './bridge';
import { CodeEditor } from './codeEditor';
import { CsvGrid } from './csvGrid';
import { choiceDialog, confirmDialog, promptDialog } from './dialogs';
import { actionButton } from './icons';
import { formatSize } from './ifsTab';
import { ENCODINGS, HEX, canEncode, decodeIfs, ebcdicLineEnd, encodeIfs, encodingLabel, fromBase64, guessCcsid, hexDump, isBinary, keepBom, toBase64 } from './ifsText';
import { languageFor, type FileLanguage } from './langModes';

export interface IfsViewHost {
  notify(text: string): void;
  /** A line for the Session Log (what was read and how it is decoded). */
  log?(line: string): void;
  changed(tab: IfsViewTab): void;
  /** Opens another file of the same session in a viewer tab (after Save as… on the host). */
  openPath?(sessionId: string, path: string, info: IfsFileInfo): void;
}

/** What the browser knew about the file when it opened it: a save checks the host still agrees. */
export interface IfsFileInfo {
  size: number;
  modified: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** How much of a file the viewer loads; more is downloaded, not edited in place. */
export const VIEW_LIMIT = 8 * 1024 * 1024;

/**
 * A stream file in its own tab: text decoded by the file's CCSID (or one you pick) in a
 * code editor coloured for its language (JSON, Python, SQL, CL, RPG, batch, ...), a grid
 * for CSV files, line numbers, Find, wrap, Copy, an Edit mode that saves back in the file's
 * CCSID, Save as… on the host, Download a copy, and a hex dump for binary files.
 */
export class IfsViewTab {
  readonly frame: HTMLDivElement;
  title: string;
  private bytes: Uint8Array = new Uint8Array();
  /** The CCSID the server reported (0 = unknown). */
  private reported = 0;
  /** The CCSID in use: the reported one, a guess, or the user's pick. */
  private ccsid = 1208;
  private text = '';
  private binary = false;
  private truncated = false;
  private size = 0;
  private editing = false;
  private dirty = false;
  private wrap = false;
  private readonly language: FileLanguage;
  /** CSV files: the grid, or the text to edit. */
  private mode: 'grid' | 'text';

  private readonly editor: CodeEditor;
  private readonly csv: CsvGrid | undefined;
  private readonly encodingSel: HTMLSelectElement;
  private readonly modeSel: HTMLSelectElement | undefined;
  private readonly statusEl: HTMLSpanElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly buttons: Record<string, HTMLButtonElement> = {};

  constructor(
    private readonly host: IfsViewHost,
    readonly sessionId: string,
    readonly path: string,
    private info: IfsFileInfo,
  ) {
    this.title = path.split('/').pop() || path;
    this.language = languageFor(this.title);
    this.mode = this.language.kind === 'csv' ? 'grid' : 'text';
    this.frame = el('div', 'terminal-frame ifs ifs-view');
    this.frame.tabIndex = -1;

    const top = el('div', 'ifs-top icon-actions');
    const bar = el('div', 'ifsv-bar');
    const btn = (key: string, icon: Parameters<typeof actionButton>[0], tone: Parameters<typeof actionButton>[2], title: string, run: () => void): HTMLButtonElement => {
      const b = actionButton(icon, title, tone);
      b.addEventListener('click', run);
      this.buttons[key] = b;
      return b;
    };
    this.encodingSel = el('select', 'ifsv-encoding');
    this.encodingSel.title = 'Read the bytes as';
    for (const e of ENCODINGS) {
      const o = el('option', undefined, e.readOnly ? `${e.label} (read only)` : e.label);
      o.value = String(e.ccsid);
      this.encodingSel.append(o);
    }
    const hex = el('option', undefined, 'Bytes (hex)');
    hex.value = String(HEX);
    this.encodingSel.append(hex);
    this.encodingSel.addEventListener('change', () => this.setEncoding(Number(this.encodingSel.value)));
    bar.append(
      btn('reload', 'refresh', 'blue', 'Read the file again (F5)', () => void this.load()),
      btn('edit', 'pencil', 'yellow', 'Edit (then Save writes it back to the host)', () => this.toggleEdit()),
      btn('save', 'save', 'green', 'Save to the host (Ctrl+S)', () => void this.save()),
      btn('saveAsHost', 'saveAs', 'green', 'Save as… under another name or folder on the host', () => void this.saveAsHost()),
      btn('saveAs', 'importFile', 'blue', 'Download a copy to this computer (as it is, or converted to UTF-8)', () => void this.saveAs()),
      btn('copy', 'copy', 'blue', 'Copy all', () => void this.copyAll()),
      btn('find', 'find', 'blue', 'Find (Ctrl+F; F3 next, Shift+F3 previous)', () => this.openFind()),
      btn('wrap', 'wrap', 'blue', 'Wrap long lines', () => this.toggleWrap()),
      this.encodingSel,
    );
    if (this.language.kind === 'csv') {
      this.modeSel = el('select', 'ifsv-mode');
      this.modeSel.title = 'Grid: the rows with a filter per column. Text: the file as it is, to edit.';
      for (const [v, t] of [['grid', 'Grid'], ['text', 'Text']] as const) {
        const o = el('option', undefined, t);
        o.value = v;
        this.modeSel.append(o);
      }
      this.modeSel.addEventListener('change', () => this.setMode(this.modeSel!.value as 'grid' | 'text'));
      bar.append(this.modeSel);
    }
    top.append(bar);

    this.bannerEl = el('div', 'ifsv-banner');
    this.bannerEl.hidden = true;

    const body = el('div', 'ifsv-body');
    this.editor = new CodeEditor({
      readOnly: true,
      language: this.language.extension,
      onChange: () => {
        this.text = this.editor.value;
        this.setDirty(true);
      },
      keys: {
        'Mod-s': () => void this.save(),
        F5: () => void this.load(),
        F3: () => this.editor.findNext(),
        'Shift-F3': () => this.editor.findPrevious(),
      },
    });
    body.append(this.editor.element);
    if (this.language.kind === 'csv') {
      this.csv = new CsvGrid((text) => void goApp().ClipboardSet(text).then(() => this.host.notify('Copied')));
      body.append(this.csv.element);
    }

    const foot = el('div', 'ifs-foot');
    this.statusEl = el('span', 'ifs-status', 'Loading…');
    foot.append(this.statusEl);

    this.frame.append(top, this.bannerEl, body, foot);
    this.frame.addEventListener('keydown', (e) => this.onKey(e));
    this.showMode();
    this.updateButtons();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  focus(): void {
    this.editor.focus();
  }

  dispose(): void {
    this.editor.destroy();
    this.frame.remove();
  }

  /** Reads the file from the host and shows it. */
  async load(): Promise<void> {
    if (this.dirty && !(await confirmDialog('Discard changes?', 'Reading the file again drops what you changed here.', 'Discard'))) return;
    this.statusEl.textContent = 'Loading…';
    this.frame.classList.add('busy');
    try {
      const r = await goApp().IfsReadBytes(this.sessionId, this.path, VIEW_LIMIT);
      this.bytes = fromBase64(r.data);
      this.reported = r.ccsid;
      this.size = r.size;
      this.truncated = r.truncated;
      this.ccsid = guessCcsid(this.bytes, this.reported);
      this.binary = isBinary(this.bytes, this.ccsid);
      this.editing = false;
      this.setDirty(false);
      this.decode();
      this.host.log?.(`Viewer: ${this.path}: ${this.bytes.length} bytes, file says CCSID ${this.reported || 'unknown'}, reading as ${encodingLabel(this.ccsid)}${this.binary ? ', shown as hex' : ''}${this.language.kind !== 'plain' ? `, ${this.language.name}` : ''}`);
    } catch (err) {
      this.statusEl.textContent = 'Could not read the file';
      this.host.notify(errorText(err));
      this.host.log?.(`Viewer: ${this.path}: ${errorText(err)}`);
    } finally {
      this.frame.classList.remove('busy');
    }
  }

  private decode(): void {
    this.encodingSel.value = String(this.binary ? HEX : this.ccsid);
    this.text = this.binary ? hexDump(this.bytes) : decodeIfs(this.bytes, this.ccsid);
    this.editor.setLanguage(this.binary ? undefined : this.language.extension);
    this.editor.value = this.text;
    this.editor.setReadOnly(!this.editing);
    this.editor.element.classList.toggle('editing', this.editing);
    this.editor.element.classList.toggle('hex', this.binary);
    if (this.csv && !this.binary) this.csv.setText(this.text);
    this.showMode();
    this.renderStatus();
    this.updateButtons();
  }

  private renderStatus(): void {
    const enc = this.binary ? `binary (hex)${this.reported ? ` (file says ${this.reported})` : ''}` : encodingLabel(this.ccsid) + (this.reported === this.ccsid ? '' : this.reported ? ` (file says ${this.reported})` : ' (guessed)');
    const lines = this.binary ? '' : ` · ${this.text.split('\n').length} lines`;
    const lang = this.binary || this.language.kind === 'plain' ? '' : ` · ${this.language.name}`;
    this.statusEl.textContent = `${this.path} · ${formatSize(this.size)}${lines} · ${enc}${lang}${this.dirty ? ' · modified' : ''}`;
    this.bannerEl.hidden = !this.truncated;
    if (this.truncated) this.bannerEl.textContent = `Showing the first ${formatSize(this.bytes.length)} of ${formatSize(this.size)}. Editing is off; use Download for the whole file.`;
  }

  private updateButtons(): void {
    const set = (k: string, enabled: boolean, pressed?: boolean): void => {
      const b = this.buttons[k];
      if (!b) return;
      b.disabled = !enabled;
      if (pressed !== undefined) b.classList.toggle('pressed', pressed);
    };
    const text = !this.binary;
    const writable = text && canEncode(this.ccsid);
    set('edit', writable && !this.truncated, this.editing);
    set('save', this.editing && this.dirty);
    set('saveAsHost', writable && !this.truncated && this.bytes.length > 0);
    set('saveAs', this.bytes.length > 0);
    set('copy', this.bytes.length > 0);
    set('find', text && this.mode === 'text');
    set('wrap', text && this.mode === 'text', this.wrap);
    this.encodingSel.disabled = this.dirty;
  }

  private setDirty(d: boolean): void {
    if (this.dirty === d) return;
    this.dirty = d;
    this.title = `${d ? '● ' : ''}${this.path.split('/').pop() || this.path}`;
    this.renderStatus();
    this.updateButtons();
    this.host.changed(this);
  }

  private setEncoding(ccsid: number): void {
    if (this.dirty) return;
    if (ccsid === HEX) this.binary = true;
    else {
      this.ccsid = ccsid;
      this.binary = isBinary(this.bytes, ccsid);
    }
    this.decode();
  }

  /** CSV files: the grid or the text; editing always happens in the text. */
  private setMode(mode: 'grid' | 'text'): void {
    this.mode = mode;
    if (this.modeSel) this.modeSel.value = mode;
    this.showMode();
    this.updateButtons();
  }

  private showMode(): void {
    const grid = !!this.csv && this.mode === 'grid' && !this.binary;
    if (this.csv) this.csv.element.hidden = !grid;
    this.editor.element.hidden = grid;
  }

  private toggleEdit(): void {
    if (this.editing && this.dirty) {
      void confirmDialog('Stop editing?', 'Your changes are not saved to the host. Drop them?', 'Drop changes').then((ok) => {
        if (!ok) return;
        this.editing = false;
        this.setDirty(false);
        this.decode();
      });
      return;
    }
    this.editing = !this.editing;
    if (this.editing && this.mode === 'grid') this.setMode('text');
    this.editor.setReadOnly(!this.editing);
    this.editor.element.classList.toggle('editing', this.editing);
    this.updateButtons();
    if (this.editing) this.editor.focus();
  }

  private toggleWrap(): void {
    this.wrap = !this.wrap;
    this.editor.setWrap(this.wrap);
    this.updateButtons();
  }

  private openFind(): void {
    if (this.mode === 'grid') this.setMode('text');
    this.editor.openFind();
  }

  private async copyAll(): Promise<void> {
    await goApp().ClipboardSet(this.text);
    this.host.notify('Copied');
  }

  /** Writes the text back in the file's CCSID, after checking nobody changed it meanwhile. */
  async save(): Promise<void> {
    if (!this.editing || !this.dirty) return;
    const ccsid = this.ccsid;
    if (!canEncode(ccsid)) {
      this.host.notify(`${encodingLabel(ccsid)} can be read here but not written; pick UTF-8 or another page before editing.`);
      return;
    }
    if (!this.reported && !(await confirmDialog('Save in which code page?', `The host did not say what code page this file is in; it will be written as ${encodingLabel(ccsid)} (the one shown). Save?`, 'Save'))) return;
    try {
      const dir = this.path.slice(0, this.path.lastIndexOf('/')) || '/';
      const name = this.path.split('/').pop() ?? '';
      const now = (await goApp().IfsList(this.sessionId, dir)).find((e) => e.name === name);
      if (now && (now.size !== this.info.size || now.modified !== this.info.modified)) {
        const ok = await confirmDialog('The file changed on the host', `${name} was modified since you opened it (${formatSize(now.size)}, ${new Date(now.modified).toLocaleString()}). Overwrite it anyway?`, 'Overwrite');
        if (!ok) return;
      }
      const bytes = keepBom(encodeIfs(this.text, ccsid, ebcdicLineEnd(this.bytes)), this.bytes, ccsid);
      await goApp().IfsWriteBytes(this.sessionId, this.path, toBase64(bytes), ccsid, true);
      this.bytes = bytes;
      this.size = bytes.length;
      const after = (await goApp().IfsList(this.sessionId, dir)).find((e) => e.name === name);
      if (after) this.info = { size: after.size, modified: after.modified };
      if (this.csv) this.csv.setText(this.text);
      this.setDirty(false);
      this.renderStatus();
      this.host.notify(`Saved ${name} (${formatSize(bytes.length)}, ${encodingLabel(ccsid)})`);
    } catch (err) {
      this.host.notify(`Save failed: ${errorText(err)}`);
    }
  }

  /** Writes the text (as shown, edited or not) to another path on the host, in the same code page, and opens it. */
  async saveAsHost(): Promise<void> {
    if (this.binary) {
      this.host.notify('A binary file cannot be saved as text; download it and upload it under the new name.');
      return;
    }
    if (this.truncated) {
      this.host.notify('Only part of the file is loaded; Save as… needs the whole file.');
      return;
    }
    if (!canEncode(this.ccsid)) {
      this.host.notify(`${encodingLabel(this.ccsid)} can be read here but not written; pick UTF-8 or another page first.`);
      return;
    }
    const target = await promptDialog('Save as… on the host', 'Full path of the new file', { value: this.path, note: `Written as ${encodingLabel(this.ccsid)}, the code page shown; the folder must already exist.` });
    const p = target?.trim();
    if (!p || p === this.path) return;
    if (!p.startsWith('/')) {
      this.host.notify('Give the full path, starting with /.');
      return;
    }
    const dir = p.slice(0, p.lastIndexOf('/')) || '/';
    const name = p.split('/').pop() ?? '';
    try {
      const siblings = await goApp().IfsList(this.sessionId, dir);
      const there = siblings.find((e) => e.name === name);
      if (there?.dir) {
        this.host.notify(`${p} is a folder.`);
        return;
      }
      if (there && !(await confirmDialog('File exists', `${name} is already in ${dir} (${formatSize(there.size)}, ${new Date(there.modified).toLocaleString()}). Overwrite it?`, 'Overwrite'))) return;
      const ccsid = this.ccsid;
      const bytes = keepBom(encodeIfs(this.text, ccsid, ebcdicLineEnd(this.bytes)), this.bytes, ccsid);
      await goApp().IfsWriteBytes(this.sessionId, p, toBase64(bytes), ccsid, true);
      const after = (await goApp().IfsList(this.sessionId, dir)).find((e) => e.name === name);
      this.host.notify(`Saved ${p} (${formatSize(bytes.length)}, ${encodingLabel(ccsid)})`);
      this.host.openPath?.(this.sessionId, p, { size: after?.size ?? bytes.length, modified: after?.modified ?? new Date().toISOString() });
    } catch (err) {
      this.host.notify(`Save as failed: ${errorText(err)}`);
    }
  }

  /** Saves a copy on this computer: the bytes as they are, or the text converted to UTF-8. */
  async saveAs(): Promise<void> {
    const name = this.path.split('/').pop() ?? 'file';
    const app = goApp();
    if (this.binary) {
      await this.downloadRaw();
      return;
    }
    const choice = await choiceDialog('Download a copy', [`${name} is read as ${encodingLabel(this.ccsid)}.`, 'Save the bytes as they are on the host, or convert the text to UTF-8 so PC programs read it.'], ['As on the host', 'Convert to UTF-8']);
    if (!choice) return;
    if (choice === 'As on the host') {
      await this.downloadRaw();
      return;
    }
    if (this.truncated) {
      this.host.notify('Only part of the file is loaded; the conversion needs the whole file. Download it instead.');
      return;
    }
    const saved = await app.SaveTextFile(`Save ${name} as UTF-8`, name, this.text, [{ name: 'Text', patterns: '*.*' }]);
    if (saved) this.host.notify(`Saved ${name} as UTF-8`);
  }

  private async downloadRaw(): Promise<void> {
    try {
      const n = await goApp().IfsDownload(this.sessionId, [this.path], `view-${Date.now()}`);
      if (n > 0) this.host.notify('Downloaded');
    } catch (err) {
      this.host.notify(errorText(err));
    }
  }

  /** Keys outside the editor (the editor binds its own: Ctrl+F, F3, Ctrl+S, F5). */
  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement | null)?.closest('.cm-editor')) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.openFind();
    } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) this.editor.findPrevious();
      else this.editor.findNext();
    } else if (e.key === 'F5') {
      e.preventDefault();
      void this.load();
    }
  }
}
