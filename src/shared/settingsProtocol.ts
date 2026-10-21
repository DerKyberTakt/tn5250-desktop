import type { SessionOverrides, TerminalSettings } from './settings';

/** Preview material of one profile, loaded by the host (files the page cannot read itself). */
export interface SettingsAssets {
  /** Data URL of the profile's watermark image. */
  watermarkImageData?: string;
  /** Webview URL + family of the profile's imported font. */
  fontFace?: { family: string; url: string };
}

/** Messages between the extension host and the settings webview. */
export type HostToSettings =
  | HostToSettingsData
  /** Answer to { type: 'select' }: the preview material of the profile now shown. */
  | ({ type: 'assets'; select: number } & SettingsAssets);

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
  | { type: 'save'; target: number; values: TerminalSettings }
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
