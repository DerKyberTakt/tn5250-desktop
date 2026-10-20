/**
 * Typed access to the Go host. Wails binds every exported method of the Go
 * `App` struct (app.go) to window.go.main.App and injects window.runtime into
 * the shell page (not into the terminal frames).
 */

export interface ConnectOptionsDto {
  host: string;
  port: number;
  tls: boolean;
  trustAnyCertificate: boolean;
  timeoutMs: number;
  keepAlive: boolean;
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
  SettingsLoad(): Promise<string>;
  SettingsSave(text: string): Promise<void>;
  SettingsFilePath(): Promise<string>;
  SecretGet(key: string): Promise<string>;
  SecretSet(key: string, value: string): Promise<void>;
  SecretDelete(key: string): Promise<void>;
  PickFile(title: string, filters: FileFilter[]): Promise<string>;
  SaveTextFile(title: string, defaultName: string, text: string, filters: FileFilter[]): Promise<boolean>;
  ReadTextFile(path: string): Promise<string>;
  ImageDataURL(path: string): Promise<string>;
  ClipboardSet(text: string): Promise<void>;
  ClipboardGet(): Promise<string>;
  OpenURL(url: string): Promise<void>;
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
  EventsOn(name: string, callback: (...args: unknown[]) => void): () => void;
  OnFileDrop(callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
  WindowSetTitle(title: string): void;
  Quit(): void;
}

declare global {
  interface Window {
    go?: { main?: { App?: GoApp } };
    runtime?: WailsRuntime;
  }
}

export function goApp(): GoApp {
  const app = window.go?.main?.App;
  if (!app) throw new Error('Go host not available');
  return app;
}

export function wailsRuntime(): WailsRuntime {
  if (!window.runtime) throw new Error('Wails runtime not available');
  return window.runtime;
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
