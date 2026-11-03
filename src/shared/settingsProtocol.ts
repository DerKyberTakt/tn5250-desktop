import type { KeyAction } from './keymap';
import type { ConnectionField, SessionOverrides, TerminalSettings } from './settings';

/** Preview material of one profile, loaded by the host (files the page cannot read itself). */
export interface SettingsAssets {
  /** Data URL of the profile's watermark image. */
  watermarkImageData?: string;
  /** Webview URL + family of the profile's imported font. */
  fontFace?: { family: string; url: string };
}

/** An open terminal tab, as the page needs it to tell which tabs a save would reload. */
export interface OpenTabInfo {
  title: string;
  profile: TerminalSettings;
  deviceTemplate: string;
}

/** Messages between the extension host and the settings webview. */
export type HostToSettings =
  | HostToSettingsData
  /** Answer to { type: 'select' }: the preview material of the profile now shown. */
  | ({ type: 'assets'; select: number } & SettingsAssets)
  /** The open terminal tabs with a session; sent with the data and whenever tabs change. */
  | { type: 'openTabs'; tabs: OpenTabInfo[] }
  /** Answer to { type: 'importKmp' }: key assignments to merge into the form (not saved yet). */
  | { type: 'kmp'; keymap: Record<string, KeyAction>; skipped: number };

export type HostToSettingsData = {
  type: 'data';
  defaults: TerminalSettings;
  sessions: SessionOverrides[];
  /** Which entry to show: -1 = defaults, otherwise a session index. */
  select: number;
  /** Result of a browse or import, applied to the form without saving. */
  patch?: Partial<TerminalSettings>;
  /** Installed fonts (family, monospace flag). */
  fonts?: Array<{ family: string; monospace: boolean }>;
  /** Data URL of the watermark image of the selected profile, for the preview. */
  watermarkImageData?: string;
  /** Webview URL + family of the selected profile's imported font, for the preview. */
  fontFace?: { family: string; url: string };
};

export type SettingsToHost =
  | { type: 'ready' }
  /** The page switched profiles (-1 = defaults); the host answers with its assets. */
  | { type: 'select'; index: number }
  /** connectionChanges: fields that only take effect on a new connection and differ from the saved values. */
  | { type: 'save'; target: number; values: TerminalSettings; connectionChanges?: ConnectionField[] }
  | { type: 'addSession' }
  /** Copy Session: duplicate a session with all its customizations. */
  | { type: 'copySession'; index: number }
  | { type: 'removeSession'; index: number }
  | { type: 'connect'; index: number }
  | { type: 'importKmp'; target: number }
  | { type: 'setPassword'; target: number }
  | { type: 'browseWatermark' }
  | { type: 'browseFile'; key: 'tlsClientCert' | 'tlsClientKey' }
  | { type: 'browseFont' }
  | { type: 'setCertPassphrase'; target: number }
  | { type: 'exportColors'; values: Record<string, string> }
  | { type: 'importColors' }
  | { type: 'openJson' };
