import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, listApprovalGrants, openDb, runMigrations, updateProject } from '../db.js';
import { WebApprovalGate } from '../web-approval.js';
import { PolicyStore } from '../policy-file.js';
import { ToolRegistry } from '../tool-registry.js';
import { createDeviceService } from '../devices/index.js';
import { deviceAutoApproves } from '../devices/connection.js';
import { extractCommand, commandGrantLabel } from '../command-policy.js';
import { DEFAULT_DEVICE_POLICY, type DevicePolicy } from '../devices/types.js';
import { hashDeviceToken, newDeviceToken } from '../devices/store.js';
import { closeRigs, deviceRig, online, posixReport, waitFor } from './devices-fixture.js';

afterEach(closeRigs);

function gateRig(policyJson: unknown = { commands: { allow: [], deny: [] } }) {
  const db = openDb(':memory:');
  runMigrations(db);
  const file = join(mkdtempSync(join(tmpdir(), 'dev-policy-')), 'policy.json');
  writeFileSync(file, JSON.stringify(policyJson));
  const svc = createDeviceService({ db, registry: new ToolRegistry([]) });
  const gate = new WebApprovalGate(db, new PolicyStore(file));
  gate.setCommandScopeResolver(svc.commandScope);
  const add = (name: string, policy: Partial<DevicePolicy> = {}, kind: 'posix' | 'powershell' | 'none' = 'posix') => {
    const row = svc.store.create({ name, platform: kind === 'powershell' ? 'windows' : 'linux', agentVersion: '1', tokenHash: hashDeviceToken(newDeviceToken()), policy: { ...DEFAULT_DEVICE_POLICY, ...policy } });
    if (kind !== 'none') svc.store.setReport(row.id, posixReport({ shell: { enabled: true, kind, path: kind === 'posix' ? '/bin/bash' : 'pwsh' } }));
    return row;
  };
  /** Runs a call to the gate; returns the pending card (and a way to answer it) when it asks, else the immediate decision. */
  async function ask(label: string, args: Record<string, unknown>, ctx: Parameters<WebApprovalGate['confirmDetailed']>[4] = {}) {
    const decision = gate.confirmDetailed('chat-1', label, args, undefined, ctx);
    await new Promise(r => setImmediate(r));
    const pending = gate.listPending();
    if (pending.length === 0) return { asked: false as const, decision: await decision };
    const entry = pending[pending.length - 1]!;
    return { asked: true as const, entry, answer: async (approved: boolean, scope: 'once' | 'chat' | 'project' | 'always' = 'once') => { gate.resolve(entry.id, approved, scope); return decision; } };
  }
  return { db, svc, gate, add, ask };
}

describe('approval gate for device shells (ADR 0019)', () => {
  it('extractCommand knows shell_run (command) and shell_send (input)', () => {
    assert.equal(extractCommand('device-pc/shell_run', { command: 'ls' }), 'ls');
    assert.equal(extractCommand('device-pc/shell_send', { session: 'main', input: 'y' }), 'y');
    assert.equal(extractCommand('device-pc/shell_run', { input: 'ls' }), null);
    assert.equal(extractCommand('device-pc/shell_read', { session: 'main' }), null);
    assert.equal(commandGrantLabel('git push'), 'cmd:git push');
    assert.equal(commandGrantLabel('git push', 'device-pc'), 'cmd@device-pc:git push');
  });

  it('allowlist: read-only commands run, the rest asks with the device namespace on the card', async () => {
    const t = gateRig();
    t.add('PC');
    assert.deepEqual(await t.ask('device-pc/shell_run', { command: 'ls -la && git status' }), { asked: false, decision: { approved: true } });
    const r = await t.ask('device-pc/shell_run', { command: 'npm install' });
    assert.ok(r.asked);
    assert.equal(r.entry.grantNamespace, 'device-pc');
    assert.deepEqual(r.entry.covers, ['npm install']);
    await r.answer(true);
  });

  it('"always" is stored as cmd@device-pc:… and covers only that device', async () => {
    const t = gateRig();
    t.add('PC'); t.add('Laptop');
    const first = await t.ask('device-pc/shell_run', { command: 'npm install' });
    assert.ok(first.asked);
    await first.answer(true, 'always');
    assert.deepEqual(listApprovalGrants(t.db).map(g => g.toolLabel), ['cmd@device-pc:npm install']);

    assert.deepEqual(await t.ask('device-pc/shell_run', { command: 'npm install left-pad' }), { asked: false, decision: { approved: true } });
    const laptop = await t.ask('device-laptop/shell_run', { command: 'npm install' });
    assert.ok(laptop.asked, 'a grant on the PC does not cover the laptop');
    await laptop.answer(false);
    const sandbox = await t.ask('sandbox/run_bash', { command: 'npm install' });
    assert.ok(sandbox.asked, 'a grant on the PC does not cover the sandbox');
    await sandbox.answer(false);
  });

  it('a sandbox grant does not cover a device, and the sandbox still uses plain cmd: labels', async () => {
    const t = gateRig();
    t.add('PC');
    const s = await t.ask('sandbox/run_bash', { command: 'npm install' });
    assert.ok(s.asked);
    assert.equal(s.entry.grantNamespace, undefined);
    await s.answer(true, 'always');
    assert.deepEqual(listApprovalGrants(t.db).map(g => g.toolLabel), ['cmd:npm install']);
    assert.deepEqual(await t.ask('sandbox/run_bash', { command: 'npm install' }), { asked: false, decision: { approved: true } });
    const d = await t.ask('device-pc/shell_run', { command: 'npm install' });
    assert.ok(d.asked, 'a sandbox grant does not reach the device');
    await d.answer(false);
  });

  it('a "for this chat" grant is namespaced too', async () => {
    const t = gateRig();
    t.add('PC'); t.add('Laptop');
    const a = await t.ask('device-pc/shell_run', { command: 'make build' });
    assert.ok(a.asked);
    await a.answer(true, 'chat');
    assert.equal((await t.ask('device-pc/shell_run', { command: 'make build' })).asked, false);
    const b = await t.ask('device-laptop/shell_run', { command: 'make build' });
    assert.ok(b.asked);
    await b.answer(false);
  });

  it('a PowerShell device on allowlist behaves as strict; auto stays auto; strict asks for everything', async () => {
    const t = gateRig();
    t.add('Win', { shell: 'allowlist' }, 'powershell');
    const ls = await t.ask('device-win/shell_run', { command: 'Get-ChildItem' });
    assert.ok(ls.asked, 'allowlist is strict where the policy cannot parse the shell');
    await ls.answer(false);
    assert.deepEqual(t.svc.commandScope('device-win/shell_run'), { namespace: 'device-win', mode: 'strict' });

    t.add('Auto Win', { shell: 'auto' }, 'powershell');
    assert.deepEqual(t.svc.commandScope('device-auto-win/shell_run')?.mode, 'auto');
    assert.deepEqual(await t.ask('device-auto-win/shell_run', { command: 'npm install' }), { asked: false, decision: { approved: true } });

    t.add('Strict', { shell: 'strict' });
    const s = await t.ask('device-strict/shell_run', { command: 'ls' });
    assert.ok(s.asked, 'strict asks even for ls');
    await s.answer(false);
  });

  it('auto mode still asks at a boundary (a push), and destructive commands are capped at "for this chat"', async () => {
    const t = gateRig();
    t.add('PC', { shell: 'auto' });
    const push = await t.ask('device-pc/shell_run', { command: 'git push origin main' });
    assert.ok(push.asked);
    await push.answer(false);
    const rm = await t.ask('device-pc/shell_run', { command: 'rm -rf /home/me/build' });
    assert.ok(rm.asked, 'a recursive delete outside the workspace boundary asks');
    assert.equal(rm.entry.maxScope, 'chat');
    await rm.answer(false);
  });

  it('policy.json lists apply on top of the device level; the project\'s policy does not', async () => {
    const t = gateRig({ commands: { allow: ['make test'], deny: ['docker push'] } });
    t.add('PC', { shell: 'strict' });
    assert.deepEqual(await t.ask('device-pc/shell_run', { command: 'make test' }), { asked: false, decision: { approved: true } });
    const denied = await t.ask('device-pc/shell_run', { command: 'docker push image' });
    assert.deepEqual(denied, { asked: false, decision: { approved: false, reason: 'blocked by the command policy: docker push image' } });
    assert.deepEqual((await t.ask('device-pc/shell_run', { command: 'rm -rf /' })).asked, false, 'the built-in deny patterns apply to devices');

    const project = createProject(t.db, { name: 'p' });
    updateProject(t.db, project.id, { policy: { commands: { mode: 'auto', allow: ['npm install'] } } });
    const inProject = await t.ask('device-pc/shell_run', { command: 'npm install' }, { projectId: project.id });
    assert.ok(inProject.asked, 'the project\'s auto mode and allow list say nothing about the PC');
    await inProject.answer(false);
    assert.equal((await t.ask('sandbox/run_bash', { command: 'npm install' }, { projectId: project.id })).asked, false, 'while the sandbox still follows it');
  });

  it('shell_send is judged on its input', async () => {
    const t = gateRig();
    t.add('PC');
    assert.equal((await t.ask('device-pc/shell_send', { session: 'main', input: 'ls' })).asked, false);
    const rm = await t.ask('device-pc/shell_send', { session: 'main', input: 'npm publish' });
    assert.ok(rm.asked);
    await rm.answer(false);
  });

  it('a level changed in Settings applies to the next call, and an unknown or reportless device is strict', async () => {
    const t = gateRig();
    const row = t.add('PC');
    assert.equal((await t.ask('device-pc/shell_run', { command: 'ls' })).asked, false);
    t.svc.store.setPolicy(row.id, { ...row.policy, shell: 'strict' });
    const strict = await t.ask('device-pc/shell_run', { command: 'ls' });
    assert.ok(strict.asked);
    await strict.answer(false);
    t.svc.store.setPolicy(row.id, { ...row.policy, shell: 'auto' });
    assert.equal((await t.ask('device-pc/shell_run', { command: 'npm install' })).asked, false);

    t.add('No Report', {}, 'none');
    const nr = await t.ask('device-no-report/shell_run', { command: 'ls' });
    assert.ok(nr.asked, 'without a report the shell is not known to be POSIX');
    await nr.answer(false);
    const gone = await t.ask('device-gone/shell_run', { command: 'ls' });
    assert.ok(gone.asked, 'a device that was revoked mid-call');
    await gone.answer(false);
  });
});

describe('what a device tool needs approval for (autoApproves, ADR 0019)', () => {
  const ask = DEFAULT_DEVICE_POLICY;
  const auto: DevicePolicy = { shell: 'auto', filesWrite: 'auto', browserAct: 'auto' };

  it('is a table: reading never asks, writing and acting follow their level, shell and browser_open go elsewhere', () => {
    for (const t of ['shell_read', 'shell_list', 'shell_close', 'fs_list', 'fs_read', 'fs_search', 'browser_observe', 'browser_screenshot', 'browser_tabs', 'browser_close']) {
      assert.equal(deviceAutoApproves(t, ask), true, t);
    }
    for (const t of ['fs_write', 'fs_edit', 'fs_mkdir']) {
      assert.equal(deviceAutoApproves(t, ask), false, t);
      assert.equal(deviceAutoApproves(t, auto), true, t);
    }
    assert.equal(deviceAutoApproves('browser_act', ask), false);
    assert.equal(deviceAutoApproves('browser_act', auto), true);
    for (const t of ['shell_run', 'shell_send', 'browser_open', 'something_new']) {
      assert.equal(deviceAutoApproves(t, auto), false, `${t} never skips the gate through this table`);
    }
  });

  it('decides in the registry for a real connection, beats AUTO_APPROVE_TOOLS in both directions, and follows live policy changes', async () => {
    // browser_act and browser_open are in the default AUTO_APPROVE_TOOLS list; a device must not inherit that.
    const r = await deviceRig({}, ['browser_act', 'browser_open', 'fs_write']);
    const p = r.pair();
    await online(r, p.token, { tools: [{ name: 'fs_write' }, { name: 'fs_read' }, { name: 'browser_act' }, { name: 'browser_open' }, { name: 'shell_run' }] });
    await waitFor(() => r.registry.has('device-pc__fs_write'));
    const needs = (t: string) => r.registry.requiresApproval(`device-pc__${t}`);
    assert.deepEqual(['fs_read', 'fs_write', 'browser_act', 'browser_open', 'shell_run'].map(needs), [false, true, true, true, true]);

    r.svc.store.setPolicy(p.id, { ...DEFAULT_DEVICE_POLICY, filesWrite: 'auto', browserAct: 'auto' });
    assert.deepEqual(['fs_read', 'fs_write', 'browser_act', 'browser_open', 'shell_run'].map(needs), [false, false, false, true, true], 'applies to the very next call');
    r.svc.store.setPolicy(p.id, DEFAULT_DEVICE_POLICY);
    assert.equal(needs('fs_write'), true);
  });
});
