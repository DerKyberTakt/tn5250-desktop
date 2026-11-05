import type { PcCommandRequest } from '../engine/pco';
import type { Field } from '../engine/screen';
import { Session5250 } from '../engine/session';
import { variantChars } from '../engine/variant';
import type { KeyAction } from '../shared/keymap';
import { friendlyNetError } from '../shared/netErrors';
import { isSignonScreen } from '../shared/screenText';
import { classifyPcCommand, decidePcCommand, type PcCommandDecision, type PcCommandKind, type PcCommandPolicy } from '../shared/pcCommand';
import type { ConnectionInfo, ConnectionStatus, OiaState, ScreenSnapshot } from '../shared/protocol';
import type { TerminalSettings } from '../shared/settings';
import { CertificateError } from '../shared/tlsTrust';
import type { Transport, TransportFactory } from './connection';

export interface SessionControllerEvents {
  screen(snapshot: ScreenSnapshot, oia: OiaState): void;
  status(status: ConnectionStatus, detail: string, info: ConnectionInfo): void;
  alarm(): void;
  log(message: string): void;
  /**
   * STRPCCMD: run (or open) what the host asked for. `decision` already applied the
   * policy: 'open' a link, 'run' a command, or 'ask' the user first. Resolve when done
   * (after the command exits when `wait` is set); the controller then presses Enter.
   */
  pcCommand?(kind: PcCommandKind, decision: Exclude<PcCommandDecision, 'ignore'>, wait: boolean): Promise<void>;
  /** The live PC command policy (settings page); the opening profile is used without it. */
  pcCommandPolicy?(): PcCommandPolicy;
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
  /**
   * The host certificate was refused (chain not verified, or not the pinned one). The host
   * side may offer to trust it: save the fingerprint on the profile and connect again.
   */
  certificateRejected?(fingerprint: string, reason: string): void;
  /**
   * A sign-on attempt failed (the host answered with the Sign On screen again) and the
   * password held characters that mean something else in another code page (! @ [ ] ...).
   * The session's code page may not match the host's CCSID. Raised once per connection;
   * `chars` lists the variant characters only, never the password.
   */
  signonHint?(info: SignonHint): void;
}

export interface SignonHint {
  codePage: number;
  chars: string[];
}

/**
 * One entry of a session trace (the tn5250-trace-*.json format both apps save: raw telnet
 * bytes per direction, the data of non-display fields blanked on the way out).
 */
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
  private signonSkipLogged = false;
  /** Enter was pressed on a sign-on screen whose password field holds variant characters. */
  private pendingSignon: { chars: string[]; screens: number } | undefined;
  private signonHintShown = false;
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
        keyboardType: this.profile.keyboardType,
        typeAhead: this.profile.typeAhead,
      },
      {
        send: (bytes, forTrace) => {
          // The trace keeps the masked copy: what was typed into a non-display field
          // (the password) never leaves the socket path.
          this.record('out', forTrace ?? bytes);
          this.connection?.write(bytes);
        },
        update: () => {
          this.screensReceived += 1;
          this.checkSignon();
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
        pcCommand: (request) => this.onPcCommand(request),
      },
    );
  }

  /**
   * STRPCCMD / PC Organizer: the host wrote a PC command and waits. The policy decides
   * whether it opens, runs, asks or is ignored; whatever happens, Enter goes back to the
   * host so its program resumes (a declined command just does nothing on the PC).
   */
  private onPcCommand(request: PcCommandRequest): boolean {
    const policy = this.events.pcCommandPolicy?.() ?? this.profile.pcCommands;
    const kind = classifyPcCommand(request.command);
    const decision = decidePcCommand(policy, kind);
    this.events.log(`PC command from host (${decision}): ${request.command}`);
    if (decision === 'ignore' || !this.events.pcCommand) return false;
    const session = this.session;
    void this.events
      .pcCommand(kind, decision, request.wait)
      .catch((err: unknown) => this.events.log(`PC command failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.session === session && this.connected) session.press('enter');
      });
    return true;
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
    this.signonSkipLogged = false;
    this.pendingSignon = undefined;
    this.signonHintShown = false;
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
    const signon = this.events.signon?.() ?? this.profile;
    if (signon.autoSignon && !this.profile.tls) {
      this.events.log('warning: bypass sign-on over plain telnet sends the user profile and password unencrypted; use TLS (port 992) where the host offers it');
    }
    try {
      const auth = this.profile.tls ? await this.events.clientAuth?.() : undefined;
      await connection.connect({
        host: this.profile.host,
        port: this.profile.port,
        tls: this.profile.tls,
        trustAnyCertificate: !this.profile.verifyCertificate,
        pinnedFingerprint: this.profile.tlsPinnedCertificate || undefined,
        caFile: this.profile.tlsCaFile || undefined,
        timeoutMs: this.profile.connectTimeoutSeconds * 1000,
        keepAlive: this.profile.keepAlive,
        ...(auth ?? {}),
      });
    } catch (err) {
      if (this.connection !== connection) return; // cancelled or superseded meanwhile
      this.connection = undefined;
      this.setStatus('disconnected', friendlyNetError(err instanceof Error ? err.message : String(err), this.profile.host, this.profile.port));
      if (err instanceof CertificateError) {
        // No point retrying the same certificate; the user decides.
        this.wantConnected = false;
        this.events.certificateRejected?.(err.fingerprint, err.reason);
        return;
      }
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
    if (action === 'enter') this.armSignon();
    this.session.press(action);
    this.touch();
  }

  /** Screens the host may send after a sign-on attempt before the hint gives up. */
  private static readonly SIGNON_ANSWER_SCREENS = 3;

  /**
   * Enter on a sign-on screen: remember whether the password field holds characters
   * that differ between code pages, so a failed attempt can point at the code page.
   * Only the list of such characters is kept, never the field's content.
   */
  private armSignon(): void {
    this.pendingSignon = undefined;
    const passwordField = this.signonPasswordField();
    if (!passwordField) return;
    const chars = variantChars(this.session.screen.fieldBytes(passwordField), this.session.codePage);
    if (chars.length) this.pendingSignon = { chars, screens: 0 };
  }

  /** Entry fields of a sign-on screen beyond user and password (program, menu, library ...). */
  private static readonly SIGNON_MAX_FIELDS = 6;

  /**
   * The password field of a sign-on screen, or undefined when the screen is not one. A
   * sign-on screen says "Sign On" near the top, or has the sign-on shape: a visible user
   * field first and exactly one non-display field among a few entry fields. Customised
   * screens (PUB400's "Welcome" banner, other languages) have the shape without the words;
   * a Change Password screen has three non-display fields and is left alone.
   */
  private signonPasswordField(): Field | undefined {
    const inputs = this.session.screen.fields.filter((f) => !f.bypass);
    const hidden = inputs.filter((f) => (f.attr & 0x07) === 0x07);
    if (hidden.length !== 1 || inputs.length < 2 || inputs.length > SessionController.SIGNON_MAX_FIELDS) return undefined;
    if (inputs[0] === hidden[0] && !isSignonScreen(this.screenText())) return undefined;
    return hidden[0];
  }

  /** The host's answer to a sign-on attempt: the Sign On screen again means it failed. */
  private checkSignon(): void {
    const pending = this.pendingSignon;
    if (!pending) return;
    if (this.session.state.inputInhibited !== 'none') {
      if (++pending.screens > SessionController.SIGNON_ANSWER_SCREENS) this.pendingSignon = undefined;
      return;
    }
    this.pendingSignon = undefined;
    if (!this.signonPasswordField() || this.signonHintShown) return;
    this.signonHintShown = true;
    const codePage = this.session.codePage.ccsid;
    this.events.log(`sign-on failed and the password has characters that differ between code pages (${pending.chars.join(' ')}); this session uses code page ${codePage}: check Host Code Page against the host's CCSID (README > Troubleshooting)`);
    this.events.signonHint?.({ codePage, chars: pending.chars });
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

  /** Pointer use of a host scroll bar (arrow, page, slider drag). */
  scrollBar(addr: number, forward: boolean, increment: number): void {
    if (!this.connected) return;
    this.session.scrollBar(addr, forward, increment);
    this.touch();
  }

  /** A pointer event for the host's Programmable Mouse Buttons table. */
  mouseEvent(event: number, row: number, col: number): void {
    if (!this.connected) return;
    if (this.session.mouseEvent(event, row, col)) this.touch();
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

  /** Screens after connect on which bypass sign-on may still act (sign-on may follow a message screen). */
  private static readonly SIGNON_SCREENS = 5;

  /**
   * Bypass sign-on: fill the Sign On screen (user, password, Enter). The password goes
   * only into a non-display field: a message screen, a changed sign-on display or a
   * hostile host never gets it in a field that shows, and never after the first screens.
   */
  private async maybeSignon(): Promise<void> {
    const { autoSignon, signonUser } = this.events.signon?.() ?? this.profile;
    const user = signonUser.trim();
    if (this.signonDone || !this.connected || !autoSignon || !user) return;
    if (this.screensReceived > SessionController.SIGNON_SCREENS) return;
    const s = this.session.screen;
    const inputs = s.fields.filter((f) => !f.bypass);
    if (this.session.state.inputInhibited !== 'none' || inputs.length < 2) return;
    const userField = inputs[0]!;
    const passwordField = inputs.find((f) => f !== userField && (f.attr & 0x07) === 0x07);
    if (!passwordField) {
      if (!this.signonSkipLogged) this.events.log('bypass sign-on skipped: no non-display password field on this screen');
      this.signonSkipLogged = true;
      return;
    }
    this.signonDone = true;
    const password = await this.events.password?.();
    if (!password) {
      this.events.log(`bypass sign-on: no password saved for ${user.toUpperCase()} (Settings > Connection > Set Password)`);
      return;
    }
    if (!this.connected) return;
    s.cursor = userField.start;
    this.session.type(user);
    s.cursor = passwordField.start;
    this.session.type(password);
    this.armSignon();
    this.session.press('enter');
    this.events.log('bypass sign-on sent');
  }

  /** The byte trace of the current connection (tn5250-trace-*.json); non-display field data is blanked. */
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
