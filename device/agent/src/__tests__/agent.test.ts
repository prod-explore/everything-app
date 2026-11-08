import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile, readFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { Agent, readTokenFile } from '../agent.js';
import { parseConfig, resolveConfig } from '../config.js';
import { hostEnv } from '../detect.js';
import { encodeAgentMessage, parseTrayMessage, type AgentMessage } from '../protocol.js';
import { DeviceRuntime } from '../runtime.js';
import { lineReader, runStdio } from '../stdio.js';
import { WebSocketTransport } from '../ws-transport.js';

const posix = process.platform !== 'win32';
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(15);
  }
}

describe('stdio protocol', () => {
  it('parses every tray message and rejects junk without throwing', () => {
    assert.deepEqual(parseTrayMessage('{"type":"start","configPath":"/c","dataDir":"/d","token":null}'), { type: 'start', configPath: '/c', dataDir: '/d', token: null });
    assert.deepEqual(parseTrayMessage('{"type":"start","configPath":"/c","dataDir":"/d","token":"T"}'), { type: 'start', configPath: '/c', dataDir: '/d', token: 'T' });
    for (const t of ['config-changed', 'pair', 'pause', 'resume', 'unpair', 'shutdown']) assert.deepEqual(parseTrayMessage(`{"type":"${t}"}`), { type: t });
    for (const bad of ['', 'nope', '[]', '{"type":"explode"}', '{"type":"start"}', '{"type":"start","configPath":"a","dataDir":"b","token":5}', '42']) {
      assert.ok(parseTrayMessage(bad) instanceof Error, bad);
    }
  });

  it('agent messages are single lines of JSON', () => {
    const line = encodeAgentMessage({ type: 'log', level: 'info', message: 'multi\nline "quoted"' });
    assert.equal(line.split('\n').length, 2);
    assert.equal(line.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(line), { type: 'log', level: 'info', message: 'multi\nline "quoted"' });
  });

  it('lineReader reassembles lines across chunks and handles CRLF and a last line without newline', () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let ended = false;
    lineReader(input, l => lines.push(l), () => (ended = true));
    input.write('{"a":');
    input.write('1}\r\n{"b":2}\n\n{"c"');
    input.end(':3}');
    return until(() => ended).then(() => assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']));
  });

  it('runStdio: first line is start; stdout carries ONLY protocol lines; unknown input is logged; shutdown exits 0', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-stdio-'));
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', c => chunks.push(String(c)));
    let exit: number | null = null;
    runStdio({ input, output, onExit: c => (exit = c) });

    input.write('this is not json\n');
    input.write('{"type":"pause"}\n'); // before start
    input.write(`${JSON.stringify({ type: 'start', configPath: nodePath.join(dir, 'config.json'), dataDir: dir, token: null })}\n`);
    await until(() => chunks.join('').includes('"unpaired"'));
    input.write('{"type":"pause"}\n{"type":"resume"}\n');
    await until(() => (chunks.join('').match(/"state"/g) ?? []).length >= 3);
    input.write('{"type":"shutdown"}\n');
    await until(() => exit !== null);
    assert.equal(exit, 0);

    const lines = chunks.join('').split('\n').filter(Boolean);
    const msgs = lines.map(l => JSON.parse(l) as AgentMessage); // every line parses: nothing else was written
    assert.ok(msgs.some(m => m.type === 'log' && m.level === 'warn' && /bad message/.test(m.message)));
    assert.ok(msgs.some(m => m.type === 'log' && m.level === 'error' && /before start/.test(m.message)));
    const states = msgs.filter((m): m is Extract<AgentMessage, { type: 'status' }> => m.type === 'status').map(m => m.state);
    assert.deepEqual(states, ['unpaired', 'paused', 'unpaired']);
  });

  it('closing stdin (the tray died) shuts the agent down', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-stdio-'));
    const input = new PassThrough();
    const output = new PassThrough();
    let exit: number | null = null;
    runStdio({ input, output, onExit: c => (exit = c) });
    input.write(`${JSON.stringify({ type: 'start', configPath: nodePath.join(dir, 'c.json'), dataDir: dir, token: null })}\n`);
    input.end();
    await until(() => exit !== null);
    assert.equal(exit, 0);
  });

  it('a broken config.json puts the agent in state error with the reason, and config-changed recovers', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-stdio-'));
    const cfg = nodePath.join(dir, 'config.json');
    await writeFile(cfg, '{ broken');
    const msgs: AgentMessage[] = [];
    const agent = new Agent({ configPath: cfg, dataDir: dir, token: null, persistToken: false, emit: m => void msgs.push(m) });
    await agent.start();
    assert.equal(agent.currentState, 'error');
    assert.match((msgs.find(m => m.type === 'status') as { detail: string }).detail, /not valid JSON/);
    await writeFile(cfg, '{}');
    await agent.configChanged();
    assert.equal(agent.currentState, 'unpaired');
    await agent.shutdown();
  });
});

describe('runtime: what the server sees', () => {
  async function connect(cfgJson: object, dir: string): Promise<{ client: Client; runtime: DeviceRuntime; calls: Array<[string, string]> }> {
    const cfg = resolveConfig(parseConfig(cfgJson), dir, hostEnv());
    const calls: Array<[string, string]> = [];
    const runtime = new DeviceRuntime(cfg, (tool, summary) => void calls.push([tool, summary]));
    const server = runtime.createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'evvapp', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, runtime, calls };
  }

  it('a capability that is off exposes no tools; the info resource is the contract DeviceReport', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-rt-'));
    const { client, runtime } = await connect({ deviceName: 'PC', shell: { enabled: false } }, dir);
    try {
      assert.deepEqual((await client.listTools()).tools, []);
      const res = await client.readResource({ uri: 'evvapp://device/info' });
      assert.equal(res.contents[0]!.mimeType, 'application/json');
      const report = JSON.parse((res.contents[0] as { text: string }).text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(report).sort(), ['agentVersion', 'arch', 'browser', 'files', 'hostname', 'name', 'platform', 'shell']);
      assert.equal(report['name'], 'PC');
      assert.deepEqual(report['shell'], { enabled: false, kind: 'posix', path: report['shell'] && (report['shell'] as { path: string }).path });
      assert.deepEqual(report['files'], { enabled: false, roots: [], write: false });
      assert.deepEqual(Object.keys(report['browser'] as object).sort(), ['enabled', 'executable', 'mode', 'product']);
    } finally {
      await runtime.dispose('test');
    }
  });

  it('tools follow the config: shell, read-only files, read-write files', { skip: !posix }, async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-rt-'));
    const share = nodePath.join(dir, 'share');
    await mkdir(share);
    const ro = await connect({ shell: { enabled: true }, files: { enabled: true, roots: [share] } }, dir);
    assert.deepEqual((await ro.client.listTools()).tools.map(t => t.name).sort(), ['_fs_read_b64', 'fs_list', 'fs_read', 'fs_search', 'shell_close', 'shell_list', 'shell_read', 'shell_run', 'shell_send']);
    await ro.runtime.dispose('test');
    const rw = await connect({ shell: { enabled: false }, files: { enabled: true, roots: [share], write: true } }, dir);
    assert.ok((await rw.client.listTools()).tools.some(t => t.name === 'fs_write'));
    await rw.runtime.dispose('test');
  });

  it('every tool call is reported as activity with a one-line summary', { skip: !posix }, async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-rt-'));
    await writeFile(nodePath.join(dir, 'f.txt'), 'x');
    const { client, runtime, calls } = await connect({ shell: { enabled: true }, files: { enabled: true, roots: [dir] } }, dir);
    try {
      await client.callTool({ name: 'shell_run', arguments: { command: 'echo   hello\n  world' } });
      await client.callTool({ name: 'fs_read', arguments: { path: 'f.txt' } });
      assert.deepEqual(calls, [['shell_run', 'echo hello world'], ['fs_read', 'f.txt']]);
    } finally {
      await runtime.dispose('test');
    }
  });
});

describe('agent end to end against a fake server', { skip: !posix }, () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  interface Fake {
    url: string;
    wsClients: WebSocket[];
    tokens: Array<string | undefined>;
    approve: boolean;
    closeWith?: number;
    onSocket: (ws: WebSocket) => void;
  }

  async function fakeServer(): Promise<Fake> {
    const wss = new WebSocketServer({ noServer: true });
    const fake: Fake = { url: '', wsClients: [], tokens: [], approve: true, onSocket: () => {} };
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/devices/pair/start') {
          res.end(JSON.stringify({ deviceCode: 'D', userCode: 'ABCD-2345', verificationPath: '/devices/pair?code=ABCD-2345', expiresIn: 600, interval: 1 }));
        } else if (req.url === '/api/devices/pair/poll') {
          if (fake.approve) res.end(JSON.stringify({ status: 'approved', deviceId: '00112233aabbccdd', deviceToken: 'DEVICE-TOKEN', connectionName: 'device-pc' }));
          else res.writeHead(410).end(JSON.stringify({ status: 'denied' }));
        } else res.writeHead(404).end('{}');
      });
    });
    srv.on('upgrade', (req, socket, head) => {
      fake.tokens.push(req.headers.authorization);
      if (req.headers.authorization !== 'Bearer DEVICE-TOKEN') return void socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      wss.handleUpgrade(req, socket, head, ws => {
        fake.wsClients.push(ws);
        if (fake.closeWith) ws.close(fake.closeWith);
        else fake.onSocket(ws);
      });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    fake.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    cleanup.push(async () => {
      for (const c of wss.clients) c.terminate();
      srv.closeAllConnections();
      await new Promise<void>(r => srv.close(() => r()));
    });
    return fake;
  }

  it('pair → token file 0600 → connect → server reads the report and calls tools → pause → resume → revoked → unpair', { timeout: 40_000 }, async () => {
    const fake = await fakeServer();
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-agent-'));
    const share = nodePath.join(dir, 'share');
    await mkdir(share);
    await writeFile(nodePath.join(share, 'hello.txt'), 'hi there\n');
    const configPath = nodePath.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ server: fake.url, deviceName: 'Test PC', files: { enabled: true, roots: [share] } }));

    const msgs: AgentMessage[] = [];
    const agent = new Agent({ configPath, dataDir: dir, token: null, persistToken: true, emit: m => void msgs.push(m), connectionBackoff: { initialMs: 20, maxMs: 50, jitter: 0 } });
    cleanup.push(() => agent.shutdown());
    const stateNow = (): string | undefined => [...msgs].reverse().find((m): m is Extract<AgentMessage, { type: 'status' }> => m.type === 'status')?.state;

    let session!: Client;
    fake.onSocket = ws => {
      session = new Client({ name: 'evvapp', version: '0' });
      void session.connect(new WebSocketTransport(ws));
    };

    await agent.start();
    assert.equal(stateNow(), 'unpaired');
    const outcome = await agent.pair();
    assert.deepEqual(outcome, { ok: true, deviceId: '00112233aabbccdd' });
    assert.deepEqual(msgs.find(m => m.type === 'pairing'), { type: 'pairing', userCode: 'ABCD-2345', url: `${fake.url}/devices/pair?code=ABCD-2345` });
    assert.deepEqual(msgs.find(m => m.type === 'paired'), { type: 'paired', token: 'DEVICE-TOKEN', deviceId: '00112233aabbccdd' });
    const tokenFile = nodePath.join(dir, 'token');
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal(await readTokenFile(dir), 'DEVICE-TOKEN');

    await until(() => stateNow() === 'online');
    assert.deepEqual(fake.tokens, ['Bearer DEVICE-TOKEN']);
    const report = JSON.parse(((await session.readResource({ uri: 'evvapp://device/info' })).contents[0] as { text: string }).text) as { name: string; files: { roots: string[] } };
    assert.equal(report.name, 'Test PC');
    assert.deepEqual(report.files.roots, [share]);
    const read = (await session.callTool({ name: 'fs_read', arguments: { path: 'hello.txt' } })) as { content: Array<{ text: string }> };
    assert.equal(read.content[0]!.text, '1\thi there');
    await session.callTool({ name: 'shell_run', arguments: { command: 'cd /usr', _conversation_id: 'c1' } });
    assert.ok(msgs.some(m => m.type === 'activity' && m.tool === 'shell_run' && m.summary === 'cd /usr'));
    assert.equal((await session.callTool({ name: 'shell_list', arguments: { _conversation_id: 'c1' } }) as { content: Array<{ text: string }> }).content[0]!.text.startsWith('main'), true);

    // pause: disconnect + end the shells
    const first = fake.wsClients[0]!;
    await agent.pause();
    assert.equal(stateNow(), 'paused');
    await until(() => first.readyState === first.CLOSED);
    await wait(150);
    assert.equal(fake.wsClients.length, 1, 'a paused device does not reconnect');

    // resume: a new connection; the old shell session is gone
    await agent.resume();
    await until(() => stateNow() === 'online' && fake.wsClients.length === 2);
    const listed = (await session.callTool({ name: 'shell_list', arguments: { _conversation_id: 'c1' } })) as { content: Array<{ text: string }> };
    assert.equal(listed.content[0]!.text, 'No open shell sessions.');

    // a config change reconnects with the new capabilities
    await writeFile(configPath, JSON.stringify({ server: fake.url, deviceName: 'Test PC', files: { enabled: false }, shell: { enabled: false } }));
    await agent.configChanged();
    await until(() => stateNow() === 'online' && fake.wsClients.length === 3);
    assert.deepEqual((await session.listTools()).tools, []);

    // the server revokes it: state revoked, no retries
    fake.wsClients[2]!.close(4401, 'revoked');
    await until(() => stateNow() === 'revoked');
    await wait(200);
    assert.equal(fake.wsClients.length, 3);

    // unpair forgets the token locally
    await agent.unpair();
    assert.equal(stateNow(), 'unpaired');
    assert.ok(msgs.some(m => m.type === 'unpaired'));
    assert.equal(await readTokenFile(dir), null);
    assert.equal(await readFile(configPath, 'utf8').then(() => true), true);
  });

  it('a denied pairing leaves the device unpaired and says why', async () => {
    const fake = await fakeServer();
    fake.approve = false;
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-agent-'));
    const msgs: AgentMessage[] = [];
    const agent = new Agent({ configPath: nodePath.join(dir, 'c.json'), dataDir: dir, token: null, persistToken: true, emit: m => void msgs.push(m) });
    const out = await agent.pair({ server: fake.url, name: 'X' }, false);
    assert.equal(out.ok, false);
    assert.match(out.error!, /denied/);
    assert.equal(agent.currentState, 'unpaired');
    assert.equal(await readTokenFile(dir), null);
    await agent.shutdown();
  });

  it('headless pair writes server and name into the config', async () => {
    const fake = await fakeServer();
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-agent-'));
    const configPath = nodePath.join(dir, 'config.json');
    const agent = new Agent({ configPath, dataDir: dir, token: null, persistToken: true, emit: () => {} });
    const out = await agent.pair({ server: `${fake.url}/`, name: 'Laptop' }, false);
    assert.equal(out.ok, true);
    const written = JSON.parse(await readFile(configPath, 'utf8')) as { server: string; deviceName: string };
    assert.equal(written.deviceName, 'Laptop');
    assert.equal(written.server, fake.url);
    await agent.shutdown();
  });
});
