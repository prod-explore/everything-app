import { randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { openDb, runMigrations } from '../db.js';
import { buildApp, type BuiltApp } from '../server.js';
import { runTurn, type LlmClient } from '../llm-loop.js';
import { WebApprovalGate } from '../web-approval.js';
import { attachUpgradeRouter } from '../upgrade-router.js';
import { LIVEVIEW_PATH, createLiveViewUpgrade } from '../liveview-proxy.js';
import { CONNECT_PATH } from '../devices/index.js';
import { closeRigs, connectFakeDevice, deviceRig, online, waitFor } from './devices-fixture.js';

afterEach(closeRigs);

const TOKEN = 'test-auth-token-0123456789abcdef-device-bridge';

function request(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe('device bridge inside the real app', () => {
  async function appRig() {
    const db = openDb(':memory:');
    runMigrations(db);
    const built: BuiltApp = await buildApp({ db, connections: [], authToken: TOKEN, config: { model: '@test/m', autoApproveTools: ['browser_act', 'browser_open'] }, scheduler: { autostart: false } });
    const server = http.createServer(built.app);
    attachUpgradeRouter(server, {
      [LIVEVIEW_PATH]: createLiveViewUpgrade({ authToken: TOKEN }),
      [CONNECT_PATH]: built.devices.hub.handleUpgrade,
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const auth = { authorization: `Bearer ${TOKEN}` };
    return {
      built, port, auth,
      close: async () => { await built.shutdown(200); built.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close(); },
    };
  }

  it('pairs over HTTP, connects over WebSocket, lists the device online, and revokes it', async () => {
    const a = await appRig();
    try {
      // The pairing endpoints answer without a login; everything else does not.
      const start = await request(a.port, 'POST', '/api/devices/pair/start', { name: 'Desk PC', platform: 'linux', agentVersion: '0.1.0' });
      assert.equal(start.status, 200);
      assert.equal((await request(a.port, 'GET', '/api/devices')).status, 401);
      assert.equal((await request(a.port, 'POST', `/api/devices/pair/${start.json.userCode}/approve`, {})).status, 401);

      assert.equal((await request(a.port, 'POST', `/api/devices/pair/${start.json.userCode}/approve`, {}, a.auth)).status, 200);
      const poll = await request(a.port, 'POST', '/api/devices/pair/poll', { deviceCode: start.json.deviceCode });
      assert.equal(poll.json.status, 'approved');
      assert.equal(poll.json.connectionName, 'device-desk-pc');
      const deviceToken: string = poll.json.deviceToken;

      // The device token opens the WebSocket and nothing else.
      assert.equal((await request(a.port, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${deviceToken}` })).status, 401);
      assert.equal((await request(a.port, 'GET', '/api/devices', undefined, { authorization: `Bearer ${deviceToken}` })).status, 401);
      await assert.rejects(connectFakeDevice(a.port, TOKEN), (e: any) => e.status === 401);

      const dev = await connectFakeDevice(a.port, deviceToken);
      await waitFor(() => a.built.devices.hub.isOnline(poll.json.deviceId));
      const list = await request(a.port, 'GET', '/api/devices', undefined, a.auth);
      const d = list.json.devices[0];
      assert.equal(d.online, true);
      assert.deepEqual(d.tools.sort(), ['browser_act', 'fs_write', 'shell_read', 'shell_run']);
      assert.equal(d.report.hostname, 'pc');
      assert.ok(d.connectedAt);

      // Settings changes the level live.
      const patched = await request(a.port, 'PATCH', `/api/devices/${d.id}`, { policy: { shell: 'strict' } }, a.auth);
      assert.equal(patched.json.policy.shell, 'strict');

      assert.equal((await request(a.port, 'DELETE', `/api/devices/${d.id}`, undefined, a.auth)).status, 200);
      assert.equal((await dev.closed).code, 4401);
      assert.equal((await request(a.port, 'GET', '/api/devices', undefined, a.auth)).json.devices.length, 0);
      await assert.rejects(connectFakeDevice(a.port, deviceToken), (e: any) => e.status === 401);
    } finally { await a.close(); }
  });

  it('the live view path still routes through the same upgrade handler, and graceful shutdown closes devices with 1001', async () => {
    const a = await appRig();
    try {
      const code = await new Promise<number>(resolve => {
        const r = http.request({ host: '127.0.0.1', port: a.port, path: '/api/liveview?conversationId=c', agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
        r.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
        r.on('error', () => resolve(-1));
        r.end();
      });
      assert.equal(code, 401, 'liveview answers its own auth error, not the device hub\'s');

      const s = await request(a.port, 'POST', '/api/devices/pair/start', { name: 'PC', platform: 'macos', agentVersion: '1' });
      await request(a.port, 'POST', `/api/devices/pair/${s.json.userCode}/approve`, {}, a.auth);
      const poll = await request(a.port, 'POST', '/api/devices/pair/poll', { deviceCode: s.json.deviceCode });
      const dev = await connectFakeDevice(a.port, poll.json.deviceToken);
      await waitFor(() => a.built.devices.hub.list().length === 1);
      await a.built.shutdown(200);
      assert.equal((await dev.closed).code, 1001);
    } finally { await a.close(); }
  });
});

// ── the agent loop with a real device behind the registry ────────────────────
const msg = (content: unknown[], stop: 'tool_use' | 'end_turn') => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content }) as unknown as Llm.Message;
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

describe('agent loop with device tools', () => {
  it('injects the chat id (not the project), runs reads and read-only shell commands unasked, and asks for writes and unknown commands', async () => {
    const r = await deviceRig({}, ['browser_act', 'fs_write']);
    const p = r.pair();
    const dev = await online(r, p.token, { tools: [{ name: 'shell_run' }, { name: 'shell_read' }, { name: 'fs_write' }, { name: 'browser_act' }] });
    await waitFor(() => r.registry.has('device-pc__shell_run'));
    r.svc.store.setReport(p.id, r.svc.store.get(p.id)!.report);

    const gate = new WebApprovalGate(r.db);
    gate.setCommandScopeResolver(r.svc.commandScope);
    const asked: string[] = [];
    gate.onPending = e => { asked.push(e.toolLabel); queueMicrotask(() => gate.resolve(e.id, true, 'once')); };

    const script: Llm.Message[] = [
      msg([
        use('1', 'device-pc__shell_run', { command: 'ls', _conversation_id: 'evil', _project_id: 'evil' }),
        use('2', 'device-pc__shell_read', { session: 'main' }),
        use('3', 'device-pc__shell_run', { command: 'npm install' }),
        use('4', 'device-pc__fs_write', { path: '/a', content: 'x' }),
        use('5', 'device-pc__browser_act', { label: 'Next' }),
      ], 'tool_use'),
      msg([{ type: 'text', text: 'done' }], 'end_turn'),
    ];
    const llm: LlmClient = { messages: { create: async () => script.shift()! } };
    await runTurn({
      llm, model: 'x', tools: r.registry, systemPrompt: '', conversationId: 'conv-7', projectId: 'proj-1',
      confirm: (label, args) => gate.confirmDetailed('conv-7', label, args),
    }, [], 'go');

    assert.deepEqual(asked, ['device-pc/shell_run', 'device-pc/fs_write', 'device-pc/browser_act'], 'npm install, the write and the click ask; ls and the read do not — even with browser_act on AUTO_APPROVE_TOOLS');
    const byTool = (n: string) => dev.calls.filter(c => c.name === n).map(c => c.args);
    assert.deepEqual(byTool('shell_run')[0], { command: 'ls', _conversation_id: 'conv-7' }, 'the model cannot choose the chat, and a device gets no project id');
    assert.equal(byTool('shell_run').length, 2);
    assert.equal(byTool('shell_read')[0]!['_conversation_id'], 'conv-7');
  });
});
