import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocket, WebSocketServer } from 'ws';
import type { ToolRegistry } from '../tool-registry.js';
import { DeviceConnection } from './connection.js';
import type { DeviceRow, DeviceStore } from './store.js';
import { DEFAULT_DEVICE_POLICY, connectionNameOf } from './types.js';
import { MAX_FRAME_BYTES, WsTransport } from './ws-transport.js';

/**
 * Owns the live device sockets (ADR 0017). A device dials `GET /api/devices/connect` with its token; the hub checks the
 * token BEFORE upgrading (an unknown token gets a plain 401 and no WebSocket exists), then acts as the MCP client of the
 * device: `initialize`, read `evvapp://device/info`, load the tools into the registry. Tools exist exactly as long as the
 * socket does — a model never sees a tool it cannot reach.
 *
 * One live connection per device: a newer one replaces the older (4409), so a device that reconnects before the server
 * noticed the old socket died does not end up with two. Revoking closes the socket with 4401. Liveness: a ping every 25 s,
 * and a socket that has been silent for 60 s is terminated (a half-open TCP connection through NAT never closes by itself).
 */

export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_GOING_AWAY = 1001;

export interface HubOptions {
  store: DeviceStore;
  registry: ToolRegistry;
  pingIntervalMs?: number;
  /** Silence after which a socket is considered dead. */
  deadAfterMs?: number;
  /** Time a device gets to answer `initialize` and the info resource. */
  initTimeoutMs?: number;
  /** A device came, went or changed (for the live Settings page). Must not throw. */
  onChange?: (deviceId: string) => void;
  log?: (message: string) => void;
}

interface Live {
  deviceId: string;
  slug: string;
  ws: WebSocket;
  conn: DeviceConnection | null;
  lastActivity: number;
  ping: NodeJS.Timeout;
  connectedAt: string | null;
}

export interface LiveDevice {
  deviceId: string;
  connectionName: string;
  connectedAt: string;
  lastActivityAt: string;
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class DeviceHub {
  private readonly live = new Map<string, Live>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, clientTracking: false });
  private readonly pingMs: number;
  private readonly deadMs: number;
  private readonly initMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: HubOptions) {
    this.pingMs = opts.pingIntervalMs ?? 25_000;
    this.deadMs = opts.deadAfterMs ?? 60_000;
    this.initMs = opts.initTimeoutMs ?? 15_000;
    this.log = opts.log ?? (m => console.log(m));
  }

  /** The upgrade handler for `/api/devices/connect` (register it with the upgrade router). */
  handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const token = bearer(req.headers.authorization);
    const device = token ? this.opts.store.findByToken(token) : null;
    // Refused before the WebSocket exists: an unknown or revoked token learns nothing but the status line.
    if (!device) return refuse(socket, '401 Unauthorized');
    this.wss.handleUpgrade(req, socket, head, ws => this.adopt(ws, device));
  };

  /** Devices that are connected and have finished the handshake. */
  list(): LiveDevice[] {
    return [...this.live.values()].filter((l): l is Live & { conn: DeviceConnection; connectedAt: string } => l.conn !== null && l.connectedAt !== null).map(l => ({
      deviceId: l.deviceId,
      connectionName: l.conn.name,
      connectedAt: l.connectedAt,
      lastActivityAt: new Date(l.lastActivity).toISOString(),
    }));
  }

  /** The live connection of a device by its connection name (`device-pc`), once it is ready. */
  get(connectionName: string): DeviceConnection | undefined {
    for (const l of this.live.values()) if (l.conn && l.conn.name === connectionName) return l.conn;
    return undefined;
  }

  isOnline(deviceId: string): boolean {
    return this.live.get(deviceId)?.conn != null;
  }

  /** Closes the device's socket with 4401 (the device stops retrying) and takes its tools away. True when it was connected. */
  revoke(deviceId: string): boolean {
    const l = this.live.get(deviceId);
    if (!l) return false;
    this.detach(l);
    this.closeSocket(l.ws, CLOSE_REVOKED, 'token revoked');
    return true;
  }

  /** Server shutdown: every device gets 1001 (it reconnects when the server is back). */
  async shutdown(graceMs = 1_000): Promise<void> {
    const all = [...this.live.values()];
    for (const l of all) this.detach(l);
    await Promise.all(all.map(l => new Promise<void>(resolve => {
      if (l.ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => { l.ws.terminate(); resolve(); }, graceMs);
      timer.unref();
      l.ws.once('close', () => { clearTimeout(timer); resolve(); });
      this.closeSocket(l.ws, CLOSE_GOING_AWAY, 'server shutting down');
    })));
    this.wss.close();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private adopt(ws: WebSocket, device: DeviceRow): void {
    ws.on('error', () => { /* the transport reports errors; this keeps a reset from becoming an uncaught event */ });
    const previous = this.live.get(device.id);
    if (previous) {
      this.detach(previous);
      this.closeSocket(previous.ws, CLOSE_REPLACED, 'replaced by a newer connection');
    }
    const live: Live = {
      deviceId: device.id,
      slug: device.slug,
      ws,
      conn: null,
      lastActivity: Date.now(),
      connectedAt: null,
      ping: setInterval(() => {
        if (Date.now() - live.lastActivity > this.deadMs) { ws.terminate(); return; }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.pingMs),
    };
    live.ping.unref();
    this.live.set(device.id, live);
    const alive = () => { live.lastActivity = Date.now(); };
    ws.on('pong', alive);
    ws.on('message', alive);
    ws.on('close', () => this.onClosed(live));
    void this.initialise(live).catch(err => {
      this.log(`[devices] '${connectionNameOf(live.slug)}' handshake failed: ${(err as Error).message}`);
      this.closeSocket(ws, 1011, 'handshake failed');
    });
  }

  private async initialise(live: Live): Promise<void> {
    const { store, registry } = this.opts;
    const client = new Client({ name: 'everythingapp-cli', version: '0.1.0' }, { capabilities: {} });
    await client.connect(new WsTransport(live.ws), { timeout: this.initMs });
    if (this.live.get(live.deviceId) !== live) return;

    const conn = new DeviceConnection({
      deviceId: live.deviceId,
      slug: live.slug,
      client,
      policy: () => store.get(live.deviceId)?.policy ?? DEFAULT_DEVICE_POLICY,
    });
    const report = await conn.readReport();
    if (!report) this.log(`[devices] '${conn.name}' sent no usable device info; its shell is treated as unparsable (strict)`);
    store.setReport(live.deviceId, report, report?.agentVersion || client.getServerVersion()?.version);
    if (this.live.get(live.deviceId) !== live) return;

    const failed = await registry.loadFrom([conn]);
    if (failed.length > 0) throw new Error(`could not list tools: ${failed[0]!.error}`);
    if (this.live.get(live.deviceId) !== live) { registry.removeConnection(conn.name, conn); return; }

    live.conn = conn;
    live.connectedAt = new Date().toISOString();
    store.markConnected(live.deviceId);
    this.log(`[devices] '${conn.name}' online (${registry.toolsOf(conn.name).length} tools)`);
    this.changed(live.deviceId);
  }

  /** Takes a live entry out of the table (so its close handler knows it is no longer the device's connection) and drops its tools. */
  private detach(live: Live): void {
    if (this.live.get(live.deviceId) === live) this.live.delete(live.deviceId);
    clearInterval(live.ping);
    live.conn?.markDown();
    if (live.conn) this.opts.registry.removeConnection(live.conn.name, live.conn);
  }

  private onClosed(live: Live): void {
    const wasCurrent = this.live.get(live.deviceId) === live;
    this.detach(live);
    if (!wasCurrent) return; // replaced or revoked: the one who did that has done the bookkeeping
    this.opts.store.markDisconnected(live.deviceId);
    if (live.conn) this.log(`[devices] '${live.conn.name}' offline`);
    this.changed(live.deviceId);
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(code, reason); } catch { ws.terminate(); }
    }
  }

  private changed(deviceId: string): void {
    try { this.opts.onChange?.(deviceId); } catch { /* a notification problem never blocks the bridge */ }
  }
}
