import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';
import { WsTransport } from '../devices/ws-transport.js';
import { openDb, runMigrations } from '../db.js';
import { ToolRegistry } from '../tool-registry.js';
import { createDeviceService, CONNECT_PATH } from '../devices/index.js';
import { hashDeviceToken, newDeviceToken } from '../devices/store.js';
import { attachUpgradeRouter } from '../upgrade-router.js';
import { REPORT_URI, type DeviceReport } from '../devices/types.js';

/** Shared by the device-bridge tests: a device that really connects over a WebSocket and speaks MCP, like device/agent. */

export const posixReport = (over: Partial<DeviceReport> = {}): DeviceReport => ({
  name: 'PC', platform: 'linux', arch: 'x64', hostname: 'pc', agentVersion: '0.1.0',
  shell: { enabled: true, kind: 'posix', path: '/bin/bash' },
  files: { enabled: true, roots: ['/home/me'], write: true },
  browser: { enabled: true, mode: 'dedicated', product: 'chromium', executable: null },
  ...over,
});

export interface FakeTool { name: string; description?: string; handler?: (args: Record<string, unknown>) => { text: string; isError?: boolean } | Record<string, unknown> }

export interface FakeDevice {
  ws: WebSocket;
  server: Server;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Resolves with the close code once the socket is closed. */
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

export const DEFAULT_TOOLS: FakeTool[] = [
  { name: 'shell_run', description: 'run a command' },
  { name: 'shell_read' },
  { name: 'fs_write' },
  { name: 'browser_act' },
  { name: '_fs_read_b64', handler: () => ({ name: 'f.txt', size: 2, base64: 'aGk=' }) },
];

export function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Connects a fake device to `ws://127.0.0.1:<port>/api/devices/connect`. Rejects with the HTTP status when the upgrade is refused. */
export async function connectFakeDevice(port: number, token: string | null, opts: {
  report?: DeviceReport | null; tools?: FakeTool[]; autoPong?: boolean; answerInitialize?: boolean;
} = {}): Promise<FakeDevice> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices/connect`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    autoPong: opts.autoPong ?? true,
  });
  const closed = new Promise<{ code: number; reason: string }>(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  // The server speaks first (initialize) and its first frame can arrive in the same read as the 101 response, so the
  // MCP server must be listening before the socket reports "open" — as a real device agent has to do.
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const calls: FakeDevice['calls'] = [];
  const server = new Server({ name: 'fake-device', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description ?? t.name, inputSchema: { type: 'object' as const, properties: {} } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: req.params.name, args });
    const tool = tools.find(t => t.name === req.params.name);
    const out = tool?.handler?.(args) ?? { text: `${req.params.name} ok` };
    if ('text' in out && typeof out.text === 'string') return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError === true };
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: REPORT_URI, name: 'info', mimeType: 'application/json' }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async req => {
    if (req.params.uri !== REPORT_URI || opts.report === null) throw new Error('no such resource');
    return { contents: [{ uri: REPORT_URI, mimeType: 'application/json', text: JSON.stringify(opts.report ?? posixReport()) }] };
  });
  // A peer that never answers initialize simply has no MCP server attached.
  const serving = opts.answerInitialize === false ? Promise.resolve() : server.connect(new WsTransport(ws));
  serving.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => { res.resume(); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    ws.once('error', reject);
  });
  await serving;
  return { ws, server, calls, closed, close: () => ws.close(1000) };
}

export async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

const rigs: Rig[] = [];

export interface Rig {
  db: ReturnType<typeof openDb>;
  svc: ReturnType<typeof createDeviceService>;
  registry: ToolRegistry;
  port: number;
  pair(name?: string): { id: string; token: string; connection: string };
  devices: FakeDevice[];
  changes: string[];
  close(): Promise<void>;
}


export async function deviceRig(hub: { pingIntervalMs?: number; deadAfterMs?: number; initTimeoutMs?: number } = {}, autoApprove: string[] = []): Promise<Rig> {
  const db = openDb(':memory:');
  runMigrations(db);
  const registry = new ToolRegistry(autoApprove);
  const changes: string[] = [];
  const svc = createDeviceService({ db, registry, onChange: id => changes.push(id), hub: { ...hub, log: () => {} } });
  const server = http.createServer((_q, res) => { res.statusCode = 404; res.end(); });
  attachUpgradeRouter(server, { [CONNECT_PATH]: svc.hub.handleUpgrade });
  const port = await listen(server);
  const devices: FakeDevice[] = [];
  const r: Rig = {
    db, svc, registry, port, devices, changes,
    pair: (name = 'PC') => {
      const token = newDeviceToken();
      const row = svc.store.create({ name, platform: 'linux', agentVersion: '0.1.0', tokenHash: hashDeviceToken(token) });
      return { id: row.id, token, connection: `device-${row.slug}` };
    },
    close: async () => {
      for (const d of devices) d.ws.terminate();
      await svc.hub.shutdown(100);
      server.closeAllConnections();
      server.close();
    },
  };
  rigs.push(r);
  return r;
}

export async function online(r: Rig, token: string, opts: Parameters<typeof connectFakeDevice>[2] = {}) {
  const d = await connectFakeDevice(r.port, token, opts);
  r.devices.push(d);
  return d;
}


export async function closeRigs(): Promise<void> { for (const r of rigs.splice(0)) await r.close(); }
