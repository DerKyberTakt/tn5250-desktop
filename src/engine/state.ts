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

  reset(): void {
    this.inputInhibited = 'system';
    this.messageWaiting = false;
    this.insert = false;
    this.pendingRead = undefined;
    this.errorMessage = '';
    this.savedCursor = undefined;
    this.savedErrorRow = undefined;
  }
}
