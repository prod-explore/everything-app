import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedConfig } from '../config.js';
import { ShellManager } from '../shell/manager.js';
import { capOutput, OutputBuffer } from '../shell/output.js';
import { markerPattern, newNonce, posixCommand } from '../shell/protocol.js';
import { ShellSession, SessionBusyError, type ShellSpec } from '../shell/session.js';
import { formatRun, registerShellTools } from '../tools/shell.js';

const posix = process.platform !== 'win32';
function pgrep(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const bash: ShellSpec = { path: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', kind: 'posix', platform: 'linux' };

describe('output bookkeeping', () => {
  it('keeps head and tail of an over-long result and says how much it left out', () => {
    const text = 'a'.repeat(50_000) + 'b'.repeat(50_000);
    const capped = capOutput(text);
    assert.ok(capped.length < 30_300);
    assert.ok(capped.startsWith('aaaa') && capped.endsWith('bbbb'));
    assert.match(capped, /70000 characters omitted/);
    assert.equal(capOutput('short'), 'short');
  });

  it('OutputBuffer stays bounded and finds the marker in the tail after dropping the middle', () => {
    const buf = new OutputBuffer();
    for (let i = 0; i < 100; i++) buf.append('x'.repeat(10_000));
    const n = newNonce();
    buf.append(`\n<<EVV:${n.full}:7:/tmp>>\nrest`);
    const cut = buf.cutAt(markerPattern(n.full));
    assert.ok(cut);
    assert.equal(cut.match[1], '7');
    assert.equal(cut.after, 'rest');
    const out = buf.take();
    assert.ok(out.length < 310_000);
    assert.match(out, /characters dropped/);
  });

  it('the command text never contains the complete marker, so a shell error quoting it cannot end the command early', () => {
    const n = newNonce();
    const script = posixCommand('echo hi', n);
    assert.ok(!script.includes(`<<EVV:${n.full}`));
  });
});

describe('formatRun', () => {
  const base = { output: 'out\n', exitCode: 0, cwd: '/w', timedOut: false, cancelled: false, shellEnded: false };
  it('ends with exit code and cwd; non-zero is an error', () => {
    assert.deepEqual(formatRun(base, 'main', 120), { text: 'out\nexit code: 0\n[cwd: /w]', isError: false });
    assert.equal(formatRun({ ...base, exitCode: 2 }, 'main', 120).isError, true);
  });
  it('tells the model a timeout interrupted the command and the session survives', () => {
    const r = formatRun({ ...base, exitCode: 130, timedOut: true }, 'dev', 30);
    assert.match(r.text, /timed out after 30s — the command was interrupted; session "dev" is still open/);
    assert.equal(r.isError, true);
  });
  it('reports a shell that ended', () => {
    const r = formatRun({ ...base, exitCode: null, shellEnded: true }, 'main', 120, 'the shell exited with code 3');
    assert.match(r.text, /the shell exited with code 3 — the next command opens a fresh session/);
  });
});

describe('shell sessions (real shell, pipes)', { skip: !posix }, () => {
  const sessions: ShellSession[] = [];
  const start = async (spec = bash, cwd = '/tmp'): Promise<ShellSession> => {
    const s = await ShellSession.start(spec, cwd);
    sessions.push(s);
    return s;
  };
  after(async () => {
    await Promise.all(sessions.map(s => s.close()));
  });

  it('working directory and environment persist between commands', async () => {
    const s = await start();
    await s.run('cd /usr && export EVV_TEST=kept', 5000);
    const r = await s.run('pwd; echo $EVV_TEST', 5000);
    assert.equal(r.output, '/usr\nkept\n');
    assert.equal(r.cwd, '/usr');
  });

  it('reports exit codes, merges stderr in order, and the marker never leaks into output', async () => {
    const s = await start();
    const r = await s.run('echo one; echo two >&2; echo three; (exit 4)', 5000);
    assert.equal(r.exitCode, 4);
    assert.equal(r.output, 'one\ntwo\nthree\n');
    assert.ok(!r.output.includes('<<EVV'));
    const nonl = await s.run('printf abc', 5000);
    assert.equal(nonl.output, 'abc');
    const empty = await s.run('true', 5000);
    assert.equal(empty.output, '');
  });

  it('a syntax error or unterminated quote fails that command only', async () => {
    const s = await start();
    const bad = await s.run("echo 'unterminated", 5000);
    assert.notEqual(bad.exitCode, 0);
    assert.equal(bad.shellEnded, false);
    assert.equal((await s.run('echo fine', 5000)).output, 'fine\n');
  });

  it('works with multi-line commands, heredocs and unicode', async () => {
    const s = await start();
    const r = await s.run('cat <<EOF\nżółć ✓\nsecond\nEOF\nfor i in 1 2; do echo $i; done', 5000);
    assert.equal(r.output, 'żółć ✓\nsecond\n1\n2\n');
  });

  it('works in a plain POSIX sh (dash)', { skip: !existsSync('/usr/bin/dash') }, async () => {
    const s = await start({ path: '/usr/bin/dash', kind: 'posix', platform: 'linux' });
    await s.run('cd /usr', 5000);
    const r = await s.run('pwd; echo err >&2', 5000);
    assert.equal(r.output, '/usr\nerr\n');
  });

  it('a timeout interrupts `sleep 100` within the timeout and the session stays alive with its state', async () => {
    const s = await start();
    await s.run('cd /usr', 5000);
    const t0 = Date.now();
    const r = await s.run('sleep 100', 800);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`);
    assert.equal(r.timedOut, true);
    assert.equal(r.shellEnded, false);
    assert.equal(r.exitCode, 130);
    const next = await s.run('pwd', 5000);
    assert.equal(next.output, '/usr\n'); // same shell, directory kept
    assert.equal(s.isDead, false);
  });

  it('interrupting kills the command and its children', async () => {
    const s = await start();
    const r = await s.run("sh -c 'sleep 55.5; echo unreachable'", 600);
    assert.equal(r.timedOut, true);
    assert.ok(!r.output.includes('unreachable'));
    assert.equal(pgrep('sleep 55.5'), false);
  });

  it('closing a session ends what it started in the background', async () => {
    const s = await start();
    await s.run('sleep 66.6 &', 5000);
    assert.equal(pgrep('sleep 66.6'), true);
    await s.close();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pgrep('sleep 66.6'), false);
  });

  it('a command that ignores SIGINT is escalated: the shell is killed and that is reported', { timeout: 20_000 }, async () => {
    const s = await start();
    const r = await s.run('while true; do :; done', 500);
    assert.equal(r.timedOut, true);
    assert.equal(r.shellEnded, true);
    assert.equal(s.isDead, true);
  });

  it('refuses a second command while one is running, with a clear error', async () => {
    const s = await start();
    s.startBackground('sleep 5');
    assert.throws(() => s.startBackground('echo x'), SessionBusyError);
    await assert.rejects(s.run('echo x', 1000), SessionBusyError);
    s.interrupt();
    await s.settle(2000, 100);
  });

  it('background commands: returns at once, shell_read-style collection, shell_send answers a prompt', async () => {
    const s = await start();
    s.startBackground('IFS= read -r n; echo "hello $n"; sleep 0.2; echo done');
    assert.equal(s.isRunning, true);
    assert.deepEqual(s.read(), { output: '', running: true, finished: null });
    s.send('bob');
    for (let i = 0; i < 40 && s.isRunning; i++) await s.settle(250, 50);
    const r = s.read();
    assert.equal(r.output, 'hello bob\ndone\n');
    assert.equal(r.running, false);
    assert.equal(r.finished?.exitCode, 0);
    assert.equal(s.read().finished, null, 'a finished command is reported once');
  });

  it('send with no running command is an error (nothing would read it)', async () => {
    const s = await start();
    assert.throws(() => s.send('x'), /no command is running/);
  });

  it('a command that runs `exit` ends the shell and says so', async () => {
    const s = await start();
    const r = await s.run('echo bye; exit 3', 5000);
    assert.equal(r.shellEnded, true);
    assert.equal(r.exitCode, 3);
    assert.equal(r.output, 'bye\n');
    assert.match(s.exitDescription, /exited with code 3/);
  });

  it('huge output stays bounded', { timeout: 30_000 }, async () => {
    const s = await start();
    const r = await s.run('head -c 3000000 /dev/zero | tr "\\0" "x"; echo END', 20_000);
    assert.ok(r.output.length < 310_000);
    assert.ok(r.output.endsWith('END\n'));
    assert.match(capOutput(r.output), /omitted/);
  });

  it('cancelling the call interrupts the command', async () => {
    const s = await start();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await s.run('sleep 100', 60_000, ac.signal);
    assert.equal(r.cancelled, true);
    assert.equal(s.isDead, false);
  });
});

describe('ShellManager', { skip: !posix }, () => {
  const mk = (extra = {}): ShellManager => new ShellManager({ spec: bash, defaultCwd: '/tmp', ...extra });

  it('keys sessions by conversation and name; caps them at 8; lists per conversation', async () => {
    const m = mk();
    try {
      const a = await m.acquire('c1', 'main');
      const again = await m.acquire('c1', 'main');
      assert.equal(a.session, again.session);
      assert.equal(again.created, false);
      assert.notEqual((await m.acquire('c2', 'main')).session, a.session);
      for (let i = 0; i < 6; i++) await m.acquire('c1', `s${i}`);
      await assert.rejects(m.acquire('c1', 'ninth'), /already has 8 shell sessions/);
      assert.equal((await m.list('c1')).length, 7);
      assert.equal((await m.list('c2')).length, 1);
      assert.equal(await m.close('c1', 's0'), true);
      await m.acquire('c1', 'ninth'); // a slot is free again
    } finally {
      await m.dispose();
    }
  });

  it('rejects a cwd that is not a directory, and uses it for a new session', async () => {
    const m = mk();
    try {
      await assert.rejects(m.acquire('c', 'x', '/definitely/not/here'), /not a directory/);
      const { session } = await m.acquire('c', 'y', '/usr');
      assert.equal((await session.run('pwd', 5000)).output, '/usr\n');
    } finally {
      await m.dispose();
    }
  });

  it('reaps idle sessions and forgets a shell that exited', async () => {
    const m = mk({ idleMs: 1000 });
    try {
      const { session } = await m.acquire('c', 'idle');
      assert.equal(await m.reap(Date.now()), 0);
      assert.equal(await m.reap(Date.now() + 5000), 1);
      assert.equal(session.isDead, true);
      const { session: s2 } = await m.acquire('c', 'dies');
      await s2.run('exit 0', 5000);
      assert.equal(await m.get('c', 'dies'), null);
      assert.equal((await m.acquire('c', 'dies')).created, true);
    } finally {
      await m.dispose();
    }
  });
});

describe('shell tools over MCP', { skip: !posix }, () => {
  const cfg = {
    deviceName: 'PC',
    platform: 'linux',
    shell: { enabled: true, kind: 'posix', path: bash.path, cwd: '/tmp' },
  } as unknown as ResolvedConfig;

  async function setup(): Promise<{ client: Client; manager: ShellManager; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> }> {
    const manager = new ShellManager({ spec: bash, defaultCwd: '/tmp' });
    const server = new McpServer({ name: 't', version: '0' });
    registerShellTools(server, cfg, manager);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: { _conversation_id: 'chat1', ...args } })) as { content: Array<{ text: string }>; isError?: boolean };
      return { text: r.content.map(c => c.text).join('\n'), isError: r.isError === true };
    };
    return { client, manager, call };
  }

  it('descriptions name the device, OS and shell and say it is not a sandbox', async () => {
    const { client, manager } = await setup();
    try {
      const tools = (await client.listTools()).tools;
      assert.deepEqual(tools.map(t => t.name).sort(), ['shell_close', 'shell_list', 'shell_read', 'shell_run', 'shell_send']);
      const run = tools.find(t => t.name === 'shell_run')!;
      assert.match(run.description!, /the user's own computer 'PC' \(Linux, bash\)/);
      assert.match(run.description!, /not a sandbox/);
    } finally {
      await manager.dispose();
    }
  });

  it('shell_run → shell_list → background + shell_read → shell_close', async () => {
    const { manager, call } = await setup();
    try {
      const r = await call('shell_run', { command: 'cd /usr && echo hi' });
      assert.equal(r.text, 'hi\nexit code: 0\n[cwd: /usr]');
      const failed = await call('shell_run', { command: 'exit_not_a_command_xyz' });
      assert.equal(failed.isError, true);
      assert.match(failed.text, /exit code: 127/);

      const bg = await call('shell_run', { command: 'echo started; sleep 0.3; echo finished', session: 'bg', background: true });
      assert.match(bg.text, /Started in the background in session "bg"/);
      const busy = await call('shell_run', { command: 'echo x', session: 'bg' });
      assert.equal(busy.isError, true);
      assert.match(busy.text, /still running/);
      let out = '';
      for (let i = 0; i < 20 && !out.includes('exit code'); i++) out += (await call('shell_read', { session: 'bg' })).text + '\n';
      assert.match(out, /started[\s\S]*finished/);
      assert.match(out, /\[finished — exit code: 0/);

      const list = await call('shell_list', {});
      assert.match(list.text, /main {2}cwd: \/usr/);
      assert.match(list.text, /bg {2}cwd: \/tmp/);
      assert.equal((await call('shell_close', { session: 'bg' })).text, 'Closed session "bg".');
      assert.equal((await call('shell_read', { session: 'bg' })).isError, true);
    } finally {
      await manager.dispose();
    }
  });

  it('timeout through the tool: interrupted, session survives, result says so', async () => {
    const { manager, call } = await setup();
    try {
      const r = await call('shell_run', { command: 'sleep 100', timeout_s: 1 });
      assert.equal(r.isError, true);
      assert.match(r.text, /timed out after 1s — the command was interrupted; session "main" is still open/);
      assert.match((await call('shell_run', { command: 'echo ok' })).text, /^ok/);
    } finally {
      await manager.dispose();
    }
  });

  it('shell_send answers a prompt of a background command; interrupt_only keeps the session', async () => {
    const { manager, call } = await setup();
    try {
      await call('shell_run', { command: 'IFS= read -r a; echo "got $a"; sleep 100', session: 'p', background: true });
      const sent = await call('shell_send', { session: 'p', input: 'xyz' });
      assert.match(sent.text, /got xyz/);
      assert.match(sent.text, /\[still running\]/);
      assert.match((await call('shell_close', { session: 'p', interrupt_only: true })).text, /Interrupted/);
      await new Promise(r => setTimeout(r, 400));
      const after = await call('shell_read', { session: 'p' });
      assert.match(after.text, /\[finished — exit code: 130/);
      assert.match((await call('shell_run', { command: 'echo still-here', session: 'p' })).text, /still-here/);
    } finally {
      await manager.dispose();
    }
  });

  it('chats do not share sessions', async () => {
    const { client, manager } = await setup();
    try {
      await client.callTool({ name: 'shell_run', arguments: { command: 'export V=one', _conversation_id: 'A' } });
      const r = (await client.callTool({ name: 'shell_run', arguments: { command: 'echo "[$V]"', _conversation_id: 'B' } })) as { content: Array<{ text: string }> };
      assert.match(r.content[0]!.text, /^\[\]/);
    } finally {
      await manager.dispose();
    }
  });
});
