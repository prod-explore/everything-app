import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, type LlmClient } from '../llm-loop.js';
import type * as Llm from '../llm-types.js';
import { TRANSFER_MAX_BYTES, parseEndpoint } from '../devices/transfer.js';
import { DEFAULT_DEVICE_POLICY } from '../devices/types.js';
import { closeRigs, deviceRig, online, posixReport, waitFor, type Rig } from './devices-fixture.js';

afterEach(closeRigs);

/** A workspace on disk: the exact shell commands of the write path run against a temp dir. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'xfer-'));
  const sandbox = { exec: async (_o: string, cmd: string) => {
    execFileSync('bash', ['-c', cmd.replaceAll('/workspace', dir)]);
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  const readFile = async (_o: string, path: string) => readFileSync(join(dir, path.replace(/^\/workspace\//, '')));
  return { dir, sandbox, readFile };
}

/** A device with a tiny in-memory disk behind _fs_read_b64 / _fs_write_b64. */
async function deviceWithDisk(r: Rig, disk: Map<string, Buffer>, name = 'PC', report = posixReport()) {
  const p = r.pair(name);
  const writes: Array<Record<string, unknown>> = [];
  await online(r, p.token, { report, tools: [
    { name: 'fs_list' },
    { name: '_fs_read_b64', handler: a => {
      const data = disk.get(String(a['path']));
      return data ? { name: String(a['path']).split(/[\\/]/).pop(), size: data.length, base64: data.toString('base64') } : { text: `ENOENT: ${a['path']}`, isError: true };
    } },
    { name: '_fs_write_b64', handler: a => {
      writes.push(a);
      if (disk.has(String(a['path'])) && a['overwrite'] !== true) return { text: 'file exists', isError: true };
      disk.set(String(a['path']), Buffer.from(String(a['base64']), 'base64'));
      return { path: a['path'], size: disk.get(String(a['path']))!.length };
    } },
  ] });
  await waitFor(() => r.svc.hub.isOnline(p.id));
  return { ...p, writes };
}

const tool = (r: Rig, ws: ReturnType<typeof workspace>) => {
  const [t] = r.svc.transferTools({ owner: 'o', sandbox: ws.sandbox, readFile: ws.readFile });
  assert.ok(t, 'offered while a device is online');
  return t;
};
const ctx = { toolUseId: 't1' };

describe('device_transfer', () => {
  it('is offered only while a device is online', async () => {
    const r = await deviceRig();
    const ws = workspace();
    assert.deepEqual(r.svc.transferTools({ owner: 'o', sandbox: ws.sandbox, readFile: ws.readFile }), []);
    const disk = new Map<string, Buffer>();
    await deviceWithDisk(r, disk);
    assert.equal(r.svc.transferTools({ owner: 'o', sandbox: ws.sandbox, readFile: ws.readFile }).length, 1);
    assert.match(tool(r, ws).definition.description ?? '', /device-pc/);
  });

  it('copies a binary file from a device into the workspace, and back, byte for byte', async () => {
    const r = await deviceRig();
    const ws = workspace();
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
    const disk = new Map<string, Buffer>([['/home/me/data.bin', bytes]]);
    await deviceWithDisk(r, disk);
    const t = tool(r, ws);

    const down = await t.handler({ from: 'device-pc:/home/me/data.bin', to: 'workspace:inbox/' }, ctx);
    assert.equal(down.isError, undefined, down.text);
    assert.match(down.text, /Copied 5000 bytes to workspace:\/workspace\/inbox\/data\.bin/);
    assert.deepEqual(readFileSync(join(ws.dir, 'inbox/data.bin')), bytes);

    const up = await t.handler({ from: 'workspace:inbox/data.bin', to: 'device-pc:/home/me/copy.bin' }, ctx);
    assert.equal(up.isError, undefined, up.text);
    assert.deepEqual(disk.get('/home/me/copy.bin'), bytes);
  });

  it('does not replace a file on a device unless told to, and reports device errors', async () => {
    const r = await deviceRig();
    const ws = workspace();
    mkdirSync(join(ws.dir, 'a'), { recursive: true });
    writeFileSync(join(ws.dir, 'a/f.txt'), 'new');
    const disk = new Map<string, Buffer>([['C:\\x\\f.txt', Buffer.from('old')]]);
    const dev = await deviceWithDisk(r, disk);
    const t = tool(r, ws);
    const refused = await t.handler({ from: 'workspace:a/f.txt', to: 'device-pc:C:\\x\\f.txt' }, ctx);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /file exists/);
    assert.equal(disk.get('C:\\x\\f.txt')!.toString(), 'old');
    const ok = await t.handler({ from: 'workspace:a/f.txt', to: 'device-pc:C:\\x\\f.txt', overwrite: true }, ctx);
    assert.equal(ok.isError, undefined, ok.text);
    assert.equal(disk.get('C:\\x\\f.txt')!.toString(), 'new');
    assert.equal(dev.writes.at(-1)!['overwrite'], true);

    const missing = await t.handler({ from: 'device-pc:/nope', to: 'workspace:x.txt' }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /ENOENT/);
  });

  it('refuses files over the cap in either direction, without writing anything', async () => {
    const r = await deviceRig();
    const ws = workspace();
    const big = Buffer.alloc(TRANSFER_MAX_BYTES + 1, 1);
    const disk = new Map<string, Buffer>([['/big', big]]);
    const dev = await deviceWithDisk(r, disk);
    writeFileSync(join(ws.dir, 'big.bin'), big);
    const t = tool(r, ws);
    const down = await t.handler({ from: 'device-pc:/big', to: 'workspace:big.bin' }, ctx);
    assert.equal(down.isError, true);
    assert.match(down.text, /at most 12 MB/);
    const up = await t.handler({ from: 'workspace:big.bin', to: 'device-pc:/big2' }, ctx);
    assert.equal(up.isError, true);
    assert.equal(dev.writes.length, 0);
    assert.equal(disk.has('/big2'), false);
  });

  it('refuses, without a card, a copy the device\'s own settings rule out', async () => {
    const r = await deviceRig();
    const ws = workspace();
    writeFileSync(join(ws.dir, 'a.txt'), 'x');
    const disk = new Map<string, Buffer>([['/a', Buffer.from('x')]]);
    const dev = await deviceWithDisk(r, disk, 'PC', posixReport({ files: { enabled: true, roots: ['/home/me'], write: false } }));
    const t = tool(r, ws);
    const needs = (input: Record<string, unknown>) => (typeof t.requiresApproval === 'function' ? t.requiresApproval(input) : t.requiresApproval === true);
    assert.equal(needs({ from: 'workspace:a.txt', to: 'device-pc:/b' }), false, 'no card for a write the device refuses');
    const up = await t.handler({ from: 'workspace:a.txt', to: 'device-pc:/b' }, ctx);
    assert.equal(up.isError, true);
    assert.match(up.text, /read-only/);
    assert.equal(dev.writes.length, 0);
    const down = await t.handler({ from: 'device-pc:/a', to: 'workspace:a2.txt' }, ctx);
    assert.equal(down.isError, undefined, 'reading from a read-only device still works');

    const r2 = await deviceRig();
    await deviceWithDisk(r2, new Map(), 'PC', posixReport({ files: { enabled: false, roots: [], write: false } }));
    const off = await tool(r2, ws).handler({ from: 'device-pc:/a', to: 'workspace:a3.txt' }, ctx);
    assert.equal(off.isError, true);
    assert.match(off.text, /Files are switched off on PC/);
  });

  it('rejects bad endpoints and offline devices', async () => {
    const r = await deviceRig();
    const ws = workspace();
    await deviceWithDisk(r, new Map());
    const t = tool(r, ws);
    for (const [from, to] of [['workspace:a', 'workspace:b'], ['nowhere:a', 'workspace:b'], ['workspace:', 'device-pc:/x'], ['device-gone:/a', 'workspace:b'], ['', 'workspace:b']]) {
      const res = await t.handler({ from, to }, ctx);
      assert.equal(res.isError, true, `${from} -> ${to}`);
    }
    assert.deepEqual(parseEndpoint('device-pc:C:\\a\\b.txt'), { kind: 'device', connection: 'device-pc', path: 'C:\\a\\b.txt' });
    assert.deepEqual(parseEndpoint('workspace:a/b'), { kind: 'workspace', path: 'a/b' });
  });

  it('asks only for a copy onto a device that asks for file writes, and scopes the grant to that device', async () => {
    const r = await deviceRig();
    const ws = workspace();
    const dev = await deviceWithDisk(r, new Map());
    const t = tool(r, ws);
    const needs = (input: Record<string, unknown>) => (typeof t.requiresApproval === 'function' ? t.requiresApproval(input) : t.requiresApproval === true);
    assert.equal(needs({ from: 'workspace:a', to: 'device-pc:/x' }), true);
    assert.equal(needs({ from: 'device-pc:/x', to: 'workspace:a' }), false, 'into the workspace needs none');
    assert.equal(t.approvalLabel!({ from: 'workspace:a', to: 'device-pc:/x' }), 'device-pc/device_transfer');
    r.svc.store.setPolicy(dev.id, { ...DEFAULT_DEVICE_POLICY, filesWrite: 'auto' });
    assert.equal(needs({ from: 'workspace:a', to: 'device-pc:/x' }), false, 'a level of auto skips the card, applied live');
  });

  it('goes through the approval gate inside a real turn: refused means nothing is written', async () => {
    const r = await deviceRig();
    const ws = workspace();
    writeFileSync(join(ws.dir, 'f.txt'), 'hello');
    const disk = new Map<string, Buffer>();
    await deviceWithDisk(r, disk);
    const asked: string[] = [];
    const msg = (id: string, content: unknown[], stop: 'tool_use' | 'end_turn') => ({ id, type: 'message', role: 'assistant', model: 'x', stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content }) as Llm.Message;
    const use = (id: string) => msg(`m-${id}`, [{ type: 'tool_use', id, name: 'device_transfer', input: { from: 'workspace:f.txt', to: 'device-pc:/f.txt' } }], 'tool_use');
    const script: Llm.Message[] = [use('u1'), msg('m2', [{ type: 'text', text: 'done' }], 'end_turn')];
    const llm: LlmClient = { messages: { create: async () => script.shift()! } };
    let approve = false;
    const run = () => runTurn({
      llm, model: 'x', tools: r.registry, systemPrompt: '', virtualTools: r.svc.transferTools({ owner: 'o', sandbox: ws.sandbox, readFile: ws.readFile }),
      confirm: async label => { asked.push(label); return approve; },
    }, [], 'go');

    await run();
    assert.deepEqual(asked, ['device-pc/device_transfer']);
    assert.equal(disk.size, 0, 'a refused transfer writes nothing');

    script.push(use('u2'), msg('m4', [{ type: 'text', text: 'ok' }], 'end_turn'));
    approve = true;
    await run();
    assert.equal(disk.get('/f.txt')?.toString(), 'hello');
  });
});
