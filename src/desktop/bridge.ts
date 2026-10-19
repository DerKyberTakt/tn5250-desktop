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

interface GoApp {
  NetConnect(id: string, options: ConnectOptionsDto): Promise<void>;
  NetSend(id: string, base64: string): Promise<void>;
  NetClose(id: string): Promise<void>;
  SystemInfo(): Promise<SystemInfo>;
  LaunchArgs(): Promise<string[]>;
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
}

interface WailsRuntime {
  EventsOn(name: string, callback: (...args: unknown[]) => void): () => void;
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
