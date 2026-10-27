import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ownerOf } from '../tools/types.js';
import { formatRunResult } from '../tools/runBash.js';
import { formatCheckpoints } from '../tools/checkpoints.js';
import { ALLOWED_SUBCOMMANDS, registerGitOp } from '../tools/gitOp.js';
import { SupervisorClient } from '../supervisor-client.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('git_op subcommand whitelist invariants', () => {
  const allowed = new Set<string>(ALLOWED_SUBCOMMANDS);

  it('never offers subcommands that delete files or push', () => {
    // Pushing needs a credential and a human approval, so it goes through git-proxy, never through this tool.
    for (const sub of ['rm', 'clean', 'push', 'reset', 'filter-branch', 'gc', 'config']) assert.equal(allowed.has(sub), false, sub);
  });

  it('offers the everyday subcommands', () => {
    for (const sub of ['status', 'diff', 'log', 'add', 'commit']) assert.equal(allowed.has(sub), true, sub);
  });

  it('the registered tool schema enforces exactly that list', () => {
    let schema: Record<string, { safeParse(v: unknown): { success: boolean } }> | undefined;
    const server = { registerTool: (_name: string, config: { inputSchema: typeof schema }) => { schema = config.inputSchema; } };
    registerGitOp(server as unknown as Parameters<typeof registerGitOp>[0], {} as Parameters<typeof registerGitOp>[1]);
    assert.ok(schema);
    for (const sub of ALLOWED_SUBCOMMANDS) assert.equal(schema['subcommand']!.safeParse(sub).success, true, sub);
    for (const sub of ['push', 'rm', 'clean', 'status; rm -rf /']) assert.equal(schema['subcommand']!.safeParse(sub).success, false, sub);
  });
});

describe('sandbox owner', () => {
  it('a chat in a project uses the project sandbox; a standalone chat uses its own', () => {
    assert.equal(ownerOf({ _conversation_id: 'c1', _project_id: 'p1' }), 'p1');
    assert.equal(ownerOf({ _conversation_id: 'c1' }), 'c1');
    assert.equal(ownerOf({}), 'default');
  });
});

describe('run_bash result formatting', () => {
  const base = { terminal: 'main', output: 'hi\n', exitCode: 0, timedOut: false, truncated: false, terminalClosed: false };

  it('success: output plus exit code, not an error', () => {
    assert.deepEqual(formatRunResult(base, 1000), { text: 'hi\nexit code: 0', isError: false });
  });

  it('says where the terminal is when it is not at the workspace root', () => {
    assert.equal(formatRunResult({ ...base, cwd: '/workspace/app' }, 1000).text, 'hi\nexit code: 0\n[cwd: /workspace/app]');
    assert.equal(formatRunResult({ ...base, cwd: '/workspace' }, 1000).text, 'hi\nexit code: 0');
  });

  it('passes on the disk quota notice without turning it into an error', () => {
    const r = formatRunResult({ ...base, notice: 'The workspace is 95 MB of its 100 MB quota.' }, 1000);
    assert.equal(r.isError, false);
    assert.equal(r.text, 'hi\nexit code: 0\n[The workspace is 95 MB of its 100 MB quota.]');
  });

  it('non-zero exit is an error', () => {
    const r = formatRunResult({ ...base, exitCode: 2 }, 1000);
    assert.equal(r.isError, true);
    assert.match(r.text, /exit code: 2/);
  });

  it('timeout explains that the terminal was killed and suggests background jobs', () => {
    const r = formatRunResult({ ...base, exitCode: null, timedOut: true, terminalClosed: true }, 5000);
    assert.equal(r.isError, true);
    assert.match(r.text, /timed out after 5000ms/);
    assert.match(r.text, /nohup/);
    assert.doesNotMatch(r.text, /exit code/);
  });

  it('a shell that exited reports it', () => {
    const r = formatRunResult({ ...base, exitCode: null, terminalClosed: true }, 1000);
    assert.equal(r.isError, true);
    assert.match(r.text, /shell exited/);
  });
});

describe('checkpoint tools', () => {
  it('formats the checkpoint list', () => {
    assert.match(formatCheckpoints([]), /No checkpoints yet/);
    const text = formatCheckpoints([
      { id: 'abc-1234', label: 'Before turn 2', commit: 'f'.repeat(40), createdAt: '2026-10-05T10:00:00.000Z' },
      { id: 'abb-5678', label: '', commit: 'e'.repeat(40), createdAt: '2026-10-05T09:00:00.000Z' },
    ]);
    assert.equal(text.split('\n').length, 2);
    assert.match(text, /^abc-1234 {2}2026-10-05T10:00:00.000Z {2}Before turn 2/);
    assert.match(text, /\(no label\)/);
  });

  it('SupervisorClient reads the sandbox status from the authenticated /status, not the open /health', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', maxRunning: 2, running: 1, warnings: [], sandboxes: [] }));
    }).listen(0);
    try {
      const client = new SupervisorClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'tok');
      assert.equal((await client.status()).running, 1);
      assert.deepEqual(seen, ['GET /status Bearer tok']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('SupervisorClient calls the per-owner checkpoint endpoints', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        res.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/checkpoints')) res.end(JSON.stringify({ checkpoints: [{ id: 'a-1234', label: 'x', commit: 'c', createdAt: 't' }] }));
        else res.end(JSON.stringify({ ok: true, checkpointId: 'a-1234', commit: 'c' }));
      });
    }).listen(0);
    try {
      const client = new SupervisorClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      assert.equal((await client.listCheckpoints('proj-1'))[0]!.id, 'a-1234');
      assert.equal((await client.rollback('proj-1', 'a-1234')).ok, true);
      assert.deepEqual(seen, ['GET /sandboxes/proj-1/checkpoints ', 'POST /sandboxes/proj-1/rollback {"checkpointId":"a-1234"}']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
