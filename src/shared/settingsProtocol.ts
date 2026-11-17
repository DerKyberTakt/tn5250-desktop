import type { KeyAction } from './keymap';
import type { ConnectionField, SessionOverrides, TerminalSettings } from './settings';

/** Preview material of one profile, loaded by the host (files the page cannot read itself). */
export interface SettingsAssets {
  /** Data URL of the profile's watermark image. */
  watermarkImageData?: string;
  /** Webview URL + family of the profile's imported font. */
  fontFace?: { family: string; url: string };
}

/** The AI agent settings (VS Code only: the application-scoped tn5250.agent.* values), edited on the AI Agent page. */
export interface AgentSettings {
  enabled: boolean;
  binary: string;
  site: string;
  readOnly: boolean;
}

/** What the host knows about the agent set-up, for the AI Agent page's status lines. */
export interface AgentStatus {
  /** The tn5250-tui binary the setting resolves to (PATH or the installer's folder); '' when none was found. */
  binaryFound: string;
  /** The console terminal's sites file. */
  sitesFile: string;
  /** user@host enrolled as the agent's site; '' when the site is not in the file. */
  enrolled: string;
  /** The .mcp.json Set Up Claude Code writes; '' when no folder is open. */
  mcpFile: string;
  /** Whether that file already starts the tn5250 server. */
  mcpConfigured: boolean;
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
  | { type: 'kmp'; keymap: Record<string, KeyAction>; skipped: number }
  /** Answer to { type: 'browseAgentBinary' }: the picked tn5250-tui path (not saved yet). */
  | { type: 'agentBinary'; path: string };

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
  /** Where the page runs: the footer link opens VS Code's settings, or the desktop app's settings file. */
  hostKind?: 'vscode' | 'desktop';
  /** The AI agent settings and set-up status (VS Code only; without them the page hides its AI Agent entry). */
  agent?: AgentSettings;
  agentStatus?: AgentStatus;
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
  /** Settings > Connection > Import Connections: the host runs its import (ACS .hod / Code for IBM i) and pushes the new list. */
  | { type: 'importConnections'; target: number }
  | { type: 'setPassword'; target: number }
  | { type: 'browseWatermark' }
  | { type: 'browseFile'; key: 'tlsClientCert' | 'tlsClientKey' | 'tlsCaFile' }
  | { type: 'browseFont' }
  | { type: 'setCertPassphrase'; target: number }
  | { type: 'exportColors'; values: Record<string, string> }
  | { type: 'importColors' }
  | { type: 'openJson' }
  /** AI Agent page: Save Agent Settings (application-scoped VS Code settings). */
  | { type: 'saveAgent'; values: AgentSettings }
  /** AI Agent page buttons: the host runs the matching tn5250.agent.* command and pushes the new status. */
  | { type: 'agentCommand'; command: 'setup' | 'enroll' | 'unenroll' }
  | { type: 'browseAgentBinary' }
  /** AI Agent page: Install tn5250-tui (the host downloads the latest release into its storage and pushes the new status). */
  | { type: 'installAgentBinary' };
