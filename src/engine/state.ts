import type { InputInhibit } from '../shared/protocol';

export type ReadKind = 'input' | 'mdt' | 'mdtAlt';

/**
 * One entry of the Programmable Mouse Buttons table (enhanced 5250): a pointer event
 * (1 = left pressed, 2 = left released, 3 = left double click, 4-6 right, 7-9 middle,
 * 0x0A-0x12 the same with Shift) that returns an AID, alone or as the leading edge of a
 * two-event sequence.
 */
export interface MouseButtonDef {
  twoEvent: boolean;
  /** Move the text cursor to the pointer position when the AID is sent. */
  moveCursor: boolean;
  /** Keep a single event that arrives while the keyboard is locked until it unlocks. */
  queue: boolean;
  /** Draw a marker box at the first event of a two-event sequence. */
  marker: boolean;
  first: number;
  second: number;
  aid: number;
}

/** The programmable mouse button two-event AID. */
export const AID_TWO_EVENT = 0x80;

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
  /**
   * Function keys the host declared as command attention keys (DDS CAnn): bit n-1 set
   * means Fn sends only the cursor and AID, no field data. From the Start of Header
   * order's command key bytes; 0 when the header did not carry them.
   */
  caKeys = 0;
  /** Programmable Mouse Buttons table; empty = no pointer events go to the host. */
  mouseButtons: MouseButtonDef[] = [];
  /** A two-event sequence whose leading edge happened: where, and which definition. */
  pendingMouse: { def: MouseButtonDef; row: number; col: number } | undefined;
  /** A single event kept while the keyboard was locked (definition flag), sent on unlock. */
  queuedMouse: { def: MouseButtonDef; row: number; col: number } | undefined;

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
    this.caKeys = 0;
    this.mouseButtons = [];
    this.pendingMouse = undefined;
    this.queuedMouse = undefined;
  }
}
