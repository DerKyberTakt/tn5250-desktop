import { Session5250 } from '../engine/session';
import type { KeyAction } from '../shared/keymap';
import { friendlyNetError } from '../shared/netErrors';
import type { ConnectionInfo, ConnectionStatus, OiaState, ScreenSnapshot } from '../shared/protocol';
import type { TerminalSettings } from '../shared/settings';
import type { Transport, TransportFactory } from './connection';

export interface SessionControllerEvents {
  screen(snapshot: ScreenSnapshot, oia: OiaState): void;
  status(status: ConnectionStatus, detail: string, info: ConnectionInfo): void;
  alarm(): void;
  log(message: string): void;
  /** Password for bypass sign-on, if one is stored. */
  password?(): Promise<string | undefined>;
  /**
   * The current bypass sign-on settings. A tab keeps the connection settings it was
   * opened with, but Bypass signon and the user ID should follow the settings page
   * on the next connect, as in ACS. Without it the opening profile is used.
   */
  signon?(): Pick<TerminalSettings, 'autoSignon' | 'signonUser'>;
  /** Next workstation name to try when the host rejects the current one (undefined = give up). */
  nextDeviceName?(): string | undefined;
  /** Client certificate material for TLS, if configured. */
  clientAuth?(): Promise<{ pfx?: Buffer; cert?: Buffer; key?: Buffer; passphrase?: string } | undefined>;
}

/** One entry of a session trace, in the same shape as scripts/capture.mjs output. */
export interface TraceEvent {
  t: number;
  dir: 'in' | 'out';
  hex: string;
}

const TRACE_LIMIT = 5000;
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Owns one host connection and its 5250 session; feeds screens to a panel. */
export class SessionController {
  private session: Session5250;
  private connection: Transport | undefined;
  private status: ConnectionStatus = 'idle';
  private trace: TraceEvent[] = [];
  private traceStart = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private wantConnected = false;
  private signonDone = false;
  private screensReceived = 0;
  private connectedAt = 0;
  private deviceRetries = 0;
  private lastDetail = '';

  constructor(
    readonly profile: TerminalSettings,
    private readonly events: SessionControllerEvents,
    private readonly createTransport: TransportFactory,
  ) {
    this.session = this.createSession();
  }

  private createSession(): Session5250 {
    return new Session5250(
      {
        screenSize: this.profile.screenSize,
        codePage: this.profile.codePage,
        deviceName: this.profile.deviceName,
        typeAhead: this.profile.typeAhead,
      },
      {
        send: (bytes) => {
          this.record('out', bytes);
          this.connection?.write(bytes);
        },
        update: () => {
          this.screensReceived += 1;
          this.publish();
          void this.maybeSignon();
        },
        alarm: () => {
          if (this.profile.alarm) this.events.alarm();
        },
        error: (err) => {
          this.events.log(`protocol error: ${err.message}`);
          this.disconnect();
        },
      },
    );
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  async connect(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') return;
    this.wantConnected = true;
    this.clearTimers();
    this.session = this.createSession();
    this.signonDone = false;
    this.trace = [];
    this.traceStart = Date.now();
    this.setStatus('connecting', `${this.profile.host}:${this.profile.port}`, { attempt: this.reconnectAttempt + 1 });
    const connection = this.createTransport({
      data: (bytes) => {
        this.record('in', bytes);
        this.session.feed(bytes);
        this.touch();
      },
      close: () => {
        if (this.connection !== connection) return;
        this.connection = undefined;
        // Dropped right after negotiation with no screen: the workstation name is
        // most likely already in use (for example by an ACS session). Try the next one.
        const early = this.screensReceived === 0 && Date.now() - this.connectedAt < 8000;
        if (early && this.profile.deviceName && this.deviceRetries < 10) {
          const next = this.events.nextDeviceName?.();
          if (next) {
            this.deviceRetries += 1;
            this.events.log(`workstation ${this.profile.deviceName} refused by the host, trying ${next}`);
            this.profile.deviceName = next;
            this.status = 'idle';
            void this.connect();
            return;
          }
        }
        this.setStatus('disconnected', early && this.profile.deviceName ? `connection closed by host (workstation ${this.profile.deviceName} in use?)` : 'connection closed by host');
        this.publish();
        this.scheduleReconnect();
      },
      error: (err) => this.events.log(`socket error: ${err.message}`),
    });
    this.connection = connection;
    try {
      const auth = this.profile.tls ? await this.events.clientAuth?.() : undefined;
      await connection.connect({
        host: this.profile.host,
        port: this.profile.port,
        tls: this.profile.tls,
        trustAnyCertificate: !this.profile.verifyCertificate,
        timeoutMs: this.profile.connectTimeoutSeconds * 1000,
        keepAlive: this.profile.keepAlive,
        ...(auth ?? {}),
      });
    } catch (err) {
      if (this.connection !== connection) return; // cancelled or superseded meanwhile
      this.connection = undefined;
      this.setStatus('disconnected', friendlyNetError(err instanceof Error ? err.message : String(err), this.profile.host, this.profile.port));
      this.scheduleReconnect();
      return;
    }
    if (!this.wantConnected || this.connection !== connection) {
      // Cancelled while the connection was being set up.
      connection.close();
      return;
    }
    this.reconnectAttempt = 0;
    this.screensReceived = 0;
    this.connectedAt = Date.now();
    this.setStatus('connected', `${this.profile.host}:${this.profile.port}`);
    this.publish();
    this.touch();
  }

  /** Disconnects (or cancels a connect / pending reconnect) at the user's request. */
  disconnect(): void {
    this.wantConnected = false;
    this.clearTimers();
    const c = this.connection;
    this.connection = undefined;
    c?.close();
    this.setStatus('disconnected', 'disconnected', { attempt: 0, manual: true });
    this.publish();
  }

  /** Connects now, skipping the wait for a scheduled reconnect. */
  reconnectNow(): void {
    if (this.status === 'connecting' || this.status === 'connected') return;
    this.clearTimers();
    void this.connect();
  }

  dispose(): void {
    this.disconnect();
  }

  press(action: KeyAction): void {
    if (!this.connected) return;
    this.session.press(action);
    this.touch();
  }

  type(text: string): void {
    if (!this.connected) return;
    this.session.type(text);
    this.touch();
  }

  /** Moves the cursor to a cell (mouse click). */
  setCursor(row: number, col: number): void {
    if (!this.connected) return;
    this.session.setCursor(row, col);
  }

  publish(): void {
    this.events.screen(this.session.snapshot(), this.session.oia(this.connected));
  }

  /** Text of the current screen, nulls as blanks, one line per row. */
  screenText(): string {
    const snap = this.session.snapshot();
    const rows: string[] = [];
    for (let r = 0; r < snap.rows; r++) {
      rows.push(snap.text.slice(r * snap.cols, (r + 1) * snap.cols).split(NUL).join(' ').trimEnd());
    }
    return rows.join(LF);
  }

  /** Bypass sign-on: fill the first input screen after connecting (user, password, Enter). */
  private async maybeSignon(): Promise<void> {
    const { autoSignon, signonUser } = this.events.signon?.() ?? this.profile;
    const user = signonUser.trim();
    if (this.signonDone || !this.connected || !autoSignon || !user) return;
    const s = this.session.screen;
    const inputs = s.fields.filter((f) => !f.bypass);
    if (this.session.state.inputInhibited !== 'none' || inputs.length < 2) return;
    this.signonDone = true;
    const password = await this.events.password?.();
    if (!password) {
      this.events.log(`bypass sign-on: no password saved for ${user.toUpperCase()} (Settings > Connection > Set Password)`);
      return;
    }
    if (!this.connected) return;
    s.cursor = inputs[0]!.start;
    this.session.type(user);
    s.cursor = inputs[1]!.start;
    this.session.type(password);
    this.session.press('enter');
    this.events.log('bypass sign-on sent');
  }

  /** The raw byte trace of the current connection, loadable by `npm run dump`. */
  exportTrace(): Record<string, unknown> {
    return {
      description: `TN5250 trace (${this.session.terminalType}) - ${this.profile.name}`,
      port: this.profile.port,
      term: this.session.terminalType,
      negotiated: [],
      records: this.trace.filter((e) => e.dir === 'in' && e.hex.endsWith('ffef')).length,
      events: this.trace,
    };
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || !this.profile.autoReconnect) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] as number;
    this.reconnectAttempt += 1;
    this.events.log(`reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})`);
    this.setStatus('disconnected', this.lastDetail, { attempt: this.reconnectAttempt, retryAt: Date.now() + delay });
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /** Restarts the inactivity timer. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = this.profile.inactivityTimeoutMinutes;
    if (minutes > 0 && this.connected) {
      this.idleTimer = setTimeout(() => {
        this.events.log(`inactive for ${minutes} min, disconnecting`);
        this.disconnect();
      }, minutes * 60000);
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.reconnectTimer = undefined;
    this.idleTimer = undefined;
  }

  private record(dir: 'in' | 'out', bytes: Uint8Array): void {
    this.trace.push({ t: Date.now() - this.traceStart, dir, hex: hex(bytes) });
    if (this.trace.length > TRACE_LIMIT) this.trace.splice(0, this.trace.length - TRACE_LIMIT);
  }

  private setStatus(status: ConnectionStatus, detail: string, info: ConnectionInfo = { attempt: this.reconnectAttempt }): void {
    this.status = status;
    this.lastDetail = detail;
    this.events.status(status, detail, info);
  }
}
