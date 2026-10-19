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
  /** Keep keys pressed while the keyboard is locked (X SYSTEM) and replay them when the host unlocks it. */
  typeAhead?: boolean;
}

/** Most keys kept while the keyboard is locked; ACS keeps a similar small buffer. */
export const TYPE_AHEAD_LIMIT = 256;

type QueuedKey = { kind: 'press'; action: KeyAction } | { kind: 'type'; text: string };

/** Keys that act immediately even while the keyboard is locked. */
const IMMEDIATE_ACTIONS = new Set<KeyAction>(['reset', 'attn', 'sysreq', 'printScreen']);

export interface SessionEvents {
  /** Bytes to write to the socket. */
  send(bytes: Uint8Array): void;
  /** The screen or status changed. */
  update?(): void;
  alarm?(): void;
  trace?(line: string): void;
  /** A protocol error; the session should be closed. */
  error?(err: Error): void;
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
      { terminalType: this.terminalType },
      this.codePage,
      { alarm: () => this.events.alarm?.(), trace: this.events.trace ? (l) => this.events.trace?.(l) : undefined },
    );
    this.keyboard = new Keyboard(this.screen, this.state, this.processor, this.codePage, {
      send: (opcode, flags1, data) => this.sendRecord(opcode, flags1, data),
    });
    this.telnet = new TelnetSession(
      {
        terminalType: this.terminalType,
        deviceName: options.deviceName ?? '',
        codePage: this.codePage.ccsid,
      },
      {
        send: (bytes) => this.events.send(bytes),
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
    this.events.update?.();
  }

  /** Moves the cursor (mouse click); also leaves an operator error state. */
  setCursor(row: number, col: number): void {
    if (row < this.screen.rows && col < this.screen.cols) {
      this.keyboard.clearError();
      this.screen.cursor = this.screen.addr(row, col);
      this.events.update?.();
    }
  }

  /** Types text into the current field. */
  type(text: string): void {
    if (this.enqueue({ kind: 'type', text })) return;
    this.keyboard.type(text);
    this.events.update?.();
  }

  /** Number of keys waiting for the host to unlock the keyboard. */
  get queuedKeys(): number {
    return this.queue.length;
  }

  /** Keeps a key while the host has the keyboard locked; false if it should run now. */
  private enqueue(key: QueuedKey): boolean {
    if (!this.typeAhead || this.state.inputInhibited !== 'system') return false;
    if (this.queue.length < TYPE_AHEAD_LIMIT) this.queue.push(key);
    this.events.update?.();
    return true;
  }

  /**
   * Replays type-ahead once the host unlocks the keyboard. Stops when a key
   * locks it again (an AID key) and leaves the rest for the next unlock; an
   * operator error or host error message discards the rest, as ACS does.
   */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.state.inputInhibited === 'none') {
      const key = this.queue.shift()!;
      if (key.kind === 'press') this.keyboard.press(key.action);
      else this.keyboard.type(key.text);
    }
    if (this.state.inputInhibited === 'error') this.queue = [];
  }

  snapshot(): ScreenSnapshot {
    return this.screen.toSnapshot(this.codePage);
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

  /** Sends a record to the host with GDS framing. */
  sendRecord(opcode: number, flags1: number, data: Uint8Array): void {
    this.telnet.sendRecord(buildRecord(opcode, flags1, data));
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
    if (record.data.length > 0) {
      for (const response of this.processor.process(record.data)) {
        this.sendRecord(response.opcode, 0, response.data);
      }
    }
    this.drainQueue();
    this.events.update?.();
  }
}
