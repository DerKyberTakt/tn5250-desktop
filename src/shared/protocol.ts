import type { KeyAction } from './keymap';
import type { TerminalSettings } from './settings';

/**
 * Messages exchanged between the extension host and the terminal webview.
 * Everything here must be plain JSON so it survives postMessage.
 */

export interface SnapshotField {
  /** Cell index of the first data position. */
  start: number;
  length: number;
  bypass: boolean;
}

/** A GUI window the host created (enhanced 5250 Create Window); the rectangle includes the border. */
export interface SnapshotWindow {
  row: number;
  col: number;
  rows: number;
  cols: number;
  title?: { text: string; align: 'center' | 'left' | 'right' };
  footer?: { text: string; align: 'center' | 'left' | 'right' };
}

/** A scroll bar the host defined (enhanced 5250 Define Scroll Bar Field, DDS SFLEND(*SCRBAR)). */
export interface SnapshotScrollBar {
  /** Cell index of the top-left cell; identifies the bar in a 'scroll' message. */
  addr: number;
  row: number;
  col: number;
  horizontal: boolean;
  /** Rows (vertical) or columns (horizontal) the bar occupies, arrows included; vertical bars are 3 columns wide. */
  size: number;
  /** Rows (columns) the application can scroll through, and how many are above (left of) the first shown. */
  total: number;
  pos: number;
}

export interface ScreenSnapshot {
  rows: number;
  cols: number;
  /**
   * rows * cols characters, row-major. Attribute positions hold a space;
   * null cells hold "\u0000" (nothing is drawn there, not even decorations,
   * unless the cell belongs to a field).
   */
  text: string;
  /** Input and output fields from the format table, in screen order. */
  fields: SnapshotField[];
  /**
   * rows * cols entries. A value in 0x20..0x3F marks that cell as a 5250
   * attribute byte that applies to the following cells (across row ends) until
   * the next attribute. 0 means "not an attribute position".
   */
  attrs: number[];
  cursor: { row: number; col: number };
  /** Enhanced 5250 constructs drawn by the terminal (absent on demo screens). */
  gui?: { windows: SnapshotWindow[]; scrollBars: SnapshotScrollBar[] };
}

export type InputInhibit = 'none' | 'system' | 'error';

export interface OiaState {
  connected: boolean;
  inputInhibited: InputInhibit;
  insert: boolean;
  messageWaiting: boolean;
  deviceName: string;
  /** Short status text shown at the right of the OIA (e.g. an error code). */
  message: string;
  /** Keys typed ahead while the keyboard is locked, waiting to be replayed. */
  queuedKeys?: number;
}

/** Which application hosts the terminal page; decides what unmapped chords do. */
export type TerminalHost = 'vscode' | 'desktop';

export interface TerminalConfig {
  settings: TerminalSettings;
  keyOverlay: boolean;
  host: TerminalHost;
  /** Watermark image as a data URL, loaded by the host from settings.watermarkImage. */
  watermarkImageData?: string;
  /** An imported font to register with @font-face before use. */
  fontFace?: { family: string; url: string };
}

export interface KeyEventInfo {
  key: string;
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** Extra facts about a status change, for the connection overlay. */
export interface ConnectionInfo {
  /** Connection attempt number since the last successful connect (1 = first try). */
  attempt: number;
  /** Epoch ms of the next automatic reconnect, when one is scheduled. */
  retryAt?: number;
  /** The user disconnected or cancelled (no "connection lost" wording). */
  manual?: boolean;
}

export type HostToWebview =
  | { type: 'screen'; screen: ScreenSnapshot }
  | { type: 'oia'; oia: OiaState }
  | { type: 'config'; config: TerminalConfig }
  | { type: 'status'; status: ConnectionStatus; detail: string; info?: ConnectionInfo }
  | { type: 'alarm' }
  /** Clipboard text read by the host, in answer to a 'paste' request. */
  | { type: 'paste'; text: string }
  /** Toolbar / menu Copy: copy the selection (the whole screen when nothing is selected), like Ctrl+C. */
  | { type: 'copySelection' }
  /** The host made this terminal the active one: take keyboard focus. */
  | { type: 'focus' };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'key'; event: KeyEventInfo }
  | { type: 'action'; action: KeyAction }
  | { type: 'text'; text: string }
  | { type: 'click'; row: number; col: number }
  /** Pointer use of a host scroll bar: forward = toward the end (Roll Up / Roll Right); increment rows or columns (1 = arrow, 0 = a page). */
  | { type: 'scroll'; addr: number; forward: boolean; increment: number }
  | { type: 'copy'; text: string }
  /** Ctrl+V / Shift+Insert: asks the host for the clipboard text (webviews cannot read it). */
  | { type: 'paste' }
  /** Connection overlay: connect now / stop retrying (or cancel a connect in progress). */
  | { type: 'reconnect' }
  | { type: 'cancelReconnect' }
  | { type: 'printScreen' }
  | { type: 'openUrl'; url: string }
  | { type: 'log'; message: string };

export const DEFAULT_OIA: OiaState = {
  connected: false,
  inputInhibited: 'none',
  insert: false,
  messageWaiting: false,
  deviceName: '',
  message: '',
};
