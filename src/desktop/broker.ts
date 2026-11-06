/**
 * The broker page runs in a hidden window and owns every 5250 session: the session
 * controllers, the letters (A, B, C ...), the workstation names and the dialogs' decisions.
 * Visible windows render the screens and forward keystrokes; a session can therefore move
 * between windows, or outlive the window it was opened in. Messages: src/desktop/relay.ts.
 */
import { SessionController } from '../extension/sessionController';
import { expandDeviceName } from '../shared/deviceName';
import type { PcCommandKind } from '../shared/pcCommand';
import type { ConnectionStatus } from '../shared/protocol';
import { buildTitle, resolveSettings, type TerminalSettings } from '../shared/settings';
import { signonGate } from '../shared/signonGate';
import { errorText, goApp, onRelay, relay, type SystemInfo } from './bridge';
import { Credentials } from './credentials';
import { GoTransport } from './goTransport';
import { BROKER_WINDOW, MAIN_WINDOW, TabRegistry, type RegistryEntry, type ToBroker, type ToWindow } from './relay';
import { Store } from './store';

interface Session extends RegistryEntry {
  profile: TerminalSettings;
  deviceTemplate: string;
  detail: string;
  controller: SessionController;
}

/** Tabs opened per device-name template, so * and = produce distinct names. */
const deviceOrdinals = new Map<string, number>();
/** Session letters in use (ACS: A, B, C ...), app-wide. */
const letters = new Set<string>();

function nextLetter(): string {
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    if (!letters.has(l)) {
      letters.add(l);
      return l;
    }
  }
  return String(letters.size + 1);
}

function expandDevice(template: string, system: SystemInfo): string {
  const ordinal = deviceOrdinals.get(template) ?? 0;
  deviceOrdinals.set(template, ordinal + 1);
  return expandDeviceName(template, { computerName: system.computerName, userName: system.userName, ordinal });
}

class Broker {
  private readonly tabs = new TabRegistry<Session>();
  private readonly store = new Store();
  private readonly credentials = new Credentials(this.store);
  private system: SystemInfo = { computerName: '', userName: '', platform: '' };
  private asks = new Map<string, { window: string; resolve: (ok: boolean) => void }>();
  private askCounter = 0;
  /** Windows whose page has said hello (events reach them). */
  private readonly windows = new Set<string>();
  /** Tabs handed to a window that has not said hello yet. */
  private readonly pendingMoves = new Map<string, string[]>();

  async start(): Promise<void> {
    await this.store.load();
    try {
      this.system = await goApp().SystemInfo();
    } catch {
      // keep the empty defaults
    }
    onRelay((msg) => void this.onMessage(msg as ToBroker));
    // Windows that loaded before this page may have sent their hello into the void.
    try {
      for (const w of (await goApp().WindowList()) ?? []) this.send(w.name, { type: 'broker:ready' });
    } catch {
      // no windows yet
    }
  }

  private opened(s: Session): Omit<Extract<ToWindow, { type: 'tab:opened' }>, 'type'> {
    return { tab: s.tab, letter: s.letter, profile: s.profile, deviceTemplate: s.deviceTemplate, status: s.status, detail: s.detail };
  }

  private send(window: string, msg: ToWindow): void {
    void relay(window, msg).catch(() => undefined);
  }

  private broadcastRegistry(): void {
    const tabs = this.tabs.snapshot();
    for (const w of new Set([...this.windows, ...this.tabs.windows()])) this.send(w, { type: 'registry', tabs });
  }

  /** The window that takes over the sessions of a closing one: main, else any other. */
  private homeFor(closing: string): string | undefined {
    if (this.windows.has(MAIN_WINDOW) && closing !== MAIN_WINDOW) return MAIN_WINDOW;
    return [...this.windows].find((w) => w !== closing);
  }

  private async onMessage(msg: ToBroker): Promise<void> {
    switch (msg.type) {
      case 'window:hello':
        this.windows.add(msg.window);
        this.send(msg.window, { type: 'registry', tabs: this.tabs.snapshot() });
        for (const tab of this.pendingMoves.get(msg.window) ?? []) {
          const s = this.tabs.get(tab);
          if (s && s.window === msg.window) {
            this.send(msg.window, { type: 'tab:opened', ...this.opened(s) });
            s.controller.publish();
          }
        }
        this.pendingMoves.delete(msg.window);
        break;
      case 'window:closed': {
        this.windows.delete(msg.window);
        this.pendingMoves.delete(msg.window);
        // Its sessions stay alive in another window; with no window left the app is quitting.
        const home = this.homeFor(msg.window);
        for (const s of this.tabs.byWindow(msg.window)) {
          if (!home) {
            this.close(s.tab);
            continue;
          }
          this.tabs.move(s.tab, home);
          this.send(home, { type: 'tab:opened', ...this.opened(s) });
          s.controller.publish();
        }
        for (const [id, ask] of this.asks) {
          if (ask.window === msg.window) {
            ask.resolve(false);
            this.asks.delete(id);
          }
        }
        this.broadcastRegistry();
        break;
      }
      case 'store:changed':
        await this.store.load();
        // Settings saved or a password set: a paused bypass sign-on may try again, one session at a time.
        signonGate.rearmAll();
        break;
      case 'tab:open':
        this.open(msg.tab, msg.window, msg.profile);
        break;
      case 'tab:input': {
        const s = this.tabs.get(msg.tab);
        if (!s) break;
        const c = s.controller;
        const m = msg.msg;
        switch (m.type) {
          case 'ready':
            c.publish();
            // A frame that loads while the session runs (tab moved to another window) must
            // not sit on "Not connected": status events only report changes.
            this.send(s.window, { type: 'tab:output', tab: s.tab, msg: { type: 'status', ...c.connectionState } });
            this.send(s.window, { type: 'tab:state', tab: s.tab, status: s.status, detail: s.detail });
            if (s.profile.autoConnect !== false) void c.connect();
            break;
          case 'action':
            c.press(m.action);
            break;
          case 'text':
            c.type(m.text);
            break;
          case 'click':
            c.setCursor(m.row, m.col);
            break;
          case 'scroll':
            c.scrollBar(m.addr, m.forward, m.increment);
            break;
          case 'mouse':
            c.mouseEvent(m.event, m.row, m.col);
            break;
          case 'reconnect':
            c.reconnectNow();
            break;
          case 'cancelReconnect':
            c.disconnect();
            break;
        }
        break;
      }
      case 'tab:reload':
        this.reload(msg.tab, msg.profile);
        break;
      case 'tab:move': {
        const s = this.tabs.get(msg.tab);
        if (!s) break;
        this.tabs.move(msg.tab, msg.window);
        if (this.windows.has(msg.window)) {
          this.send(msg.window, { type: 'tab:opened', ...this.opened(s) });
          s.controller.publish();
        } else {
          this.pendingMoves.set(msg.window, [...(this.pendingMoves.get(msg.window) ?? []), msg.tab]);
        }
        this.broadcastRegistry();
        break;
      }
      case 'tab:close':
        this.close(msg.tab);
        break;
      case 'tab:trace': {
        const s = this.tabs.get(msg.tab);
        if (s) this.send(s.window, { type: 'tab:trace', tab: s.tab, request: msg.request, trace: s.controller.exportTrace() });
        break;
      }
      case 'ui:answer': {
        const ask = this.asks.get(msg.request);
        if (ask) {
          this.asks.delete(msg.request);
          ask.resolve(msg.ok);
        }
        break;
      }
    }
  }

  /** A yes/no dialog shown by the window that owns the tab; false when it closes first. */
  private ask(s: Session, title: string, text: string, ok: string, then?: 'openSettings'): Promise<boolean> {
    const request = `ask-${++this.askCounter}`;
    return new Promise((resolve) => {
      this.asks.set(request, { window: s.window, resolve });
      this.send(s.window, { type: 'ui:ask', request, tab: s.tab, title, text, ok, then });
    });
  }

  /** The profile's connection values with the live settings (bypass sign-on follows the settings page). */
  private liveSettings(p: TerminalSettings): TerminalSettings {
    const saved = this.store.resolvedSessions().find((s) => s.name === p.name && s.host === p.host);
    return { ...(saved ?? this.store.readDefaults()), host: p.host, port: p.port, tls: p.tls, name: p.name, screenSize: p.screenSize, codePage: p.codePage, deviceName: p.deviceName };
  }

  private open(tab: string, window: string, profile: TerminalSettings): void {
    if (this.tabs.get(tab)) return;
    let deviceTemplate = '';
    if (profile.deviceName.trim()) {
      deviceTemplate = profile.deviceName.trim();
      profile = { ...profile, deviceName: expandDevice(deviceTemplate, this.system) };
    }
    const letter = nextLetter();
    const label = profile.name || profile.host;
    const s: Session = {
      tab,
      window,
      letter,
      title: buildTitle(profile, letter),
      name: profile.name,
      host: profile.host,
      port: profile.port,
      status: 'idle',
      detail: '',
      profile,
      deviceTemplate,
      controller: undefined as unknown as SessionController,
    };
    s.controller = new SessionController(
      profile,
      {
        screen: (screen, oia) => {
          this.send(s.window, { type: 'tab:output', tab, msg: { type: 'screen', screen } });
          this.send(s.window, { type: 'tab:output', tab, msg: { type: 'oia', oia } });
        },
        status: (status, detail, info) => {
          s.status = status;
          s.detail = detail;
          this.send(s.window, { type: 'tab:output', tab, msg: { type: 'status', status, detail, info } });
          this.send(s.window, { type: 'tab:state', tab, status, detail });
          this.send(s.window, { type: 'tab:log', tab, line: `[${label}] ${status}: ${detail}` });
          this.broadcastRegistry();
        },
        alarm: () => this.send(s.window, { type: 'tab:output', tab, msg: { type: 'alarm' } }),
        nextDeviceName: () => (/[*=]/.test(s.deviceTemplate) ? expandDevice(s.deviceTemplate, this.system) : undefined),
        signon: () => this.liveSettings(s.profile),
        password: async () => (await this.credentials.find(this.liveSettings(s.profile).signonUser, s.profile.host, s.profile.name)) || undefined,
        log: (message) => this.send(s.window, { type: 'tab:log', tab, line: `[${label}] ${message}` }),
        pcCommandPolicy: () => this.liveSettings(s.profile).pcCommands,
        pcCommand: (kind, decision, wait) => this.handlePcCommand(s, kind, decision, wait),
        certificateRejected: (fingerprint, reason) => void this.offerTrust(s, fingerprint, reason),
        signonHint: (info) => void this.signonHint(s, info.codePage, info.chars, info.paused === true),
        signonFailed: (info) => void this.signonFailed(s, info.key),
      },
      (events) => new GoTransport(events),
    );
    this.tabs.add(s);
    this.windows.add(window);
    this.send(window, { type: 'tab:opened', ...this.opened(s) });
    this.broadcastRegistry();
  }

  /** Save & Reload from a settings page: new connection values, reconnect. */
  private reload(tab: string, profile: TerminalSettings): void {
    const s = this.tabs.get(tab);
    if (!s) return;
    const template = profile.deviceName.trim();
    const deviceName = template === s.deviceTemplate ? s.profile.deviceName : template ? expandDevice(template, this.system) : '';
    s.deviceTemplate = template;
    // The controller shares the profile object: assigning onto it is enough.
    Object.assign(s.profile, { ...profile, deviceName });
    s.name = s.profile.name;
    s.host = s.profile.host;
    s.port = s.profile.port;
    s.title = buildTitle(s.profile, s.letter);
    s.controller.disconnect();
    this.send(s.window, { type: 'tab:opened', ...this.opened(s) });
    void s.controller.connect();
    this.broadcastRegistry();
  }

  private close(tab: string): void {
    const s = this.tabs.remove(tab);
    if (!s) return;
    letters.delete(s.letter);
    s.controller.dispose();
    this.send(s.window, { type: 'tab:gone', tab });
    this.broadcastRegistry();
  }

  private async signonHint(s: Session, codePage: number, chars: string[], paused: boolean): Promise<void> {
    await this.ask(
      s,
      'Sign-on failed: check the code page',
      `The password contains characters that are different in other code pages (${chars.join(' ')}). This session uses code page ${codePage}; the host reads what you type with its own CCSID (QCCSID or the user profile). If the user ID and password are right, set Host Code Page to the host's value. Each failed attempt counts toward QMAXSIGN.${paused ? ' Bypass sign-on is paused for this user and host in every session until the settings are saved.' : ''}`,
      'Open Settings',
      'openSettings',
    );
  }

  /** A bypass sign-on was refused: it is paused for that user and host so QMAXSIGN is not used up. */
  private async signonFailed(s: Session, key: string): Promise<void> {
    await this.ask(
      s,
      'Bypass sign-on paused',
      `The bypass sign-on for ${key} was refused (the host showed the sign-on screen again). Bypass sign-on is paused for this user and host in every session, so the failed attempts do not reach QMAXSIGN. Check the saved password and the user ID; saving the settings or setting the password tries again, one session at a time.`,
      'Open Settings',
      'openSettings',
    );
  }

  private async offerTrust(s: Session, fingerprint: string, reason: string): Promise<void> {
    const pretty = fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase().replace(/(..)(?=.)/g, '$1:');
    const ok = await this.ask(
      s,
      'Certificate not accepted',
      `${s.profile.host}: ${reason}.\n\nSHA-256 fingerprint:\n${pretty}\n\nTrust it only if this fingerprint matches what the system administrator shows for this host.`,
      'Trust this certificate',
    );
    if (!ok) return;
    s.profile.tlsPinnedCertificate = fingerprint;
    const index = this.store.readSessions().findIndex((x) => x.name === s.profile.name && x.host === s.profile.host);
    if (index >= 0) {
      const saved = this.store.readSessions()[index];
      if (saved) await this.store.saveSession(index, { ...resolveSettings(this.store.readDefaults(), saved), tlsPinnedCertificate: fingerprint });
    }
    this.send(s.window, { type: 'tab:log', tab: s.tab, line: `[${s.title}] certificate ${pretty} trusted for this session` });
    s.controller.reconnectNow();
  }

  private async handlePcCommand(s: Session, kind: PcCommandKind, decision: 'open' | 'run' | 'ask', wait: boolean): Promise<void> {
    if (kind.kind === 'link') {
      if (decision === 'ask' && !(await this.ask(s, 'Open link', `${s.title}: the host wants to open\n${kind.url}`, 'Open'))) return;
      await goApp().OpenURL(kind.url);
      this.send(s.window, { type: 'tab:notify', tab: s.tab, text: `Opened ${kind.url}` });
      return;
    }
    if (decision === 'ask' && !(await this.ask(s, 'PC command from host', `${s.title}: the host wants to run this command on your PC:\n${kind.command}`, 'Run'))) {
      this.send(s.window, { type: 'tab:log', tab: s.tab, line: `[${s.title}] PC command not run: ${kind.command}` });
      return;
    }
    try {
      await goApp().RunPcCommand(kind.command, wait);
    } catch (err) {
      this.send(s.window, { type: 'tab:log', tab: s.tab, line: `[${s.title}] PC command failed: ${errorText(err)}` });
    }
  }
}

export { BROKER_WINDOW };
export type { ConnectionStatus };

void new Broker().start();
