import type { InputInhibit } from '../shared/protocol';

export type ReadKind = 'input' | 'mdt' | 'mdtAlt';

/** Terminal status that is not part of the screen buffer. */
export class TerminalState {
  inputInhibited: InputInhibit = 'system';
  messageWaiting = false;
  insert = false;
  /** Set by a Read command: which response format the host expects next. */
  pendingRead: ReadKind | undefined;
  /** Operator error text (EBCDIC bytes already placed on the error row), for the OIA. */
  errorMessage = '';
  /** Cursor saved by Write Error Code, restored on Reset. */
  savedCursor: number | undefined;
  /** Error row contents saved by Write Error Code, restored on Reset. */
  savedErrorRow: Uint8Array | undefined;
  /**
   * The last cell of a field-exit-required field was just filled: the cursor is shown
   * on that cell but is logically past it, so Field Exit / Erase EOF keep the character
   * and typing is refused (0020) until the cursor moves.
   */
  cursorPastEnd = false;
  /** The last keystroke filled a field and moved to the next one by itself. */
  autoAdvanced = false;

  reset(): void {
    this.inputInhibited = 'system';
    this.messageWaiting = false;
    this.insert = false;
    this.pendingRead = undefined;
    this.errorMessage = '';
    this.savedCursor = undefined;
    this.savedErrorRow = undefined;
    this.cursorPastEnd = false;
    this.autoAdvanced = false;
  }
}
