import { hostNls } from './nls';

/**
 * Telnet layer for TN5250 (RFC 1205 / RFC 2877): option negotiation, IAC
 * escaping and END-OF-RECORD framing. Pure: bytes in, bytes out via callbacks.
 */

export const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const EOR_CMD = 239;

export const OPT_BINARY = 0;
export const OPT_SGA = 3;
export const OPT_EOR = 25;
export const OPT_TERMINAL_TYPE = 24;
export const OPT_NEW_ENVIRON = 39;

const TT_IS = 0;
const TT_SEND = 1;
const NE_IS = 0;
const NE_SEND = 1;
const NE_VAR = 0;
const NE_VALUE = 1;
const NE_USERVAR = 3;

export interface TelnetOptions {
  /** e.g. IBM-3477-FC (27x132) or IBM-3179-2 (24x80). */
  terminalType: string;
  /** Requested device name; empty lets the host assign one. */
  deviceName?: string;
  /** Sent as the CODEPAGE user variable, with KBDTYPE and CHARSET, in the NEW-ENVIRON reply. */
  codePage?: number;
  /** KBDTYPE override (3 letters); empty = the one for the code page. */
  keyboardType?: string;
}

export interface TelnetCallbacks {
  /** `forTrace`: the same frame with secrets blanked, when the record held any. */
  send(bytes: Uint8Array, forTrace?: Uint8Array): void;
  record(record: Uint8Array): void;
  /** Variables the host reports back through NEW-ENVIRON (e.g. DEVNAME). */
  environment?(vars: Map<string, string>): void;
  /** The host broke a limit (record or subnegotiation too long); the session is dead and ignores further bytes. */
  error?(err: Error): void;
}

/** Largest 5250 record accepted (the GDS length is 16 bits; real records are a few KB). A host that sends more without IAC EOR is cut off. */
export const MAX_RECORD_BYTES = 1 << 20;
/** Largest IAC SB ... IAC SE body accepted (real ones are under 100 bytes). */
export const MAX_SUBNEGOTIATION_BYTES = 1024;
/** feed() works through a chunk in pieces of this size, so one huge chunk never sits in the pending buffer whole. */
const FEED_SLICE = 16 * 1024;

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0x7f);

export class TelnetSession {
  private pending: number[] = [];
  private record: number[] = [];
  private readonly agreed = new Set<number>();
  /** Bytes of the open IAC SB at the start of `pending` that the scan for IAC SE has already passed. */
  private sbScanned = 0;
  private failed = false;

  constructor(
    private readonly options: TelnetOptions,
    private readonly callbacks: TelnetCallbacks,
  ) {}

  get negotiatedOptions(): ReadonlySet<number> {
    return this.agreed;
  }

  /** Feeds bytes from the socket. */
  feed(chunk: Uint8Array): void {
    for (let off = 0; off < chunk.length && !this.failed; off += FEED_SLICE) {
      const end = Math.min(off + FEED_SLICE, chunk.length);
      for (let k = off; k < end; k++) this.pending.push(chunk[k] as number);
      this.parse();
    }
  }

  private fail(message: string): void {
    this.failed = true;
    this.pending = [];
    this.record = [];
    this.sbScanned = 0;
    this.callbacks.error?.(new Error(message));
  }

  /** Sends one 5250 record: escapes IAC and appends IAC EOR. `forTrace` is framed the same way. */
  sendRecord(record: Uint8Array, forTrace?: Uint8Array): void {
    const frame = (bytes: Uint8Array): Uint8Array => {
      const out: number[] = [];
      for (const b of bytes) {
        out.push(b);
        if (b === IAC) out.push(IAC);
      }
      out.push(IAC, EOR_CMD);
      return Uint8Array.from(out);
    };
    this.callbacks.send(frame(record), forTrace ? frame(forTrace) : undefined);
  }

  private reply(...bytes: number[]): void {
    this.callbacks.send(Uint8Array.from(bytes));
  }

  private parse(): void {
    const buf = this.pending;
    let i = 0;
    while (i < buf.length) {
      const b = buf[i] as number;
      if (b !== IAC) {
        this.record.push(b);
        i += 1;
        if (this.record.length > MAX_RECORD_BYTES) return this.fail(`record longer than ${MAX_RECORD_BYTES} bytes without IAC EOR`);
        continue;
      }
      if (i + 1 >= buf.length) break;
      const cmd = buf[i + 1] as number;
      if (cmd === IAC) {
        this.record.push(IAC);
        i += 2;
        if (this.record.length > MAX_RECORD_BYTES) return this.fail(`record longer than ${MAX_RECORD_BYTES} bytes without IAC EOR`);
        continue;
      }
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        if (i + 2 >= buf.length) break;
        this.negotiate(cmd, buf[i + 2] as number);
        i += 3;
        continue;
      }
      if (cmd === SB) {
        // Resume where the last feed stopped scanning (the open SB is at the start of pending).
        let j = i + 2 + (i === 0 ? this.sbScanned : 0);
        while (j + 1 < buf.length && !((buf[j] as number) === IAC && (buf[j + 1] as number) === SE)) j += 1;
        if (j - (i + 2) > MAX_SUBNEGOTIATION_BYTES) return this.fail(`subnegotiation longer than ${MAX_SUBNEGOTIATION_BYTES} bytes`);
        if (j + 1 >= buf.length) {
          this.sbScanned = j - (i + 2);
          break;
        }
        this.sbScanned = 0;
        this.subnegotiate(buf.slice(i + 2, j));
        i = j + 2;
        continue;
      }
      if (cmd === EOR_CMD) {
        const rec = Uint8Array.from(this.record);
        this.record = [];
        i += 2;
        this.callbacks.record(rec);
        continue;
      }
      // Other two-byte commands (NOP, GA, ...) are ignored.
      i += 2;
    }
    this.pending = buf.slice(i);
  }

  private negotiate(cmd: number, opt: number): void {
    if (cmd === DO) {
      const ok = opt === OPT_BINARY || opt === OPT_EOR || opt === OPT_TERMINAL_TYPE || opt === OPT_NEW_ENVIRON;
      if (ok) this.agreed.add(opt);
      this.reply(IAC, ok ? WILL : WONT, opt);
    } else if (cmd === WILL) {
      const ok = opt === OPT_BINARY || opt === OPT_EOR || opt === OPT_SGA;
      if (ok) this.agreed.add(opt);
      this.reply(IAC, ok ? DO : DONT, opt);
    }
    // DONT / WONT need no answer.
  }

  private subnegotiate(sub: number[]): void {
    const opt = sub[0];
    if (opt === OPT_TERMINAL_TYPE && sub[1] === TT_SEND) {
      this.reply(IAC, SB, OPT_TERMINAL_TYPE, TT_IS, ...ascii(this.options.terminalType), IAC, SE);
    } else if (opt === OPT_NEW_ENVIRON && sub[1] === NE_SEND) {
      this.reply(IAC, SB, OPT_NEW_ENVIRON, NE_IS, ...this.environmentReply(), IAC, SE);
    } else if (opt === OPT_NEW_ENVIRON && (sub[1] === NE_IS || sub[1] === 2)) {
      this.callbacks.environment?.(parseEnvironment(sub.slice(2)));
    }
  }

  private environmentReply(): number[] {
    const out: number[] = [];
    const name = (this.options.deviceName ?? '').trim().toUpperCase();
    if (name) out.push(NE_USERVAR, ...ascii('DEVNAME'), NE_VALUE, ...ascii(name));
    // KBDTYPE, CODEPAGE and CHARSET belong together (RFC 4777 section 4: the last two
    // only count beside a KBDTYPE) and go with or without a device name: the host gives
    // the virtual device it creates (QPADEVnnnn too) that keyboard type and character set,
    // which is what turns the job's CCSID into the right letters on the screen. A code page
    // the table does not know sends none of them and the host uses its system values.
    const nls = this.options.codePage ? hostNls(this.options.codePage, this.options.keyboardType) : undefined;
    if (nls) {
      out.push(NE_USERVAR, ...ascii('KBDTYPE'), NE_VALUE, ...ascii(nls.kbdType));
      out.push(NE_USERVAR, ...ascii('CODEPAGE'), NE_VALUE, ...ascii(String(this.options.codePage)));
      out.push(NE_USERVAR, ...ascii('CHARSET'), NE_VALUE, ...ascii(nls.charset));
    }
    return out;
  }
}

/** Parses NEW-ENVIRON "IS"/"INFO" payloads into name -> value. */
export function parseEnvironment(bytes: number[]): Map<string, string> {
  const vars = new Map<string, string>();
  let i = 0;
  let name = '';
  let value = '';
  let inValue = false;
  const flush = (): void => {
    if (name) vars.set(name, value);
    name = '';
    value = '';
    inValue = false;
  };
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b === NE_VAR || b === NE_USERVAR) {
      flush();
    } else if (b === NE_VALUE) {
      inValue = true;
    } else if (b === 2) {
      // ESC: next byte is literal.
      i += 1;
      const lit = bytes[i];
      if (lit !== undefined) {
        if (inValue) value += String.fromCharCode(lit);
        else name += String.fromCharCode(lit);
      }
    } else if (inValue) {
      value += String.fromCharCode(b);
    } else {
      name += String.fromCharCode(b);
    }
    i += 1;
  }
  flush();
  return vars;
}
