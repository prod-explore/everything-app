import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { connectFakeDevice, closeRigs, deviceRig as rig, online, posixReport, waitFor } from './devices-fixture.js';

afterEach(closeRigs);

describe('device hub over a real WebSocket', () => {
  it('refuses an upgrade without a valid token with 401, before any WebSocket exists', async () => {
    const r = await rig();
    const p = r.pair();
    await assert.rejects(connectFakeDevice(r.port, null), (e: any) => e.status === 401);
    await assert.rejects(connectFakeDevice(r.port, 'not-a-token'), (e: any) => e.status === 401);
    await assert.rejects(connectFakeDevice(r.port, p.token.slice(0, -1) + (p.token.endsWith('A') ? 'B' : 'A')), (e: any) => e.status === 401);
    assert.deepEqual(r.svc.hub.list(), []);
  });

  it('the app\'s own tokens do not open the endpoint, and other paths are closed', async () => {
    const r = await rig();
    await assert.rejects(connectFakeDevice(r.port, 'test-auth-token-0123456789abcdef'), (e: any) => e.status === 401);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/api/other`);
      ws.on('error', () => resolve());
      ws.on('open', () => { ws.close(); assert.fail('unknown path must not upgrade'); });
    });
  });

  it('initializes, reads the device info, and loads the tools into the registry; internal tools stay hidden', async () => {
    const r = await rig();
    const p = r.pair('Desktop PC');
    assert.equal(p.connection, 'device-desktop-pc');
    const d = await online(r, p.token, { report: posixReport({ name: 'Desktop PC', agentVersion: '0.2.0' }) });
    await waitFor(() => r.svc.hub.isOnline(p.id), 3000, 'device online');

    const names = r.registry.toLlmTools().map(t => t.name).sort();
    assert.deepEqual(names, ['device-desktop-pc__browser_act', 'device-desktop-pc__fs_write', 'device-desktop-pc__shell_read', 'device-desktop-pc__shell_run']);
    assert.ok(!names.some(n => n.includes('_fs_read_b64')));

    const row = r.svc.store.get(p.id)!;
    assert.equal(row.report?.hostname, 'pc');
    assert.equal(row.agentVersion, '0.2.0');
    assert.ok(row.connectedAt && row.lastSeenAt);
    assert.equal(r.svc.hub.list()[0]?.connectionName, 'device-desktop-pc');
    assert.ok(r.changes.includes(p.id));

    // A model call reaches the device; the internal tool is reachable only through callInternal.
    const res = await r.registry.call('device-desktop-pc__shell_run', { command: 'ls' });
    assert.deepEqual(res, { text: 'shell_run ok', isError: false });
    assert.deepEqual(d.calls.map(c => c.name), ['shell_run']);
    const conn = r.svc.hub.get('device-desktop-pc')!;
    assert.equal((await conn.callTool('_fs_read_b64', {})).isError, true, 'a model-facing call cannot reach an internal tool');
    assert.equal(d.calls.length, 1);
    d.calls.length = 0;
    const internal = await conn.callInternal('_fs_read_b64', { path: '/x' });
    assert.deepEqual(internal, { name: 'f.txt', size: 2, base64: 'aGk=' });
    assert.equal(d.calls[0]?.name, '_fs_read_b64');
  });

  it('a tool error from the device is an error result, and a device that goes away mid-call yields an error result too', async () => {
    const r = await rig();
    const p = r.pair();
    let release: () => void = () => {};
    const held = new Promise<void>(res => { release = res; });
    const d = await online(r, p.token, { tools: [{ name: 'shell_run', handler: a => (a['command'] === 'boom' ? { text: 'nope', isError: true } : { text: 'ok' }) }] });
    await waitFor(() => r.registry.has('device-pc__shell_run'));
    assert.deepEqual(await r.registry.call('device-pc__shell_run', { command: 'boom' }), { text: 'nope', isError: true });
    // Server asks, the device drops the socket instead of answering.
    d.server.setRequestHandler((await import('@modelcontextprotocol/sdk/types.js')).CallToolRequestSchema, async () => { await held; return { content: [] }; });
    const pending = r.registry.call('device-pc__shell_run', { command: 'long' });
    await waitFor(() => true);
    d.ws.terminate();
    const result = await pending;
    release();
    assert.equal(result.isError, true);
    assert.match(result.text, /went offline.*may or may not have run/);
  });

  it('removes the tools when the device disconnects and records when it was last seen', async () => {
    const r = await rig();
    const p = r.pair();
    const d = await online(r, p.token);
    await waitFor(() => r.registry.has('device-pc__shell_run'));
    d.close();
    await d.closed;
    await waitFor(() => !r.registry.has('device-pc__shell_run'), 3000, 'tools removed');
    assert.equal(r.svc.hub.isOnline(p.id), false);
    const row = r.svc.store.get(p.id)!;
    assert.equal(row.connectedAt, null);
    assert.ok(row.lastSeenAt);
  });

  it('a newer connection replaces the older one (4409) and keeps its tools', async () => {
    const r = await rig();
    const p = r.pair();
    const first = await online(r, p.token);
    await waitFor(() => r.registry.has('device-pc__shell_run'));
    const second = await online(r, p.token, { tools: [{ name: 'shell_run' }, { name: 'fs_list' }] });
    assert.equal((await first.closed).code, 4409);
    await waitFor(() => r.registry.has('device-pc__fs_list'), 3000, 'second connection tools');
    await new Promise(res => setTimeout(res, 50)); // the old socket's close handler has run by now
    assert.deepEqual(r.registry.toLlmTools().map(t => t.name).sort(), ['device-pc__fs_list', 'device-pc__shell_run']);
    assert.equal(r.svc.hub.list().length, 1);
    assert.equal(r.svc.store.get(p.id)?.connectedAt !== null, true, 'the device is still online');
    second.close();
  });

  it('revoking closes the socket with 4401, removes the tools, and the token cannot connect again', async () => {
    const r = await rig();
    const p = r.pair();
    const d = await online(r, p.token);
    await waitFor(() => r.registry.has('device-pc__shell_run'));
    assert.equal(r.svc.hub.revoke(p.id), true);
    assert.equal((await d.closed).code, 4401);
    assert.equal(r.registry.has('device-pc__shell_run'), false);
    r.svc.store.delete(p.id);
    await assert.rejects(connectFakeDevice(r.port, p.token), (e: any) => e.status === 401);
    assert.equal(r.svc.hub.revoke(p.id), false);
  });

  it('shutdown closes every device with 1001', async () => {
    const r = await rig();
    const d = await online(r, r.pair('a').token);
    const e = await online(r, r.pair('b').token);
    await waitFor(() => r.svc.hub.list().length === 2);
    await r.svc.hub.shutdown(500);
    assert.equal((await d.closed).code, 1001);
    assert.equal((await e.closed).code, 1001);
  });

  it('pings, and terminates a socket that stops answering', async () => {
    const r = await rig({ pingIntervalMs: 30, deadAfterMs: 200 });
    const lively = await online(r, r.pair('lively').token);
    const mute = await online(r, r.pair('mute').token, { autoPong: false });
    let pings = 0;
    lively.ws.on('ping', () => pings++);
    await waitFor(() => r.svc.hub.list().length === 2);
    assert.equal((await mute.closed).code, 1006, 'terminated, not closed politely');
    await waitFor(() => !r.registry.has('device-mute__shell_run'));
    assert.ok(pings >= 2);
    assert.equal(r.svc.hub.isOnline(r.svc.store.list().find(x => x.slug === 'lively')!.id), true);
  });

  it('closes a socket that sends binary frames, malformed JSON, or an oversize frame', async () => {
    for (const [name, send, code] of [
      ['binary', (ws: WebSocket) => ws.send(Buffer.from([1, 2, 3])), 1003],
      ['not json', (ws: WebSocket) => ws.send('{nope'), 1007],
      ['not json-rpc', (ws: WebSocket) => ws.send('{"hello":1}'), 1007],
      ['oversize', (ws: WebSocket) => ws.send('x'.repeat(16 * 1024 * 1024 + 10)), 1009],
    ] as const) {
      const r = await rig();
      const p = r.pair();
      const d = await online(r, p.token);
      await waitFor(() => r.svc.hub.isOnline(p.id));
      send(d.ws);
      assert.equal((await d.closed).code, code, name);
      await waitFor(() => !r.svc.hub.isOnline(p.id));
      await r.close();
    }
  });

  it('gives up on a device that never answers initialize', async () => {
    const r = await rig({ initTimeoutMs: 150 });
    const p = r.pair();
    const d = await online(r, p.token, { answerInitialize: false });
    await d.closed; // the SDK closes the transport itself when initialize times out
    assert.equal(r.svc.hub.isOnline(p.id), false);
    assert.equal(r.registry.toLlmTools().length, 0);
  });

  it('a device without usable info still connects, but its shell is judged as unparsable (strict)', async () => {
    const r = await rig();
    const p = r.pair();
    await online(r, p.token, { report: null });
    await waitFor(() => r.svc.hub.isOnline(p.id));
    assert.equal(r.svc.store.get(p.id)?.report, null);
    assert.deepEqual(r.svc.commandScope('device-pc/shell_run'), { namespace: 'device-pc', mode: 'strict' });
  });
});
