/**
 * A CodeMirror 6 editor for any text file (the IFS viewer): a language chosen per file,
 * read-only until Edit, line wrapping, line numbers, undo, the search panel (Ctrl+F,
 * F3). The chrome and the syntax colours are the SQL editor's, so the two look alike.
 */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { EDITOR_STYLE_NONCE, codeHighlight, editorTheme } from './sqlEditor';

export interface CodeEditorOptions {
  language?: Extension;
  readOnly?: boolean;
  wrap?: boolean;
  /** The document changed by typing, paste or undo (not by `value =`). */
  onChange?: () => void;
  /** Shortcuts the owner handles (Mod-s for Save, F5 ...), bound above the editor's own. */
  keys?: Record<string, () => void>;
}

export class CodeEditor {
  /** The host element (class `code-editor`); the owner places and sizes it. */
  readonly element: HTMLDivElement;
  private readonly view: EditorView;
  private readonly language = new Compartment();
  private readonly readOnly = new Compartment();
  private readonly wrapping = new Compartment();
  private languageExt: Extension;
  private readOnlyOn: boolean;
  private wrapOn: boolean;
  private readonly fixed: Extension[];
  /** True while `value =` runs, so the change listener tells the user's edits apart. */
  private setting = false;

  constructor(opts: CodeEditorOptions = {}) {
    this.element = document.createElement('div');
    this.element.className = 'code-editor';
    this.languageExt = opts.language ?? [];
    this.readOnlyOn = opts.readOnly ?? true;
    this.wrapOn = opts.wrap ?? false;
    const own: Extension[] = [];
    if (opts.onChange) {
      const onChange = opts.onChange;
      own.push(
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !this.setting) onChange();
        }),
      );
    }
    const keys = Object.entries(opts.keys ?? {}).map(([key, fn]) => ({
      key,
      run: () => {
        fn();
        return true;
      },
    }));
    if (keys.length) own.push(Prec.highest(keymap.of(keys)));
    this.fixed = [
      syntaxHighlighting(codeHighlight),
      editorTheme,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorState.tabSize.of(4),
      indentUnit.of('    '),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.cspNonce.of(EDITOR_STYLE_NONCE),
      ...own,
    ];
    this.view = new EditorView({ parent: this.element, state: this.stateFor('') });
  }

  private stateFor(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [this.language.of(this.languageExt), this.readOnly.of(readOnlyExtension(this.readOnlyOn)), this.wrapping.of(this.wrapOn ? EditorView.lineWrapping : []), ...this.fixed],
    });
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  /** Replaces the text and forgets the undo history (a freshly loaded file). */
  set value(text: string) {
    this.setting = true;
    try {
      this.view.setState(this.stateFor(text));
    } finally {
      this.setting = false;
    }
  }

  /** Replaces the text as an edit (undoable, reported through onChange), unlike `value =`. */
  replaceAll(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  setLanguage(ext?: Extension): void {
    this.languageExt = ext ?? [];
    this.view.dispatch({ effects: this.language.reconfigure(this.languageExt) });
  }

  setReadOnly(on: boolean): void {
    this.readOnlyOn = on;
    this.view.dispatch({ effects: this.readOnly.reconfigure(readOnlyExtension(on)) });
  }

  setWrap(on: boolean): void {
    this.wrapOn = on;
    this.view.dispatch({ effects: this.wrapping.reconfigure(on ? EditorView.lineWrapping : []) });
  }

  get lineCount(): number {
    return this.view.state.doc.lines;
  }

  selection(): { start: number; end: number } {
    const { from, to } = this.view.state.selection.main;
    return { start: from, end: to };
  }

  openFind(): void {
    openSearchPanel(this.view);
  }

  findNext(): void {
    findNext(this.view);
  }

  findPrevious(): void {
    findPrevious(this.view);
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}

function readOnlyExtension(on: boolean): Extension {
  return [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
}
