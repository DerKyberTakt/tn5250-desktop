import { errorText, goApp, type SqlConnectRequest, type SqlResult } from './bridge';
import { explainToolError } from './toolErrors';

export interface ConsoleHost {
  notify(text: string): void;
  log(line: string): void;
  changed(tab: ConsoleTab): void;
}

export type ConsoleMode = 'cl' | 'qsh';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const HISTORY_LIMIT = 200;
const OUTPUT_LIMIT = 4000; // lines kept on screen

/**
 * A console for CL commands (remote command server) and Qshell, like a 5250 command
 * line without the screen: type, Enter, read the messages or the output.
 */
export class ConsoleTab {
  readonly frame: HTMLDivElement;
  title: string;
  private connection = '';
  private busy = false;
  private readonly history: string[] = [];
  private historyPos = -1;
  private draft = '';
  private readonly output: HTMLPreElement;
  private readonly input: HTMLInputElement;
  private readonly prompt: HTMLSpanElement;
  private readonly connEl: HTMLSpanElement;
  private readonly modeButtons: Record<ConsoleMode, HTMLButtonElement>;

  constructor(
    private readonly host: ConsoleHost,
    private readonly request: SqlConnectRequest,
    private mode: ConsoleMode,
    private readonly onSignon?: (error?: unknown) => void,
  ) {
    this.title = `${mode === 'qsh' ? 'QSH' : 'CL'} - ${request.host}`;
    this.frame = el('div', 'terminal-frame console');
    this.frame.tabIndex = -1;

    const top = el('div', 'console-top');
    const modes = el('div', 'group');
    const modeBtn = (m: ConsoleMode, label: string, title: string): HTMLButtonElement => {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => this.setMode(m));
      modes.append(b);
      return b;
    };
    this.modeButtons = {
      cl: modeBtn('cl', 'CL', 'CL commands through the remote command server (as a job would run them)'),
      qsh: modeBtn('qsh', 'QSH', 'Qshell: the command runs with QSH CMD(...) and its output comes back here'),
    };
    const tools = el('div', 'group');
    const tool = (label: string, title: string, run: () => void): void => {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', run);
      tools.append(b);
    };
    tool('Clear', 'Clear the output (Ctrl+L)', () => this.clear());
    tool('Copy', 'Copy the whole output', () => void goApp().ClipboardSet(this.output.textContent ?? '').then(() => host.notify('Output copied')));
    this.connEl = el('span', 'conn', `${request.user.toUpperCase()}@${request.host} · not connected`);
    top.append(modes, el('span', 'sep'), tools, this.connEl);

    this.output = el('pre', 'console-output');
    this.output.setAttribute('aria-live', 'polite');

    const line = el('div', 'console-line');
    this.prompt = el('span', 'console-prompt');
    this.input = el('input', 'console-input');
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    line.append(this.prompt, this.input);
    line.addEventListener('mousedown', (e) => {
      if (e.target !== this.input) {
        e.preventDefault();
        this.input.focus();
      }
    });

    this.frame.append(top, this.output, line);
    this.setMode(mode, false);
  }

  focus(): void {
    this.input.focus();
  }

  async start(): Promise<void> {
    this.print('info', `${this.mode === 'qsh' ? 'Qshell' : 'CL'} console for ${this.request.host}. Enter runs a command; ↑/↓ walk the history; Ctrl+L clears.`);
    await this.connect();
  }

  dispose(): void {
    if (this.connection) void goApp().SqlClose(this.connection);
    this.frame.remove();
  }

  setMode(mode: ConsoleMode, announce = true): void {
    this.mode = mode;
    for (const [m, b] of Object.entries(this.modeButtons)) b.setAttribute('aria-pressed', String(m === mode));
    this.prompt.textContent = mode === 'qsh' ? '$ ' : 'CL> ';
    this.input.placeholder = mode === 'qsh' ? 'ls -la /home' : 'DSPLIBL';
    const title = `${mode === 'qsh' ? 'QSH' : 'CL'} - ${this.request.host}`;
    if (title !== this.title) {
      this.title = title;
      this.host.changed(this);
    }
    if (announce) this.print('info', mode === 'qsh' ? 'Qshell mode.' : 'CL mode.');
    this.input.focus();
  }

  // ---- connection --------------------------------------------------------------

  private async connect(): Promise<boolean> {
    if (this.connection) return true;
    this.setBusy(true);
    try {
      this.connection = await goApp().SqlConnect(this.request);
      this.connEl.textContent = `${this.request.user.toUpperCase()}@${this.request.host}`;
      this.host.log(`[Console ${this.request.host}] signed on as ${this.request.user.toUpperCase()}`);
      this.onSignon?.();
      return true;
    } catch (err) {
      const why = explainToolError(this.mode === 'qsh' ? 'QSH' : 'CL', this.request.host, errorText(err));
      this.print('error', `Could not connect: ${why.message}${why.hint ? `\n${why.hint}` : ''}`);
      this.onSignon?.(err);
      return false;
    } finally {
      this.setBusy(false);
    }
  }

  // ---- running -------------------------------------------------------------------

  private async run(command: string): Promise<void> {
    const text = command.trim();
    if (!text || this.busy) return;
    this.remember(text);
    this.print('cmd', `${this.prompt.textContent}${text}`);
    if (!(await this.connect())) return;
    this.setBusy(true);
    try {
      const r: SqlResult = this.mode === 'qsh' ? await goApp().QshRun(this.connection, text) : await goApp().CmdRun(this.connection, text);
      for (const m of r.messages) {
        const sev = m.severity ? ` (${m.severity})` : '';
        this.print(r.kind === 'error' && m === r.messages[r.messages.length - 1] ? 'error' : 'msg', m.id ? `${m.id}${sev}: ${m.text}` : m.text);
      }
      // Qshell output comes back as rows of one text column.
      for (const row of r.rows ?? []) this.print('out', row[0] ?? '');
      if (r.kind === 'error' && !r.messages.length) this.print('error', 'The command failed.');
      if (r.kind !== 'error' && !r.messages.length && !r.rows?.length) this.print('info', `OK · ${r.elapsedMs} ms`);
    } catch (err) {
      const why = explainToolError(this.mode === 'qsh' ? 'QSH' : 'CL', this.request.host, errorText(err));
      this.print('error', `${why.message}${why.hint ? `\n${why.hint}` : ''}`);
    } finally {
      this.setBusy(false);
      this.input.focus();
    }
  }

  // ---- output ---------------------------------------------------------------------

  private print(kind: 'cmd' | 'msg' | 'out' | 'error' | 'info', text: string): void {
    const span = el('span', `line ${kind}`, `${text}\n`);
    this.output.append(span);
    while (this.output.childElementCount > OUTPUT_LIMIT) this.output.firstElementChild?.remove();
    this.output.scrollTop = this.output.scrollHeight;
  }

  private clear(): void {
    this.output.replaceChildren();
    this.input.focus();
  }

  // ---- input -----------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = this.input.value;
      this.input.value = '';
      this.historyPos = -1;
      void this.run(cmd);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.walkHistory(e.key === 'ArrowUp' ? 1 : -1);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      this.clear();
    } else if (e.key === 'Escape') {
      this.input.value = '';
      this.historyPos = -1;
    }
  }

  private remember(cmd: string): void {
    if (this.history[0] !== cmd) this.history.unshift(cmd);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  private walkHistory(step: number): void {
    if (!this.history.length) return;
    if (this.historyPos < 0) this.draft = this.input.value;
    const next = Math.min(this.history.length - 1, Math.max(-1, this.historyPos + step));
    this.historyPos = next;
    this.input.value = next < 0 ? this.draft : (this.history[next] ?? '');
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.frame.classList.toggle('busy', b);
    this.input.disabled = b;
  }
}
