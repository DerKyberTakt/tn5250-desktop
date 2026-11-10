/**
 * The Run SQL Scripts editor: CodeMirror 6 with the Db2 for i dialect (sqlDialect.ts).
 * SqlTab talks to this small wrapper (value, selection, focus) and never to the
 * EditorView, so the rest of the tab reads as it did with the textarea.
 *
 * Colours come from CSS variables (sql.css: --sql-kw, --sql-fn, ...), so light, dark
 * and user themes flow through. CodeMirror injects its own style sheets; the page's
 * CSP allows them through EDITOR_STYLE_NONCE (static/index.html).
 */
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { SERVICE_REFERENCE, db2iLanguage } from './sqlDialect';

/** The nonce the page's Content-Security-Policy grants to the editor's style sheets. */
export const EDITOR_STYLE_NONCE = 'tn5250-editor';

export interface SqlEditorOptions {
  placeholder?: string;
  /** The document changed (typing, paste, undo, setScript). */
  onChange?: () => void;
  /** Shortcuts the tab owns: Ctrl+R, Ctrl+Shift+R, Ctrl+Alt+R, Ctrl+S (Cmd on macOS). */
  keys?: Partial<Record<'run' | 'runAll' | 'runFrom' | 'save', () => void>>;
}

/** Syntax colours by token kind; the variables are defined in sql.css. */
const db2iHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--sql-kw)' },
  { tag: t.typeName, color: 'var(--sql-type)' },
  { tag: t.standard(t.name), color: 'var(--sql-fn)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--sql-str)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--sql-num)' },
  { tag: t.comment, color: 'var(--sql-comment)', fontStyle: 'italic' },
  { tag: t.operator, color: 'var(--sql-op)' },
  { tag: t.special(t.name), color: 'var(--sql-var)' },
]);

/** The editor chrome, in the app's own variables. */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--vscode-editor-background)',
    color: 'var(--vscode-editor-foreground, var(--vscode-foreground))',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--vscode-editor-font-family, Consolas, monospace)',
    lineHeight: '1.4',
  },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--vscode-editor-foreground, var(--vscode-foreground))' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editor-foreground, var(--vscode-foreground))' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sql-selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--chrome-bg)',
    color: 'var(--sql-gutter)',
    borderRight: '1px solid var(--chrome-border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--sql-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--sql-active-line)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--sql-match)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--sql-match)', outline: '1px solid var(--chrome-border)' },
  '.cm-sql-service': { color: 'var(--sql-fn)' },
  '.cm-cl-line': { backgroundColor: 'var(--sql-cmd-bg)' },
  '.cm-cl-prefix': { color: 'var(--sql-cmd)', fontWeight: '600' },
  '.cm-placeholder': { color: 'var(--sql-gutter)' },
  '.cm-panels': { backgroundColor: 'var(--chrome-bg)', color: 'var(--vscode-foreground)', borderColor: 'var(--chrome-border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--chrome-border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--chrome-border)' },
  '.cm-panel input, .cm-panel button': { font: 'inherit' },
  '.cm-tooltip': { backgroundColor: 'var(--chrome-bg)', color: 'var(--vscode-foreground)', border: '1px solid var(--chrome-border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--sql-selection)', color: 'inherit' },
});

const clLine = Decoration.line({ class: 'cm-cl-line' });
const clPrefix = Decoration.mark({ class: 'cm-cl-prefix' });

/** The `CL:` / `QSH:` lines of a script, tinted as a whole with the prefix in bold. */
function commandLineDecorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const m = /^(\s*)(CL|QSH):/i.exec(line.text);
      if (m) {
        b.add(line.from, line.from, clLine);
        b.add(line.from + m[1]!.length, line.from + m[0].length, clPrefix);
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

const commandLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = commandLineDecorations(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = commandLineDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const serviceMark = Decoration.mark({ class: 'cm-sql-service' });

/** `QSYS2.SYSTABLES` and friends, coloured like built-ins (not inside comments or strings). */
const serviceMatcher = new MatchDecorator({
  regexp: SERVICE_REFERENCE,
  decoration: (_m, view, pos) => (/Comment|String/.test(syntaxTree(view.state).resolveInner(pos, 1).name) ? null : serviceMark),
});

const serviceReferencesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = serviceMatcher.createDeco(view);
    }
    update(u: ViewUpdate): void {
      this.decorations = serviceMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Everything but the per-instance pieces (placeholder, keys, change listener). */
export function sqlEditorExtensions(): Extension[] {
  return [
    db2iLanguage(),
    syntaxHighlighting(db2iHighlight),
    theme,
    commandLines,
    serviceReferencesPlugin,
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    autocompletion(),
    EditorState.tabSize.of(4),
    indentUnit.of('    '),
    // Tab takes the completion on offer (as VS Code does); with none open it indents.
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, { key: 'Tab', run: acceptCompletion }, indentWithTab]),
    EditorView.cspNonce.of(EDITOR_STYLE_NONCE),
  ];
}

export class SqlEditor {
  /** The host element (class `sql-editor`); the tab places and sizes it. */
  readonly element: HTMLDivElement;
  private readonly view: EditorView;

  constructor(opts: SqlEditorOptions = {}) {
    this.element = document.createElement('div');
    this.element.className = 'sql-editor';
    const own: Extension[] = [];
    if (opts.placeholder) own.push(placeholder(opts.placeholder));
    if (opts.onChange) {
      const onChange = opts.onChange;
      own.push(
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange();
        }),
      );
    }
    const k = opts.keys ?? {};
    const bind = (key: string, fn?: () => void) =>
      fn
        ? [
            {
              key,
              run: () => {
                fn();
                return true;
              },
            },
          ]
        : [];
    own.push(Prec.highest(keymap.of([...bind('Mod-r', k.run), ...bind('Mod-Shift-r', k.runAll), ...bind('Mod-Alt-r', k.runFrom), ...bind('Mod-s', k.save)])));
    this.view = new EditorView({
      parent: this.element,
      state: EditorState.create({ doc: '', extensions: [...sqlEditorExtensions(), ...own] }),
    });
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  set value(text: string) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  /** The main selection as offsets (start = end when there is just a cursor). */
  selection(): { start: number; end: number } {
    const { from, to } = this.view.state.selection.main;
    return { start: from, end: to };
  }

  /** Puts the cursor at an offset (for tests and for "hand over a statement"). */
  setCursor(pos: number): void {
    const p = Math.max(0, Math.min(pos, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor: p } });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
