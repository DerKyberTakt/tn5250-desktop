import type { ConnectionEvents, ConnectOptions, Transport } from '../extension/connection';
import { base64ToBytes, bytesToBase64, errorText, goApp, wailsRuntime } from './bridge';

/** Live transports by id; one runtime listener per event fans out to them. */
const transports = new Map<string, GoTransport>();
let listening = false;
let counter = 0;

function listen(): void {
  if (listening) return;
  listening = true;
  const rt = wailsRuntime();
  rt.EventsOn('net:data', (id, data) => transports.get(String(id))?.onData(String(data)));
  rt.EventsOn('net:closed', (id, reason) => transports.get(String(id))?.onClosed(String(reason ?? '')));
}

/** A TCP/TLS connection owned by the Go host (net.go); bytes cross as base64. */
export class GoTransport implements Transport {
  private readonly id = `c${Date.now().toString(36)}${(counter++).toString(36)}`;
  private isOpen = false;
  private closed = false;
  private pending: Uint8Array[] = [];
  private sending = false;

  constructor(private readonly events: ConnectionEvents) {
    listen();
  }

  get open(): boolean {
    return this.isOpen;
  }

  async connect(options: ConnectOptions): Promise<void> {
    if (options.pfx || options.cert) {
      throw new Error('TLS client certificates are not supported in the desktop app yet');
    }
    transports.set(this.id, this);
    try {
      await goApp().NetConnect(this.id, {
        host: options.host,
        port: options.port,
        tls: options.tls,
        trustAnyCertificate: options.trustAnyCertificate ?? false,
        timeoutMs: options.timeoutMs ?? 15000,
        keepAlive: options.keepAlive ?? true,
      });
      this.isOpen = true;
    } catch (err) {
      transports.delete(this.id);
      throw new Error(errorText(err), { cause: err });
    }
  }

  /**
   * The host may send (telnet DO ...) before NetConnect resolves, so only a close stops writes.
   * Wails runs each bound call on its own goroutine, so sends are serialised here:
   * one call in flight, later bytes queue up and go out together in order.
   */
  write(bytes: Uint8Array): void {
    if (this.closed) return;
    this.pending.push(bytes.slice());
    if (!this.sending) void this.flush();
  }

  private async flush(): Promise<void> {
    this.sending = true;
    while (this.pending.length && !this.closed) {
      const chunks = this.pending.splice(0);
      const size = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      try {
        await goApp().NetSend(this.id, bytesToBase64(all));
      } catch (err) {
        this.events.error(new Error(errorText(err)));
      }
    }
    this.sending = false;
  }

  close(): void {
    transports.delete(this.id);
    if (!this.closed) void goApp().NetClose(this.id);
    this.closed = true;
    this.isOpen = false;
  }

  onData(data: string): void {
    this.events.data(base64ToBytes(data));
  }

  onClosed(reason: string): void {
    transports.delete(this.id);
    this.closed = true;
    this.isOpen = false;
    if (reason) this.events.error(new Error(reason));
    this.events.close(reason !== '');
  }
}
