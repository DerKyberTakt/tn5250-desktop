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
}

export interface TerminalConfig {
  settings: TerminalSettings;
  keyOverlay: boolean;
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

export type HostToWebview =
  | { type: 'screen'; screen: ScreenSnapshot }
  | { type: 'oia'; oia: OiaState }
  | { type: 'config'; config: TerminalConfig }
  | { type: 'status'; status: ConnectionStatus; detail: string }
  | { type: 'alarm' }
  /** Clipboard text read by the host, in answer to a 'paste' request. */
  | { type: 'paste'; text: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'key'; event: KeyEventInfo }
  | { type: 'action'; action: KeyAction }
  | { type: 'text'; text: string }
  | { type: 'click'; row: number; col: number }
  | { type: 'copy'; text: string }
  /** Ctrl+V / Shift+Insert: asks the host for the clipboard text (webviews cannot read it). */
  | { type: 'paste' }
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
