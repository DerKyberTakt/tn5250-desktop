/**
 * Messages between the broker window (owns every 5250 session) and the visible windows
 * (render them). Both directions travel as the Wails event "relay", delivered to one window
 * by the Go `Relay` binding. Pure types and the tab registry; no DOM, no runtime.
 */
import type { ConnectionStatus, HostToWebview, WebviewToHost } from '../shared/protocol';
import type { TerminalSettings } from '../shared/settings';

export const BROKER_WINDOW = 'broker';
export const MAIN_WINDOW = 'main';
export const RELAY_EVENT = 'relay';

/** Window -> broker. */
export type ToBroker =
  | { type: 'window:hello'; window: string }
  | { type: 'window:closed'; window: string }
  /** A window (or the credential store) saved settings.json; `window` = the sender, which needs no reload. */
  | { type: 'store:changed'; window?: string }
  | { type: 'tab:open'; tab: string; window: string; profile: TerminalSettings }
  | { type: 'tab:input'; tab: string; msg: WebviewToHost }
  /** Several inputs from one tick, in order (a macro's TAB TAB "40"). */
  | { type: 'tab:inputs'; tab: string; msgs: WebviewToHost[] }
  | { type: 'tab:reload'; tab: string; profile: TerminalSettings }
  /** at: where the tab was dropped (screen point), so the receiving window can splash there. */
  | { type: 'tab:move'; tab: string; window: string; at?: { x: number; y: number } }
  | { type: 'tab:close'; tab: string }
  | { type: 'tab:trace'; tab: string; request: string }
  | { type: 'ui:answer'; request: string; ok: boolean };

/** Broker -> window. */
export type ToWindow =
  | { type: 'broker:ready' }
  | { type: 'tab:opened'; tab: string; letter: string; profile: TerminalSettings; deviceTemplate: string; status: ConnectionStatus; detail: string; at?: { x: number; y: number } }
  | { type: 'tab:output'; tab: string; msg: HostToWebview }
  | { type: 'tab:state'; tab: string; status: ConnectionStatus; detail: string }
  | { type: 'tab:log'; tab: string; line: string }
  | { type: 'tab:notify'; tab: string; text: string }
  | { type: 'tab:trace'; tab: string; request: string; trace: Record<string, unknown> | undefined }
  | { type: 'tab:gone'; tab: string }
  | { type: 'ui:ask'; request: string; tab: string; title: string; text: string; ok: string; then?: 'openSettings' }
  | { type: 'registry'; tabs: RegistryEntry[] }
  /** Another window saved settings.json: reload it and refresh. */
  | { type: 'store:changed' }
  /** From another window (the Connections tree): bring this tab to the front. */
  | { type: 'tab:activate'; tab: string };

/** What every window knows about every session, for the Connections tree. */
export interface RegistryEntry {
  tab: string;
  window: string;
  letter: string;
  title: string;
  name: string;
  host: string;
  port: number;
  status: ConnectionStatus;
}

/** The iframe messages a window forwards to the session; the rest it handles itself. */
const SESSION_INPUTS = new Set<WebviewToHost['type']>(['ready', 'action', 'text', 'click', 'scroll', 'mouse', 'reconnect', 'cancelReconnect']);

export function isSessionInput(msg: WebviewToHost): boolean {
  return SESSION_INPUTS.has(msg.type);
}

/**
 * Session input from a window to the broker, in order. Every relay is its own binding call
 * to Go, and those calls are not ordered: keys fired in one tick (a macro's TAB TAB "40")
 * could reach the session as "40" TAB TAB. The queue gathers what one tick produces into
 * one message and sends the next only after the previous one was dispatched.
 */
export class InputQueue<T> {
  private batch: T[] = [];
  private scheduled = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: (msgs: T[]) => Promise<void>,
    private readonly onError: (err: unknown) => void,
    private readonly defer: (fn: () => void) => void = (fn) => queueMicrotask(fn),
  ) {}

  push(msg: T): void {
    this.batch.push(msg);
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => this.flush());
  }

  /** Sends what has gathered (the deferred call does this; tests call it by hand). */
  flush(): void {
    this.scheduled = false;
    const msgs = this.batch.splice(0);
    if (!msgs.length) return;
    this.chain = this.chain.then(() => this.send(msgs)).catch(this.onError);
  }

  /** Settles when everything flushed so far has been sent. */
  get idle(): Promise<void> {
    return this.chain;
  }
}

let counter = 0;

/** A tab id unique across windows (window name + time + counter). */
export function newTabId(window: string): string {
  counter += 1;
  return `${window}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** The window name a page was opened for: `/?window=<name>`, or the main window. */
export function windowNameFromUrl(search: string): string {
  const m = /[?&]window=([A-Za-z0-9_-]+)/.exec(search);
  return m?.[1] ?? MAIN_WINDOW;
}

/** Screen text (one line per row, nulls as blanks) from a snapshot, as the controller computes it. */
export function snapshotText(snap: { rows: number; cols: number; text: string }): string {
  const rows: string[] = [];
  for (let r = 0; r < snap.rows; r++) {
    rows.push(snap.text.slice(r * snap.cols, (r + 1) * snap.cols).split('\u0000').join(' ').trimEnd());
  }
  return rows.join('\n');
}

/** Which window owns which session; the broker's single source of truth, mirrored to every window. */
export class TabRegistry<T extends RegistryEntry = RegistryEntry> {
  private readonly entries = new Map<string, T>();

  add(entry: T): void {
    this.entries.set(entry.tab, entry);
  }

  get(tab: string): T | undefined {
    return this.entries.get(tab);
  }

  remove(tab: string): T | undefined {
    const e = this.entries.get(tab);
    this.entries.delete(tab);
    return e;
  }

  /** Re-homes a tab; false when the tab is unknown. */
  move(tab: string, window: string): boolean {
    const e = this.entries.get(tab);
    if (!e) return false;
    e.window = window;
    return true;
  }

  byWindow(window: string): T[] {
    return [...this.entries.values()].filter((e) => e.window === window);
  }

  list(): T[] {
    return [...this.entries.values()];
  }

  windows(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.window))];
  }

  /** The public view: no controllers, no profiles. */
  snapshot(): RegistryEntry[] {
    return this.list().map(({ tab, window, letter, title, name, host, port, status }) => ({ tab, window, letter, title, name, host, port, status }));
  }
}
