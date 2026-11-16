import { findMatches, findStatus, matchFrom, stepMatch, type FindMatch } from '../shared/screenFind';

/** What the find bar needs from the terminal around it. */
export interface FindBarHost {
  /** The current screen's rows as they are seen (hidden text blank); undefined before the first screen. */
  rows(): string[] | undefined;
  /** Shows the matches and selects the current one (an index; -1 for none). */
  show(matches: readonly FindMatch[], current: number): void;
  /** Takes the matches off the screen. */
  clear(): void;
  /** Gives the keyboard back to the screen. */
  focusScreen(): void;
}

const ARROW_UP = String.fromCharCode(0x2191);
const ARROW_DOWN = String.fromCharCode(0x2193);
const CLOSE = String.fromCharCode(0x00d7);

/**
 * Find on screen: a small bar at the top right of the terminal, as in VS Code. What is typed
 * in its box is searched on the current screen; every match is shown and the current one is
 * selected, so the Copy key copies it. Each new screen is searched again. Nothing is sent to
 * the host and the 5250 cursor stays where it is.
 */
export class FindBar {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private readonly caseButton: HTMLButtonElement;
  private matchCase = false;
  private matches: FindMatch[] = [];
  private current = -1;
  /** Where a search with no current match starts: the selection the bar was opened with. */
  private anchor: { row: number; col: number } | undefined;

  constructor(
    parent: HTMLElement,
    private readonly host: FindBarHost,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'find-bar';
    this.root.hidden = true;
    this.root.setAttribute('role', 'search');
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'Find';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-label', 'Find on screen');
    this.input.addEventListener('input', () => this.search());
    this.count = document.createElement('span');
    this.count.className = 'count';
    this.count.setAttribute('aria-live', 'polite');
    this.caseButton = this.button('Aa', 'Match Case (Alt+C)', () => this.toggleCase());
    this.caseButton.classList.add('toggle');
    this.caseButton.setAttribute('aria-pressed', 'false');
    this.root.append(
      this.input,
      this.count,
      this.caseButton,
      this.button(ARROW_UP, 'Previous Match (Shift+Enter)', () => this.step(-1)),
      this.button(ARROW_DOWN, 'Next Match (Enter)', () => this.step(1)),
      this.button(CLOSE, 'Close (Escape)', () => this.close()),
    );
    parent.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** True when the node is part of the bar: key and clipboard events aimed at its box. */
  contains(node: EventTarget | null): boolean {
    return node instanceof Node && this.root.contains(node);
  }

  /**
   * Opens the bar, or goes back to it when it is open, with the keyboard in the box and its
   * text selected. `seed` (the text selected on the screen) replaces the box's text, and the
   * search starts at `from`, where that selection begins.
   */
  open(seed?: string, from?: { row: number; col: number }): void {
    const reopened = !this.isOpen;
    if (seed) {
      this.input.value = seed;
      this.anchor = from;
      this.current = -1;
    } else if (reopened) {
      this.anchor = undefined;
      this.current = -1;
    }
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
    if (seed || reopened) this.search();
  }

  /** Closes the bar: the matches go, the selection stays (to copy it) and the keyboard returns to the screen. */
  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.matches = [];
    this.current = -1;
    this.anchor = undefined;
    this.host.clear();
    this.host.focusScreen();
  }

  /** The screen changed: searches it again, staying on the current match while it is still there. */
  refresh(): void {
    if (this.isOpen) this.search();
  }

  /**
   * The bar's own keys: Enter in the box or F3 go to the next match and, with Shift, to the
   * previous one; Escape closes; Alt+C turns Match Case on or off. Enter on a button presses
   * the button. True when the key was used.
   */
  handleKey(e: KeyboardEvent): boolean {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (plain && ((e.key === 'Enter' && e.target === this.input) || e.key === 'F3')) {
      this.step(e.shiftKey ? -1 : 1);
      return true;
    }
    if (plain && !e.shiftKey && e.key === 'Escape') {
      this.close();
      return true;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyC') {
      this.toggleCase();
      return true;
    }
    return false;
  }

  /** The text selected in the box. */
  selectedText(): string {
    const { selectionStart, selectionEnd, value } = this.input;
    return selectionStart === null || selectionEnd === null ? '' : value.slice(selectionStart, selectionEnd);
  }

  /** Puts clipboard text in the box at the caret: its first line only, since a match never spans rows. */
  insertText(text: string): void {
    const line = text.split(/\r?\n/)[0] ?? '';
    if (line) this.replaceSelection(line);
  }

  /** Cut: takes the selected text out of the box. */
  deleteSelection(): void {
    this.replaceSelection('');
  }

  private replaceSelection(text: string): void {
    const end = this.input.value.length;
    this.input.setRangeText(text, this.input.selectionStart ?? end, this.input.selectionEnd ?? end, 'end');
    this.search();
  }

  private button(text: string, tooltip: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = tooltip;
    b.setAttribute('aria-label', tooltip);
    // A click keeps the keyboard where it was (in the box), as VS Code's find buttons do.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  }

  private search(): void {
    const query = this.input.value;
    const rows = this.host.rows();
    const at = this.matches[this.current];
    const from = at ? { row: at.row, col: at.col } : this.anchor;
    this.matches = query && rows ? findMatches(rows, query, { matchCase: this.matchCase }) : [];
    this.current = matchFrom(this.matches, from);
    this.render();
  }

  private step(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.current = stepMatch(this.matches.length, this.current, direction);
    this.render();
  }

  private toggleCase(): void {
    this.matchCase = !this.matchCase;
    this.caseButton.classList.toggle('on', this.matchCase);
    this.caseButton.setAttribute('aria-pressed', String(this.matchCase));
    this.search();
  }

  private render(): void {
    const query = this.input.value;
    this.count.textContent = findStatus(query, this.current, this.matches.length);
    this.root.classList.toggle('no-results', query !== '' && this.matches.length === 0);
    this.host.show(this.matches, this.current);
  }
}
