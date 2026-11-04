import { CodePage } from './codepage';
import { DataStreamProcessor } from './datastream';
import {
  OP_CANCEL_INVITE,
  OP_MESSAGE_LIGHT_OFF,
  OP_MESSAGE_LIGHT_ON,
  buildRecord,
  parseRecord,
} from './gds';
import { Keyboard } from './keyboard';
import { detectPcCommand, type PcCommandRequest } from './pco';
import { Screen } from './screen';
import { TerminalState } from './state';
import { TelnetSession } from './telnet';
import type { KeyAction } from '../shared/keymap';
import type { OiaState, ScreenSnapshot } from '../shared/protocol';

export interface SessionOptions {
  /** '24x80' negotiates IBM-3179-2, '27x132' negotiates IBM-3477-FC. */
  screenSize?: '24x80' | '27x132';
  codePage?: number;
  deviceName?: string;
  /** KBDTYPE override for NEW-ENVIRON; empty = from the code page. */
  keyboardType?: string;
  /** Keep keys pressed while the keyboard is locked (X SYSTEM) and replay them when the host unlocks it. */
  typeAhead?: boolean;
  /** Answer the host's Query as an enhanced-interface device (GUI windows drawn by the terminal). Default on. */
  enhanced?: boolean;
}

/** Most keys kept while the keyboard is locked; ACS keeps a similar small buffer. */
export const TYPE_AHEAD_LIMIT = 256;

type QueuedKey = { kind: 'press'; action: KeyAction } | { kind: 'type'; text: string };

/** Keys that act immediately even while the keyboard is locked. */
const IMMEDIATE_ACTIONS = new Set<KeyAction>(['reset', 'attn', 'sysreq', 'testRequest', 'printScreen']);

export interface SessionEvents {
  /**
   * Bytes to write to the socket. `forTrace` is the same frame with the data of non-display
   * fields (passwords) blanked, for traces and logs; when absent the frame holds no secret.
   */
  send(bytes: Uint8Array, forTrace?: Uint8Array): void;
  /** The screen or status changed. */
  update?(): void;
  alarm?(): void;
  trace?(line: string): void;
  /** A protocol error; the session should be closed. */
  error?(err: Error): void;
  /**
   * The host wrote a PC Organizer request (STRPCCMD) and waits for Enter. Return true to
   * take it over: the screen is then not published, and the host must `press('enter')`
   * once the command was run (or refused). False shows the host's fallback screen.
   */
  pcCommand?(request: PcCommandRequest): boolean;
}

/**
 * A 5250 display session: telnet framing, data stream processing and the
 * screen model, with no I/O of its own. Feed it socket bytes; it emits bytes
 * to send through `events.send`.
 */
export class Session5250 {
  readonly screen = new Screen();
  readonly state = new TerminalState();
  readonly codePage: CodePage;
  readonly terminalType: string;
  readonly processor: DataStreamProcessor;
  readonly keyboard: Keyboard;
  private readonly telnet: TelnetSession;
  deviceName = '';
  typeAhead: boolean;
  private queue: QueuedKey[] = [];
  /** A PC Organizer request is being handled: nothing is published until the host writes again. */
  private quiet = false;

  constructor(
    options: SessionOptions,
    private readonly events: SessionEvents,
  ) {
    this.codePage = CodePage.get(options.codePage ?? 37);
    this.terminalType = options.screenSize === '27x132' ? 'IBM-3477-FC' : 'IBM-3179-2';
    this.deviceName = options.deviceName ?? '';
    this.typeAhead = options.typeAhead ?? true;
    this.processor = new DataStreamProcessor(
      this.screen,
      this.state,
      { terminalType: this.terminalType, enhanced: options.enhanced ?? true },
      this.codePage,
      { alarm: () => this.events.alarm?.(), trace: this.events.trace ? (l) => this.events.trace?.(l) : undefined },
    );
    this.keyboard = new Keyboard(this.screen, this.state, this.processor, this.codePage, {
      send: (opcode, flags1, data) => this.sendRecord(opcode, flags1, data, this.processor.takeSecretRanges()),
    });
    this.telnet = new TelnetSession(
      {
        terminalType: this.terminalType,
        deviceName: options.deviceName ?? '',
        codePage: this.codePage.ccsid,
        keyboardType: options.keyboardType ?? '',
      },
      {
        send: (bytes, forTrace) => this.events.send(bytes, forTrace),
        record: (record) => this.onRecord(record),
        environment: (vars) => {
          const name = vars.get('DEVNAME');
          if (name) this.deviceName = name;
        },
      },
    );
  }

  feed(bytes: Uint8Array): void {
    this.telnet.feed(bytes);
  }

  /** Presses a named key. */
  press(action: KeyAction): void {
    if (action === 'reset') this.queue = [];
    if (!IMMEDIATE_ACTIONS.has(action) && this.enqueue({ kind: 'press', action })) return;
    this.keyboard.press(action);
    this.notify();
  }

  /** Moves the cursor (mouse click); also leaves an operator error state. A window that restricts the cursor keeps clicks outside it from moving it. */
  setCursor(row: number, col: number): void {
    if (row < this.screen.rows && col < this.screen.cols && this.screen.cursorAllowed(this.screen.addr(row, col))) {
      this.keyboard.clearError();
      const addr = this.screen.addr(row, col);
      const hit = this.screen.selectionAt(addr);
      if (hit) {
        // A click on a choice selects it.
        this.keyboard.clickChoice(hit.sel, hit.choice);
        this.notify();
        return;
      }
      this.screen.cursor = addr;
      this.state.cursorPastEnd = false;
      this.state.autoAdvanced = false;
      // Pointer use outside an open pull-down: the host asked for its cancel AID.
      const pulldown = this.screen.selections.find((sel) => sel.cancelAid !== 0 && (sel.kind === 'singlePulldown' || sel.kind === 'multiplePulldown' || sel.kind === 'pushButtonsPulldown'));
      if (pulldown && this.state.inputInhibited === 'none') this.keyboard.pressAid(pulldown.cancelAid);
      this.notify();
    }
  }

  /** A pointer event at a cell for the host's Programmable Mouse Buttons table; true when the host took it. */
  mouseEvent(event: number, row: number, col: number): boolean {
    if (row >= this.screen.rows || col >= this.screen.cols) return false;
    const taken = this.keyboard.mouseEvent(event, row, col);
    if (taken) this.notify();
    return taken;
  }

  /** Pointer use of a host scroll bar: Roll AID with the increment; see Keyboard.scrollBar. */
  scrollBar(addr: number, forward: boolean, increment: number): void {
    this.keyboard.scrollBar(addr, forward, increment);
    this.notify();
  }

  /** Types text into the current field. */
  type(text: string): void {
    if (this.enqueue({ kind: 'type', text })) return;
    this.keyboard.type(text);
    this.notify();
  }

  private notify(): void {
    if (!this.quiet) this.events.update?.();
  }

  /** Number of keys waiting for the host to unlock the keyboard. */
  get queuedKeys(): number {
    return this.queue.length;
  }

  /** Keeps a key while the host has the keyboard locked; false if it should run now. */
  private enqueue(key: QueuedKey): boolean {
    if (!this.typeAhead || this.state.inputInhibited !== 'system') return false;
    if (this.queue.length < TYPE_AHEAD_LIMIT) this.queue.push(key);
    this.notify();
    return true;
  }

  /**
   * Replays type-ahead once the host unlocks the keyboard. Stops when a key
   * locks it again (an AID key) and leaves the rest for the next unlock; an
   * operator error or host error message discards the rest, as ACS does.
   */
  private drainQueue(): void {
    this.keyboard.flushQueuedMouse();
    while (this.queue.length > 0 && this.state.inputInhibited === 'none') {
      const key = this.queue.shift()!;
      if (key.kind === 'press') this.keyboard.press(key.action);
      else this.keyboard.type(key.text);
    }
    if (this.state.inputInhibited === 'error') this.queue = [];
  }

  snapshot(): ScreenSnapshot {
    const snap = this.screen.toSnapshot(this.codePage);
    if (snap.gui) snap.gui.mouseEvents = this.state.mouseButtons.map((d) => d.first);
    return snap;
  }

  oia(connected: boolean): OiaState {
    return {
      connected,
      inputInhibited: this.state.inputInhibited,
      insert: this.state.insert,
      messageWaiting: this.state.messageWaiting,
      deviceName: this.deviceName,
      message: this.state.errorMessage,
      queuedKeys: this.queue.length,
    };
  }

  /**
   * Sends a record to the host with GDS framing. `secret` lists the byte ranges of `data`
   * that hold non-display field data: the trace copy of the frame has them blanked.
   */
  sendRecord(opcode: number, flags1: number, data: Uint8Array, secret: Array<[number, number]> = []): void {
    const frame = buildRecord(opcode, flags1, data);
    if (secret.length === 0) {
      this.telnet.sendRecord(frame);
      return;
    }
    const masked = data.slice();
    for (const [start, end] of secret) masked.fill(0x40, start, end);
    this.telnet.sendRecord(frame, buildRecord(opcode, flags1, masked));
  }

  private onRecord(bytes: Uint8Array): void {
    let record;
    try {
      record = parseRecord(bytes);
    } catch (err) {
      this.events.error?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    switch (record.opcode) {
      case OP_MESSAGE_LIGHT_ON:
        this.state.messageWaiting = true;
        break;
      case OP_MESSAGE_LIGHT_OFF:
        this.state.messageWaiting = false;
        break;
      case OP_CANCEL_INVITE:
        this.sendRecord(OP_CANCEL_INVITE, 0, new Uint8Array(0));
        break;
      default:
        break;
    }
    this.quiet = false;
    if (record.data.length > 0) {
      for (const response of this.processor.process(record.data)) {
        this.sendRecord(response.opcode, 0, response.data, this.processor.takeSecretRanges());
      }
    }
    // STRPCCMD: the host wrote a PC command and reads the screen. When the host side takes
    // it, the screen stays as it was (no flash of the fallback text) and type-ahead waits for
    // the next real screen; the host side presses Enter to let the host program resume.
    if (this.state.pendingRead && this.events.pcCommand) {
      const request = detectPcCommand(this.screen, this.codePage);
      if (request && this.events.pcCommand(request)) {
        this.quiet = true;
        return;
      }
    }
    this.drainQueue();
    this.events.update?.();
  }
}
