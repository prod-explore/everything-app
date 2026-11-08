import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import WebSocket from 'ws';
import type { LogLevel } from './protocol.js';
import { MAX_FRAME_BYTES, WebSocketTransport } from './ws-transport.js';

/**
 * The device's side of the tunnel (ADR 0017): dial out to `wss://<server>/api/devices/connect` with the device token, run a
 * fresh MCP server over the socket for as long as it lives, and dial again when it drops.
 *
 * What a close means (docs/devices.md):
 *   4401  token revoked or invalid  → state `revoked`, stop for good (also an HTTP 401 before the upgrade)
 *   4409  replaced by a newer connection of this device → state `replaced`, stop for good
 *   anything else (1001 server restart, 1006 network, 5xx from the proxy …) → retry with backoff
 * Backoff: 1 s doubling to 60 s, ±20 % jitter, back to 1 s after a connection that stayed up 60 s.
 */

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'revoked' | 'replaced';

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  /** A connection that lasted this long counts as healthy: the next retry starts from `initialMs` again. */
  stableMs: number;
  /** ±fraction applied to every delay. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 60_000, stableMs: 60_000, jitter: 0.2 };

/** Delay before retry number `attempt` (0-based), jittered. `random` is [0,1). */
export function backoffDelay(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const base = Math.min(o.maxMs, o.initialMs * 2 ** attempt);
  return Math.round(base * (1 + (random() * 2 - 1) * o.jitter));
}

/** `https://host/x` → `wss://host/x/api/devices/connect` (http → ws). */
export function connectUrl(server: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/devices/connect`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

export interface ConnectionOptions {
  server: string;
  token: string;
  /** Called once per connection: a fresh MCP server with the device's current tools. */
  createServer: () => McpServer;
  onState: (state: ConnectionState, detail?: string) => void;
  log?: (level: LogLevel, message: string) => void;
  backoff?: Partial<BackoffOptions>;
  random?: () => number;
}

type Ended =
  | { kind: 'closed'; code: number; reason: string; upMs: number }
  | { kind: 'refused'; status: number }
  | { kind: 'error'; message: string };

export class DeviceConnection {
  private readonly backoff: BackoffOptions;
  private stopped = false;
  private socket: WebSocket | null = null;
  private wake: (() => void) | null = null;
  private skipBackoff = false;
  private attempt = 0;
  private lastState: ConnectionState | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: ConnectionOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
  }

  /** Starts dialling. Idempotent. */
  start(): void {
    this.loop ??= this.run();
  }

  /** Drops the current socket (if any) and dials again at once — the config changed. */
  restart(): void {
    this.skipBackoff = true;
    this.attempt = 0;
    this.wake?.();
    this.socket?.close(1000, 'reconnecting');
  }

  /** Closes the socket and ends the loop; resolves when it has. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    const socket = this.socket;
    if (socket) {
      socket.close(1000, 'device stopping');
      setTimeout(() => socket.terminate(), 2_000).unref();
    }
    await this.loop;
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (state === this.lastState && detail === undefined) return;
    this.lastState = state;
    this.opts.onState(state, detail);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.setState('connecting');
      const end = await this.once();
      if (this.stopped) break;

      if ((end.kind === 'closed' && end.code === 4401) || (end.kind === 'refused' && end.status === 401)) {
        this.setState('revoked', 'this device was removed or its token is no longer valid');
        return;
      }
      if (end.kind === 'closed' && end.code === 4409) {
        this.setState('replaced', 'another connection of this device took over');
        return;
      }
      if (end.kind === 'closed' && end.upMs >= this.backoff.stableMs) this.attempt = 0;

      const detail =
        end.kind === 'closed'
          ? `connection closed (${end.code}${end.reason ? ` ${end.reason}` : ''})`
          : end.kind === 'refused'
            ? `server answered HTTP ${end.status}`
            : end.message;
      const delay = this.skipBackoff ? 0 : backoffDelay(this.attempt++, this.backoff, this.opts.random);
      this.skipBackoff = false;
      this.lastState = null;
      this.setState('offline', delay > 0 ? `${detail}; retrying in ${Math.round(delay / 1000)}s` : detail);
      this.opts.log?.('info', `disconnected: ${detail}`);
      if (delay > 0) {
        await new Promise<void>(resolve => {
          const t = setTimeout(done, delay);
          function done(): void {
            clearTimeout(t);
            resolve();
          }
          this.wake = done;
        });
        this.wake = null;
        this.skipBackoff = false;
      }
    }
  }

  private once(): Promise<Ended> {
    return new Promise<Ended>(resolve => {
      let settled = false;
      let openedAt = 0;
      let server: McpServer | null = null;
      const settle = (e: Ended): void => {
        if (settled) return;
        settled = true;
        this.socket = null;
        void server?.close().catch(() => {});
        resolve(e);
      };

      const ws = new WebSocket(connectUrl(this.opts.server), {
        headers: { Authorization: `Bearer ${this.opts.token}` },
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: 15_000,
      });
      this.socket = ws;
      // Listening starts now, before 'open': the server's first frame (`initialize`) may arrive in the same read as the 101.
      const transport = new WebSocketTransport(ws);

      ws.on('unexpected-response', (req, res) => {
        res.resume();
        req.destroy();
        settle({ kind: 'refused', status: res.statusCode ?? 0 });
      });
      ws.on('error', err => {
        // After the handshake an error is followed by 'close', which carries the code; before it, nothing else will come.
        if (!openedAt) settle({ kind: 'error', message: err.message });
        else this.opts.log?.('warn', `socket error: ${err.message}`);
      });
      ws.on('close', (code, reason) => settle({ kind: 'closed', code, reason: reason.toString('utf8'), upMs: openedAt ? Date.now() - openedAt : 0 }));
      ws.on('open', () => {
        openedAt = Date.now();
        try {
          server = this.opts.createServer();
          // The server speaks first: `online` once its `initialize` has been answered.
          server.server.oninitialized = () => this.setState('online');
          server.server.onerror = err => this.opts.log?.('warn', `mcp: ${err.message}`);
          void server.connect(transport).catch(err => {
            this.opts.log?.('error', `cannot start the MCP session: ${(err as Error).message}`);
            ws.close(1011, 'internal error');
          });
        } catch (err) {
          this.opts.log?.('error', `cannot create the MCP server: ${(err as Error).message}`);
          ws.close(1011, 'internal error');
        }
      });
    });
  }
}
