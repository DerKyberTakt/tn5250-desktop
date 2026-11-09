/**
 * Typed access to the Go host. The Go `App` service (app.go) is called by name
 * through the Wails v3 runtime (`Call.ByName("main.App.X", ...)`), and its events
 * arrive as one JSON payload each (`Events.On`). Only the shell page bundles the
 * runtime; the terminal and settings frames talk to the shell with postMessage.
 * Tests may install fakes on window.go.main.App / window.runtime instead.
 */
import { Application, Browser, Call, Events, Window } from '@wailsio/runtime';

export interface SettingsPaths {
  user: string;
  managed: string;
  managedExists: boolean;
  preload: string;
}

export interface ConnectOptionsDto {
  host: string;
  port: number;
  tls: boolean;
  trustAnyCertificate: boolean;
  pinnedFingerprint: string;
  caFile: string;
  timeoutMs: number;
  keepAlive: boolean;
}

/** Run SQL Scripts (app_sql.go). */
export interface SqlConnectRequest {
  host: string;
  tls: boolean;
  trustAnyCertificate: boolean;
  user: string;
  password: string;
  timeoutMs: number;
  /** 'sql' (schema.table) or 'sys' (library/file). */
  naming: string;
  defaultSchema: string;
}

export interface SqlColumn {
  name: string;
  label?: string;
  type: string;
  length: number;
  scale: number;
  nullable: boolean;
  ccsid?: number;
}

export interface SqlMessage {
  /** SQLSTATE, or a CPF/CPD message id. */
  id: string;
  code: number;
  severity: number;
  text: string;
}

export interface SqlResult {
  kind: 'rows' | 'count' | 'none' | 'error';
  columns?: SqlColumn[];
  /** null = SQL NULL. */
  rows?: (string | null)[][];
  more: boolean;
  cursor?: string;
  updateCount: number;
  messages: SqlMessage[];
  elapsedMs: number;
}

/** Result of App.UpdateCheck (app_update.go). */
export interface UpdateInfo {
  current: string;
  /** Latest release tag, e.g. "v0.1.3"; empty when nothing is published. */
  latest: string;
  available: boolean;
  /** Release notes page. */
  page: string;
  mode: 'installer' | 'portable' | 'appimage' | 'manual';
  reason?: string;
}

export interface FileFilter {
  name: string;
  /** Semicolon-separated globs, e.g. "*.json;*.txt". */
  patterns: string;
}

export interface SystemInfo {
  computerName: string;
  userName: string;
  platform: string;
}

/** A window's place on the virtual screen (windows.go). */
export interface WindowBounds {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IfsEntry {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  modified: string;
  created: string;
  /** 1 file, 2 directory, 3 symbolic link, 4 native object (QSYS.LIB), 5 FIFO ... */
  type: number;
  readOnly: boolean;
  hidden: boolean;
}

export interface IfsConnectRequest {
  host: string;
  tls: boolean;
  trustAnyCertificate: boolean;
  user: string;
  password: string;
  timeoutMs: number;
}

/** A file's bytes for the viewer (IfsReadBytes). */
export interface IfsBytes {
  /** Base64. */
  data: string;
  /** The data CCSID the host reports; 0 when it does not say. */
  ccsid: number;
  size: number;
  /** The data stops short of the size (the read limit). */
  truncated: boolean;
}

export interface IfsProgress {
  transfer: string;
  file: string;
  done: number;
  total: number;
  files: number;
  filesNow: number;
}

interface GoApp {
  /** Delivers an event to one window (the broker or a visible window). */
  Relay(to: string, name: string, data: unknown): Promise<void>;
  WindowOpen(name: string, title: string, x: number, y: number, width: number, height: number): Promise<void>;
  WindowFocus(name: string): Promise<void>;
  WindowClose(name: string): Promise<void>;
  WindowList(): Promise<WindowBounds[] | null>;
  WindowBounds(name: string): Promise<WindowBounds>;
  /** The drag ghost window (app_ghost.go): created hidden, shown at a screen point, moved, hidden. */
  GhostPrepare(): Promise<void>;
  GhostShow(label: string, x: number, y: number): Promise<void>;
  GhostMove(x: number, y: number): Promise<void>;
  GhostHide(): Promise<void>;
  GhostLabel(): Promise<string>;
  /** Whether this window is frameless and the page draws the title bar (app_frame.go). */
  FrameInfo(): Promise<{ custom: boolean; platform: string }>;
  NetConnect(id: string, options: ConnectOptionsDto): Promise<void>;
  NetSend(id: string, base64: string): Promise<void>;
  NetClose(id: string): Promise<void>;
  SystemInfo(): Promise<SystemInfo>;
  LaunchArgs(): Promise<string[]>;
  Version(): Promise<string>;
  UpdateCheck(): Promise<UpdateInfo>;
  UpdateInstall(tag: string): Promise<void>;
  SqlConnect(request: SqlConnectRequest): Promise<string>;
  SqlClose(id: string): Promise<void>;
  SqlRun(id: string, statement: string, maxRows: number): Promise<SqlResult>;
  SqlFetch(id: string, cursor: string, maxRows: number): Promise<SqlResult>;
  SqlCancel(id: string): Promise<void>;
  CmdRun(id: string, command: string): Promise<SqlResult>;
  /** Qshell command; output lines come back as rows of one column. */
  QshRun(id: string, command: string): Promise<SqlResult>;
  SettingsLoad(): Promise<string>;
  SettingsSave(text: string): Promise<void>;
  SettingsFilePath(): Promise<string>;
  /** The administrator's machine-wide settings file, '' when there is none. */
  ManagedSettingsLoad(): Promise<string>;
  SettingsPaths(): Promise<SettingsPaths>;
  SecretGet(key: string): Promise<string>;
  SecretSet(key: string, value: string): Promise<void>;
  SecretDelete(key: string): Promise<void>;
  PickFile(title: string, filters: FileFilter[]): Promise<string>;
  /** PickFile opening in a folder when it exists; '~/...' is under the home directory. */
  PickFileIn(title: string, filters: FileFilter[], dir: string): Promise<string>;
  /** PickFileIn for several files; empty when cancelled. */
  PickFilesIn(title: string, filters: FileFilter[], dir: string): Promise<string[]>;
  /** The files in a folder (not its subfolders) with the extension, sorted; none when the folder does not exist. */
  ListFiles(dir: string, ext: string): Promise<string[]>;
  SaveTextFile(title: string, defaultName: string, text: string, filters: FileFilter[]): Promise<boolean>;
  ReadTextFile(path: string): Promise<string>;
  ImageDataURL(path: string): Promise<string>;
  ClipboardSet(text: string): Promise<void>;
  ClipboardGet(): Promise<string>;
  OpenURL(url: string): Promise<void>;
  /** STRPCCMD: runs a command through the user's shell; wait = resolve when it exits. */
  RunPcCommand(command: string, wait: boolean): Promise<void>;
  IfsConnect(request: IfsConnectRequest): Promise<string>;
  IfsClose(id: string): Promise<void>;
  IfsList(id: string, dir: string): Promise<IfsEntry[]>;
  IfsMkdir(id: string, path: string): Promise<void>;
  IfsRename(id: string, from: string, to: string): Promise<void>;
  IfsDelete(id: string, path: string, dir: boolean, recursive: boolean): Promise<void>;
  IfsDownload(id: string, remotes: string[], transfer: string): Promise<number>;
  IfsUpload(id: string, remoteDir: string, paths: string[], replace: boolean, transfer: string): Promise<number>;
  IfsCancel(transfer: string): Promise<void>;
  IfsReadBytes(id: string, path: string, maxBytes: number): Promise<IfsBytes>;
  /** Writes base64 data; a created file is tagged with the CCSID. Without replace, an existing file answers EXISTS: name. */
  IfsWriteBytes(id: string, path: string, dataB64: string, ccsid: number, replace: boolean): Promise<void>;
}

interface WailsRuntime {
  /** Subscribes to a Go event; the callback gets the event's data payload. Returns the unsubscribe. */
  EventsOn(name: string, callback: (data: unknown) => void): () => void;
  /** Files dropped on the window (paths resolved by the host). */
  OnFileDrop(callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
  WindowSetTitle(title: string): void;
  /** Window controls for the page's own title bar. */
  WindowMinimise(): void;
  WindowToggleMaximise(): void;
  WindowClose(): void;
  WindowIsMaximised(): Promise<boolean>;
  /** Opens a URL in the default browser (the Go OpenURL is used for host-driven links). */
  OpenURL(url: string): void;
  Quit(): void;
}

declare global {
  interface Window {
    go?: { main?: { App?: GoApp } };
    runtime?: WailsRuntime;
    /** Set by the Wails runtime inside the app. */
    _wails?: unknown;
  }
}

const SERVICE = 'main.App.';

/** Every method of the Go App service, called by name. */
const service = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
  get: (_target, name) => (...args: unknown[]) => Call.ByName(SERVICE + String(name), ...args),
}) as unknown as GoApp;

const runtime: WailsRuntime = {
  EventsOn: (name, callback) => Events.On(name, (ev) => callback(ev.data)),
  OnFileDrop: (callback) => void Events.On('files:dropped', (ev) => callback(0, 0, (ev.data as string[] | null) ?? [])),
  WindowSetTitle: (title) => void Window.SetTitle(title),
  WindowMinimise: () => void Window.Minimise(),
  WindowToggleMaximise: () => void Window.ToggleMaximise(),
  WindowClose: () => void Window.Close(),
  WindowIsMaximised: () => Window.IsMaximised(),
  OpenURL: (url) => void Browser.OpenURL(url),
  Quit: () => void Application.Quit(),
};

function inApp(): boolean {
  return typeof window !== 'undefined' && window._wails !== undefined;
}

export function goApp(): GoApp {
  const fake = window.go?.main?.App;
  if (fake) return fake;
  if (!inApp()) throw new Error('Go host not available');
  return service;
}

export function wailsRuntime(): WailsRuntime {
  if (window.runtime) return window.runtime;
  if (!inApp()) throw new Error('Wails runtime not available');
  return runtime;
}

let brokerReady = false;
const brokerQueue: unknown[] = [];

/**
 * Sends a relay message to one window (src/desktop/relay.ts). Messages for the broker wait
 * until its page has said it listens (broker:ready, or a registry reply to window:hello):
 * an event delivered to a page that has not loaded is lost.
 */
export function relay(to: string, msg: unknown): Promise<void> {
  if (to === 'broker' && !brokerReady) {
    brokerQueue.push(msg);
    return Promise.resolve();
  }
  return goApp().Relay(to, 'relay', msg);
}

/** Sends at once, queue or not (the window:hello handshake). */
export function relayNow(to: string, msg: unknown): Promise<void> {
  return goApp().Relay(to, 'relay', msg);
}

/** The broker listens: send what waited. */
export function brokerIsReady(): void {
  if (brokerReady) return;
  brokerReady = true;
  for (const msg of brokerQueue.splice(0)) void goApp().Relay('broker', 'relay', msg).catch(() => undefined);
}

/** Relay messages addressed to this window. */
export function onRelay(callback: (msg: unknown) => void): () => void {
  return wailsRuntime().EventsOn('relay', callback);
}

/** The command line a second launch of the exe was started with (forwarded by the host). */
export function onLaunchArgs(callback: (args: string[]) => void): () => void {
  return wailsRuntime().EventsOn('launch:args', (data) => callback((data as string[] | null) ?? []));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
