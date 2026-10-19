import * as net from 'node:net';
import * as tls from 'node:tls';

export interface ConnectOptions {
  host: string;
  port: number;
  tls: boolean;
  /** Accept certificates that fail validation (self-signed hosts). */
  trustAnyCertificate?: boolean;
  timeoutMs?: number;
  keepAlive?: boolean;
  /** Client authentication material (TLS only). */
  pfx?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
}

export interface ConnectionEvents {
  data(bytes: Uint8Array): void;
  close(hadError: boolean): void;
  error(err: Error): void;
}

/** What a session needs from a connection; the Node socket below or a native one in a desktop shell. */
export interface Transport {
  connect(options: ConnectOptions): Promise<void>;
  write(bytes: Uint8Array): void;
  close(): void;
  readonly open: boolean;
}

export type TransportFactory = (events: ConnectionEvents) => Transport;

/** A raw TCP or TLS connection to the telnet port of an IBM i. */
export class HostConnection implements Transport {
  private socket: net.Socket | undefined;

  constructor(private readonly events: ConnectionEvents) {}

  connect(options: ConnectOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 15000;
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const socket = options.tls
        ? tls.connect({
            host: options.host,
            port: options.port,
            servername: options.host,
            rejectUnauthorized: !options.trustAnyCertificate,
            pfx: options.pfx,
            cert: options.cert,
            key: options.key,
            passphrase: options.passphrase,
          })
        : net.connect({ host: options.host, port: options.port });
      this.socket = socket;
      socket.setNoDelay(true);
      // Probe an idle connection after 15 s so a dropped network (VPN, Wi-Fi) is noticed quickly.
      socket.setKeepAlive(options.keepAlive ?? true, 15000);
      socket.setTimeout(timeoutMs, () => {
        if (!settled) {
          socket.destroy(new Error(`connection to ${options.host}:${options.port} timed out`));
        }
      });

      const onReady = (): void => {
        socket.setTimeout(0);
        done();
      };
      if (options.tls) socket.once('secureConnect', onReady);
      else socket.once('connect', onReady);

      socket.on('data', (chunk: Buffer) => this.events.data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      socket.on('error', (err: Error) => {
        done(err);
        this.events.error(err);
      });
      socket.on('close', (hadError: boolean) => {
        done(new Error('connection closed'));
        this.events.close(hadError);
      });
    });
  }

  write(bytes: Uint8Array): void {
    this.socket?.write(bytes);
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
  }

  get open(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }
}
