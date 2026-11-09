import { errorText, goApp } from './bridge';
import { choiceDialog, confirmDialog } from './dialogs';
import { actionButton } from './icons';
import { ENCODINGS, HEX, decodeIfs, ebcdicLineEnd, encodeIfs, encodingLabel, fromBase64, guessCcsid, hexDump, isBinary, keepBom, toBase64 } from './ifsText';
import { formatSize } from './ifsTab';

export interface IfsViewHost {
  notify(text: string): void;
  /** A line for the Session Log (what was read and how it is decoded). */
  log?(line: string): void;
  changed(tab: IfsViewTab): void;
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
 * A stream file in its own tab: text decoded by the file's CCSID (or one you pick), line
 * numbers, Find, wrap, Copy, an Edit mode that saves back in the file's CCSID, Save as… with
 * a UTF-8 option, and a hex dump for binary files.
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

  private readonly area: HTMLTextAreaElement;
  private readonly gutter: HTMLDivElement;
  private readonly encodingSel: HTMLSelectElement;
  private readonly findBar: HTMLDivElement;
  private readonly findInput: HTMLInputElement;
  private readonly findCount: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  private findAt = -1;

  constructor(
    private readonly host: IfsViewHost,
    readonly sessionId: string,
    readonly path: string,
    private info: IfsFileInfo,
  ) {
    this.title = path.split('/').pop() || path;
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
    this.encodingSel.title = 'How the bytes are read (the file says, unless you pick)';
    for (const e of ENCODINGS) {
      const o = el('option', undefined, e.label);
      o.value = String(e.ccsid);
      this.encodingSel.append(o);
    }
    const hex = el('option', undefined, encodingLabel(HEX));
    hex.value = String(HEX);
    this.encodingSel.append(hex);
    this.encodingSel.addEventListener('change', () => this.setEncoding(Number(this.encodingSel.value)));
    bar.append(
      btn('reload', 'refresh', 'blue', 'Read the file again (F5)', () => void this.load()),
      btn('edit', 'pencil', 'yellow', 'Edit (then Save writes it back to the host)', () => this.toggleEdit()),
      btn('save', 'save', 'green', 'Save to the host (Ctrl+S)', () => void this.save()),
      btn('saveAs', 'exportFile', 'blue', 'Save as… on this computer (as it is, or converted to UTF-8)', () => void this.saveAs()),
      btn('copy', 'copy', 'blue', 'Copy all', () => void this.copyAll()),
      btn('find', 'find', 'blue', 'Find (Ctrl+F)', () => this.toggleFind()),
      btn('wrap', 'wrap', 'blue', 'Wrap long lines', () => this.toggleWrap()),
      this.encodingSel,
    );
    top.append(bar);

    this.findBar = el('div', 'ifsv-find');
    this.findBar.hidden = true;
    this.findInput = el('input', 'ifsv-find-input');
    this.findInput.placeholder = 'Find…';
    this.findInput.spellcheck = false;
    this.findInput.addEventListener('input', () => this.find(0));
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.find(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.toggleFind(false);
      }
    });
    this.findCount = el('span', 'ifsv-find-count');
    const prev = el('button', 'ifsv-find-nav', '↑');
    prev.type = 'button';
    prev.title = 'Previous (Shift+Enter)';
    prev.addEventListener('click', () => this.find(-1));
    const next = el('button', 'ifsv-find-nav', '↓');
    next.type = 'button';
    next.title = 'Next (Enter, F3)';
    next.addEventListener('click', () => this.find(1));
    this.findBar.append(this.findInput, prev, next, this.findCount);

    this.bannerEl = el('div', 'ifsv-banner');
    this.bannerEl.hidden = true;

    const body = el('div', 'ifsv-body');
    this.gutter = el('div', 'ifsv-gutter');
    this.area = el('textarea', 'ifsv-text');
    this.area.readOnly = true;
    this.area.spellcheck = false;
    this.area.wrap = 'off';
    this.area.addEventListener('scroll', () => (this.gutter.style.transform = `translateY(${-this.area.scrollTop}px)`));
    this.area.addEventListener('input', () => {
      this.text = this.area.value;
      this.setDirty(true);
      this.renderGutter();
    });
    body.append(this.gutter, this.area);

    const foot = el('div', 'ifs-foot');
    this.statusEl = el('span', 'ifs-status', 'Loading…');
    foot.append(this.statusEl);

    this.frame.append(top, this.findBar, this.bannerEl, body, foot);
    this.frame.addEventListener('keydown', (e) => this.onKey(e));
    this.updateButtons();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  focus(): void {
    this.area.focus();
  }

  dispose(): void {
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
      this.host.log?.(`Viewer: ${this.path}: ${this.bytes.length} bytes, file says CCSID ${this.reported || 'unknown'}, reading as ${encodingLabel(this.ccsid)}${this.binary ? ', shown as hex' : ''}`);
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
    this.area.value = this.text;
    this.area.readOnly = !this.editing;
    this.area.classList.toggle('editing', this.editing);
    this.area.classList.toggle('hex', this.binary);
    this.renderGutter();
    this.renderStatus();
    this.updateButtons();
    this.findAt = -1;
    if (!this.findBar.hidden) this.find(0);
  }

  private renderGutter(): void {
    const lines = this.text.length ? this.text.split('\n').length : 1;
    const nums: string[] = [];
    for (let i = 1; i <= lines; i++) nums.push(String(i));
    this.gutter.textContent = nums.join('\n');
    this.gutter.hidden = this.binary || this.wrap;
  }

  private renderStatus(): void {
    const enc = this.binary ? `binary (hex)${this.reported ? ` (file says ${this.reported})` : ''}` : encodingLabel(this.ccsid) + (this.reported === this.ccsid ? '' : this.reported ? ` (file says ${this.reported})` : ' (guessed)');
    const lines = this.binary ? '' : ` · ${this.text.split('\n').length} lines`;
    this.statusEl.textContent = `${this.path} · ${formatSize(this.size)}${lines} · ${enc}${this.dirty ? ' · modified' : ''}`;
    this.bannerEl.hidden = !this.truncated;
    if (this.truncated) this.bannerEl.textContent = `Showing the first ${formatSize(this.bytes.length)} of ${formatSize(this.size)}. Editing is off; use Save as… or Download for the whole file.`;
  }

  private updateButtons(): void {
    const set = (k: string, enabled: boolean, pressed?: boolean): void => {
      const b = this.buttons[k];
      if (!b) return;
      b.disabled = !enabled;
      if (pressed !== undefined) b.classList.toggle('pressed', pressed);
    };
    const text = !this.binary;
    set('edit', text && !this.truncated, this.editing);
    set('save', this.editing && this.dirty);
    set('saveAs', this.bytes.length > 0);
    set('copy', this.bytes.length > 0);
    set('find', text, !this.findBar.hidden);
    set('wrap', text, this.wrap);
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
    this.area.readOnly = !this.editing;
    this.area.classList.toggle('editing', this.editing);
    this.updateButtons();
    if (this.editing) this.area.focus();
  }

  private toggleWrap(): void {
    this.wrap = !this.wrap;
    this.area.wrap = this.wrap ? 'soft' : 'off';
    this.renderGutter();
    this.updateButtons();
  }

  private toggleFind(on = this.findBar.hidden): void {
    this.findBar.hidden = !on;
    this.updateButtons();
    if (on) {
      this.findInput.focus();
      this.findInput.select();
      this.find(0);
    } else this.area.focus();
  }

  /** Counts the matches and selects the next (+1), previous (-1) or current (0) one. */
  find(step: number): void {
    const needle = this.findInput.value;
    if (!needle) {
      this.findCount.textContent = '';
      this.findAt = -1;
      return;
    }
    const hay = this.text.toLowerCase();
    const n = needle.toLowerCase();
    const positions: number[] = [];
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) positions.push(i);
    if (!positions.length) {
      this.findCount.textContent = 'No matches';
      this.findAt = -1;
      return;
    }
    let idx = positions.findIndex((p) => p >= (this.findAt < 0 ? 0 : this.findAt));
    if (idx < 0) idx = 0;
    if (step > 0 && positions[idx] === this.findAt) idx = (idx + 1) % positions.length;
    if (step < 0) idx = (idx - 1 + positions.length) % positions.length;
    const at = positions[idx] as number;
    this.findAt = at;
    this.findCount.textContent = `${idx + 1} of ${positions.length}`;
    this.area.setSelectionRange(at, at + needle.length);
    this.scrollToSelection(at);
  }

  private scrollToSelection(at: number): void {
    // One line per 18 px is close enough to bring the match into view; exact layout is not available.
    const line = this.text.slice(0, at).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(this.area).lineHeight) || 18;
    this.area.scrollTop = Math.max(0, line * lineHeight - this.area.clientHeight / 2);
    this.gutter.style.transform = `translateY(${-this.area.scrollTop}px)`;
  }

  private async copyAll(): Promise<void> {
    await goApp().ClipboardSet(this.text);
    this.host.notify('Copied');
  }

  /** Writes the text back in the file's CCSID, after checking nobody changed it meanwhile. */
  async save(): Promise<void> {
    if (!this.editing || !this.dirty) return;
    const ccsid = this.ccsid;
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
      this.setDirty(false);
      this.renderStatus();
      this.host.notify(`Saved ${name} (${formatSize(bytes.length)}, ${encodingLabel(ccsid)})`);
    } catch (err) {
      this.host.notify(`Save failed: ${errorText(err)}`);
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
    const choice = await choiceDialog('Save as', [`${name} is read as ${encodingLabel(this.ccsid)}.`, 'Save the bytes as they are on the host, or convert the text to UTF-8 so PC programs read it.'], ['As on the host', 'Convert to UTF-8']);
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

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.toggleFind(true);
    } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.save();
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (this.findBar.hidden) this.toggleFind(true);
      else this.find(e.shiftKey ? -1 : 1);
    } else if (e.key === 'F5') {
      e.preventDefault();
      void this.load();
    } else if (e.key === 'Escape' && !this.findBar.hidden) {
      e.preventDefault();
      this.toggleFind(false);
    }
  }
}
