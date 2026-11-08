import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebSocket, WebSocketServer } from 'ws';
import { backoffDelay, connectUrl, DEFAULT_BACKOFF, DeviceConnection, type ConnectionState } from '../connection.js';
import { MAX_FRAME_BYTES, WebSocketTransport } from '../ws-transport.js';

describe('backoff and URLs', () => {
  it('doubles from 1 s to 60 s with ±20 % jitter', () => {
    const mid = (): number => 0.5; // no jitter
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => backoffDelay(n, DEFAULT_BACKOFF, mid)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    assert.equal(backoffDelay(0, DEFAULT_BACKOFF, () => 0), 800);
    assert.equal(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999999), 1200);
    assert.equal(backoffDelay(10, DEFAULT_BACKOFF, () => 0), 48000);
    assert.equal(backoffDelay(10, DEFAULT_BACKOFF, () => 0.999999), 72000);
  });

  it('http → ws, https → wss, path prefix kept', () => {
    assert.equal(connectUrl('https://evvapp.example.com'), 'wss://evvapp.example.com/api/devices/connect');
    assert.equal(connectUrl('http://localhost:3000/'), 'ws://localhost:3000/api/devices/connect');
    assert.equal(connectUrl('https://h.example/evv/'), 'wss://h.example/evv/api/devices/connect');
  });
});

/** A fake EverythingApp server: accepts upgrades, records them, lets each test decide what happens next. */
class FakeServer {
  readonly http = http.createServer();
  readonly wss = new WebSocketServer({ noServer: true });
  readonly connections: WebSocket[] = [];
  readonly authHeaders: Array<string | undefined> = [];
  refuseWith: number | null = null;
  onConnection: (ws: WebSocket, n: number) => void = () => {};
  port = 0;

  async listen(): Promise<this> {
    this.http.on('upgrade', (req, socket, head) => {
      this.authHeaders.push(req.headers.authorization);
      if (this.refuseWith) {
        socket.end(`HTTP/1.1 ${this.refuseWith} X\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.connections.push(ws);
        this.onConnection(ws, this.connections.length);
      });
    });
    await new Promise<void>(r => this.http.listen(0, '127.0.0.1', r));
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    this.http.closeAllConnections();
    await new Promise<void>(r => this.http.close(() => r()));
  }
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(10);
  }
}

describe('DeviceConnection against a fake server', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  const fast = { initialMs: 30, maxMs: 120, stableMs: 200, jitter: 0 };

  async function harness(): Promise<{
    srv: FakeServer;
    states: Array<[ConnectionState, string | undefined]>;
    created: () => number;
    make: () => DeviceConnection;
  }> {
    const srv = await new FakeServer().listen();
    cleanup.push(() => srv.close());
    const states: Array<[ConnectionState, string | undefined]> = [];
    let created = 0;
    const make = (): DeviceConnection => {
      const c = new DeviceConnection({
        server: srv.url,
        token: 'TOK',
        createServer: () => {
          created++;
          const s = new McpServer({ name: 'dev', version: '0' });
          s.registerTool('ping', { description: 'p' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
          return s;
        },
        onState: (s, d) => void states.push([s, d]),
        backoff: fast,
        random: () => 0.5,
      });
      cleanup.push(() => c.stop());
      return c;
    };
    return { srv, states, created: () => created, make };
  }

  it('dials with the bearer token and runs MCP over the socket: the server is the client and sends initialize first', async () => {
    const { srv, states, make } = await harness();
    let tools: string[] = [];
    let text = '';
    srv.onConnection = ws => {
      void (async () => {
        const client = new Client({ name: 'evvapp', version: '0' });
        await client.connect(new WebSocketTransport(ws));
        tools = (await client.listTools()).tools.map(t => t.name);
        text = JSON.stringify(await client.callTool({ name: 'ping', arguments: {} }));
      })();
    };
    make().start();
    await until(() => text !== '');
    assert.deepEqual(srv.authHeaders, ['Bearer TOK']);
    assert.deepEqual(tools, ['ping']);
    assert.match(text, /pong/);
    assert.deepEqual(states.map(s => s[0]), ['connecting', 'online']);
  });

  it('4401 → revoked and it stops retrying', async () => {
    const { srv, states, make } = await harness();
    srv.onConnection = ws => ws.close(4401, 'revoked');
    make().start();
    await until(() => states.some(s => s[0] === 'revoked'));
    await wait(300);
    assert.equal(srv.connections.length, 1);
    assert.equal(states.at(-1)![0], 'revoked');
  });

  it('HTTP 401 before the upgrade is revoked as well', async () => {
    const { srv, states, make } = await harness();
    srv.refuseWith = 401;
    make().start();
    await until(() => states.some(s => s[0] === 'revoked'));
    await wait(200);
    assert.equal(srv.authHeaders.length, 1);
  });

  it('4409 → replaced and it stops retrying', async () => {
    const { srv, states, make } = await harness();
    srv.onConnection = ws => ws.close(4409, 'replaced');
    make().start();
    await until(() => states.some(s => s[0] === 'replaced'));
    await wait(300);
    assert.equal(srv.connections.length, 1);
  });

  it('1001 (server shutting down), abnormal drops and 5xx from the proxy are retried with a FRESH MCP server each time', async () => {
    const { srv, states, created, make } = await harness();
    srv.onConnection = (ws, n) => {
      if (n === 1) ws.close(1001, 'going away');
      else if (n === 2) ws.terminate();
    };
    make().start();
    await until(() => srv.connections.length === 3);
    srv.refuseWith = 502;
    srv.connections[2]!.close(1001);
    await until(() => srv.authHeaders.length >= 6);
    srv.refuseWith = null;
    await until(() => srv.connections.length >= 4);
    await until(() => created() === srv.connections.length);
    assert.ok(created() >= 4);
    const offline = states.filter(s => s[0] === 'offline');
    assert.ok(offline.length >= 3);
    assert.match(offline[0]![1]!, /connection closed \(1001/);
  });

  it('delays grow while connections fail quickly, and reset after one that stayed up past stableMs', async () => {
    const { srv, make } = await harness();
    const stamps: number[] = [];
    srv.onConnection = (ws, n) => {
      stamps.push(Date.now());
      if (n <= 3) ws.close(1011);
      else if (n === 4) setTimeout(() => ws.close(1011), 350); // stays up > stableMs (200)
      else ws.close(1011);
    };
    make().start();
    await until(() => stamps.length >= 6);
    const gap = (i: number): number => stamps[i]! - stamps[i - 1]!;
    // jitter 0, initial 30, max 120: gaps before connections 2, 3, 4 ≈ 30, 60, 120
    assert.ok(gap(1) >= 25 && gap(1) < 90, `gap1 ${gap(1)}`);
    assert.ok(gap(2) >= 55 && gap(2) < 140, `gap2 ${gap(2)}`);
    assert.ok(gap(3) >= 110, `gap3 ${gap(3)}`);
    // connection 4 lived 350 ms (> 200): the retry after it starts from the initial delay again
    assert.ok(gap(4) >= 350 + 25 && gap(4) < 350 + 100, `gap4 ${gap(4)}`);
  });

  it('restart() drops the socket and reconnects at once, without backoff', async () => {
    const { srv, make } = await harness();
    const c = make();
    c.start();
    await until(() => srv.connections.length === 1);
    const t0 = Date.now();
    c.restart();
    await until(() => srv.connections.length === 2);
    assert.ok(Date.now() - t0 < 500);
  });

  it('stop() closes the socket and ends the loop', async () => {
    const { srv, make } = await harness();
    const c = make();
    c.start();
    await until(() => srv.connections.length === 1);
    await c.stop();
    await until(() => srv.connections[0]!.readyState === WebSocket.CLOSED);
    await wait(150);
    assert.equal(srv.connections.length, 1);
  });

  it('an unreachable server is retried and reported as offline with the reason', async () => {
    const states: Array<[ConnectionState, string | undefined]> = [];
    const c = new DeviceConnection({
      server: 'http://127.0.0.1:1',
      token: 'T',
      createServer: () => new McpServer({ name: 'x', version: '0' }),
      onState: (s, d) => void states.push([s, d]),
      backoff: fast,
    });
    cleanup.push(() => c.stop());
    c.start();
    await until(() => states.filter(s => s[0] === 'offline').length >= 2);
    assert.match(states.find(s => s[0] === 'offline')![1]!, /ECONNREFUSED/);
  });
});

describe('WebSocketTransport', () => {
  it('sends one JSON-RPC message per text frame, ignores binary frames, enforces the 16 MiB cap', async () => {
    const srv = await new FakeServer().listen();
    try {
      const received: unknown[] = [];
      const errors: string[] = [];
      let serverSide!: WebSocket;
      srv.onConnection = ws => {
        serverSide = ws;
      };
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, { maxPayload: MAX_FRAME_BYTES });
      await new Promise<void>(r => ws.on('open', () => r()));
      await until(() => !!serverSide);
      const t = new WebSocketTransport(ws);
      t.onmessage = m => void received.push(m);
      t.onerror = e => void errors.push(e.message);
      await t.start();

      serverSide.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { binary: false });
      serverSide.send(Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}'), { binary: true });
      serverSide.send('not json');
      serverSide.send(JSON.stringify({ hello: 'world' }));
      await until(() => errors.length >= 3);
      assert.equal(received.length, 1);
      assert.match(errors[0]!, /binary frame ignored/);

      const frames: string[] = [];
      serverSide.on('message', (d, isBinary) => void frames.push(`${isBinary ? 'bin' : 'text'}:${d.toString()}`));
      await t.send({ jsonrpc: '2.0', id: 9, result: {} });
      await until(() => frames.length === 1);
      assert.equal(frames[0], 'text:{"jsonrpc":"2.0","id":9,"result":{}}');

      await assert.rejects(t.send({ jsonrpc: '2.0', id: 1, result: { big: 'x'.repeat(MAX_FRAME_BYTES) } }), /exceeds the 16777216-byte frame limit/);

      let closed = false;
      t.onclose = () => (closed = true);
      serverSide.close(1000);
      await until(() => closed);
      await assert.rejects(t.send({ jsonrpc: '2.0', id: 3, result: {} }), /not open/);
    } finally {
      await srv.close();
    }
  });

  it('a peer sending more than 16 MiB in one frame is disconnected', async () => {
    const srv = await new FakeServer().listen();
    try {
      let serverSide!: WebSocket;
      srv.onConnection = ws => (serverSide = ws);
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, { maxPayload: MAX_FRAME_BYTES });
      let code = 0;
      ws.on('close', c => (code = c));
      ws.on('error', () => {});
      await new Promise<void>(r => ws.on('open', () => r()));
      await until(() => !!serverSide);
      serverSide.send('x'.repeat(MAX_FRAME_BYTES + 1));
      await until(() => code !== 0);
      assert.ok(code === 1009 || code === 1006, `close code ${code}`); // 1009 sent to the peer; locally the socket reports the failed close as 1006
    } finally {
      await srv.close();
    }
  });
});
