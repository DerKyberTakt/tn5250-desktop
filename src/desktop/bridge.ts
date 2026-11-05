/**
 * Typed access to the Go host. The Go `App` service (app.go) is called by name
 * through the Wails v3 runtime (`Call.ByName("main.App.X", ...)`), and its events
 * arrive as one JSON payload each (`Events.On`). Only the shell page bundles the
 * runtime; the terminal and settings frames talk to the shell with postMessage.
 * Tests may install fakes on window.go.main.App / window.runtime instead.
 */
import { Application, Browser, Call, Events, Window } from '@wailsio/runtime';

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

export interface IfsProgress {
  transfer: string;
  file: string;
  done: number;
  total: number;
  files: number;
  filesNow: number;
}

interface GoApp {
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
  SecretGet(key: string): Promise<string>;
  SecretSet(key: string, value: string): Promise<void>;
  SecretDelete(key: string): Promise<void>;
  PickFile(title: string, filters: FileFilter[]): Promise<string>;
  /** PickFile opening in a folder when it exists; '~/...' is under the home directory. */
  PickFileIn(title: string, filters: FileFilter[], dir: string): Promise<string>;
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
  IfsReadText(id: string, path: string): Promise<string>;
}

interface WailsRuntime {
  /** Subscribes to a Go event; the callback gets the event's data payload. Returns the unsubscribe. */
  EventsOn(name: string, callback: (data: unknown) => void): () => void;
  /** Files dropped on the window (paths resolved by the host). */
  OnFileDrop(callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
  WindowSetTitle(title: string): void;
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
