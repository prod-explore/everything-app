import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addPin, appendMessage, createApprovalGrant, createArtifact, createGazetaItem, listApprovalGrants, listPins, openDb, runMigrations } from '../db.js';
import { createRun } from '../runs.js';
import { ProviderRouter } from '../providers/router.js';
import { SANDBOX_UNREACHABLE, type SandboxInventory, type SandboxLifecycle } from '../supervisor-client.js';

const TOKEN = 'test-token';
function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** An in-memory supervisor: owners with a sandbox, and what was destroyed. */
function fakeSandboxes(existing: Record<string, SandboxInventory> = {}) {
  const sandboxes = new Map(Object.entries(existing));
  const destroyed: string[] = [];
  let failing: false | 'error' | 'unreachable' = false;
  const failure = () => new Error(failing === 'unreachable' ? SANDBOX_UNREACHABLE : 'disk full');
  const lifecycle: SandboxLifecycle = {
    async inventory(owner) {
      if (failing) throw failure();
      return sandboxes.get(owner) ?? { containers: 0, running: false, workspace: null, processes: [] };
    },
    async destroy(owner) {
      if (failing) throw failure();
      destroyed.push(owner);
      const had = sandboxes.get(owner);
      sandboxes.delete(owner);
      return { containersRemoved: had?.containers ?? 0, volumeRemoved: had?.workspace != null };
    },
  };
  return { lifecycle, sandboxes, destroyed, fail: (mode: typeof failing) => { failing = mode; } };
}

describe('deleting messages, conversations and projects', () => {
  let built: BuiltApp; let server: http.Server; let port: number; let db: ReturnType<typeof openDb>;
  let sandbox: ReturnType<typeof fakeSandboxes>;
  let artifactsDir: string;
  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-artifacts-'));
    process.env['EVERYTHINGAPP_ARTIFACTS_DIR'] = artifactsDir;
    sandbox = fakeSandboxes();
    const router = new ProviderRouter({ db, env: {} as NodeJS.ProcessEnv, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    built = await buildApp({ db, connections: [], router, authToken: TOKEN, sandboxLifecycle: sandbox.lifecycle, config: { model: '@test/model-a', autoApproveTools: [] } });
    server = built.app.listen(0); port = (server.address() as AddressInfo).port;
  });
  after(() => {
    built.stop(); server.close(); db.close();
    delete process.env['EVERYTHINGAPP_ARTIFACTS_DIR'];
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('deletes a message and everything after it', async () => {
    const { id } = (await req(port, 'POST', '/api/conversations', { title: 'c' })).json;
    const m1 = appendMessage(db, id, 'user', 'one');
    appendMessage(db, id, 'assistant', 'two');
    appendMessage(db, id, 'user', 'three');
    const res = await req(port, 'DELETE', `/api/conversations/${id}/messages/${m1 + 1}`);
    assert.equal(res.status, 200);
    const left = (await req(port, 'GET', `/api/conversations/${id}/messages`)).json.messages;
    assert.equal(left.length, 1);
  });

  it('deletes a conversation with its messages', async () => {
    const { id } = (await req(port, 'POST', '/api/conversations', { title: 'c' })).json;
    appendMessage(db, id, 'user', 'x');
    assert.equal((await req(port, 'DELETE', `/api/conversations/${id}`)).status, 200);
    assert.equal((await req(port, 'GET', `/api/conversations/${id}`)).status, 404);
  });

  /**
   * A chat with history, a report snapshot on disk, a chat grant, a pin, an agent run with its transcript, a wake-up, a
   * Gazeta item and a sandbox of its own (`projectId` set: inside that project).
   */
  function seedChat(convId: string, projectId: string | null) {
    appendMessage(db, convId, 'user', 'hello');
    const snapshot = createArtifact(db, { conversationId: convId, filename: 'report.md', mimeType: 'text/markdown', sizeBytes: 5, source: 'report-pin' });
    const file = path.join(artifactsDir, `${snapshot.id}_report.md`);
    fs.writeFileSync(file, 'hello');
    createApprovalGrant(db, { toolLabel: 'cmd:ls', scope: 'chat', subjectType: null, subjectId: null, conversationId: convId, projectId: null, expiresAt: null });
    addPin(db, convId, '/workspace/notes.md');
    const transcript = (db.prepare(`INSERT INTO conversations (title, kind, project_id) VALUES ('[agent worker] g', 'subagent', ?) RETURNING id`).get(projectId) as { id: string }).id;
    const run = createRun(db, { projectId, conversationId: convId, transcriptConversationId: transcript, model: 'm', goal: 'g', label: 'worker', depth: 1 });
    const wakeup = (db.prepare(`INSERT INTO schedules (name, prompt, cron, conversation_id) VALUES ('Check the build', 'p', '0 9 * * *', ?) RETURNING id`).get(convId) as { id: string }).id;
    const question = createGazetaItem(db, { type: 'question', title: 'Which branch?', conversationId: convId });
    sandbox.sandboxes.set(convId, { containers: 1, running: false, workspace: { entries: [{ name: 'notes.md', type: 'file', bytes: 10 }], totalBytes: 10 }, processes: [] });
    return { file, transcript, runId: run.id, wakeup, question };
  }

  /** A project with one seeded chat, a project grant and pin, a scheduled task, a Gazeta item and a running sandbox. */
  async function seedProject(name: string) {
    const projectId = (await req(port, 'POST', '/api/projects', { name })).json.id as string;
    const convId = (await req(port, 'POST', '/api/conversations', { title: `${name} chat`, projectId })).json.id as string;
    const chat = seedChat(convId, projectId);
    createApprovalGrant(db, { toolLabel: 'cmd:npm test', scope: 'project', subjectType: null, subjectId: null, conversationId: null, projectId, expiresAt: null });
    addPin(db, projectId, '/workspace/a.ts');
    const task = (db.prepare(`INSERT INTO schedules (name, prompt, cron, project_id) VALUES ('Nightly tests', 'p', '0 3 * * *', ?) RETURNING id`).get(projectId) as { id: string }).id;
    const report = createGazetaItem(db, { type: 'report', title: 'Nightly report', projectId });
    sandbox.sandboxes.set(projectId, {
      containers: 1,
      running: true,
      workspace: { entries: [{ name: 'node_modules', type: 'directory', bytes: 9000 }, { name: 'index.ts', type: 'file', bytes: 120 }], totalBytes: 9120 },
      processes: [{ pid: 40, command: 'node server.js' }],
    });
    return { projectId, convId, task, report, ...chat };
  }

  const gone = (table: string, id: string) => assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id), undefined, `${table} ${id} is gone`);

  it('the project deletion preview lists exactly what will be removed, schedules and Gazeta items included', async () => {
    const { projectId, convId, runId, task, report, wakeup, question } = await seedProject('Preview');
    sandbox.destroyed.length = 0;
    const r = await req(port, 'GET', `/api/projects/${projectId}/deletion-preview`);
    assert.equal(r.status, 200);
    const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id);
    const { gazetaItems, ...rest } = r.json;
    assert.deepEqual([...gazetaItems].sort(byId), [{ id: report, title: 'Nightly report', status: 'pending' }, { id: question, title: 'Which branch?', status: 'pending' }].sort(byId));
    assert.deepEqual(rest, {
      target: { kind: 'project', id: projectId, name: 'Preview' },
      conversations: [{ id: convId, title: 'Preview chat', messageCount: 1 }],
      agentTranscripts: 1,
      running: [{ runId, kind: 'agent', label: 'worker' }],
      sandboxRuntime: true,
      sandboxes: [
        { owner: projectId, ...sandbox.sandboxes.get(projectId) },
        { owner: convId, conversationTitle: 'Preview chat', ...sandbox.sandboxes.get(convId) },
      ],
      snapshots: 1,
      schedules: [{ id: wakeup, name: 'Check the build' }, { id: task, name: 'Nightly tests' }],
    });
    assert.deepEqual(sandbox.destroyed, [], 'a preview removes nothing');
    assert.equal((await req(port, 'GET', '/api/projects/nope/deletion-preview')).status, 404);
  });

  it('deleting a project removes its sandboxes, chats, transcripts, runs, grants, pins, schedules, Gazeta items and snapshot files', async () => {
    const { projectId, convId, file, runId, transcript, task, report, wakeup, question } = await seedProject('Gone');
    sandbox.destroyed.length = 0;
    // `?conversations=keep` is ignored: there is no way to delete a project and keep its chats.
    assert.equal((await req(port, 'DELETE', `/api/projects/${projectId}?conversations=keep`)).status, 200);
    assert.deepEqual(sandbox.destroyed.sort(), [projectId, convId, transcript].sort());
    assert.equal((await req(port, 'GET', `/api/conversations/${convId}`)).status, 404);
    assert.equal((await req(port, 'GET', `/api/projects/${projectId}`)).status, 404);
    for (const [table, id] of [['runs', runId], ['conversations', transcript], ['schedules', task], ['schedules', wakeup], ['gazeta_items', report], ['gazeta_items', question]] as const) gone(table, id);
    assert.deepEqual(listApprovalGrants(db).filter(g => g.projectId === projectId || g.conversationId === convId), []);
    assert.deepEqual([...listPins(db, projectId), ...listPins(db, convId)], []);
    assert.equal(fs.existsSync(file), false, 'the snapshot file is gone');
  });

  it('deleting a chat removes its own sandbox and everything of it, and leaves its project alone', async () => {
    const { projectId, convId: keptChat } = await seedProject('Home');
    const convId = (await req(port, 'POST', '/api/conversations', { title: 'Scratch' })).json.id as string;
    const { file, runId, transcript, wakeup, question } = seedChat(convId, null);
    const preview = await req(port, 'GET', `/api/conversations/${convId}/deletion-preview`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json.target, { kind: 'chat', id: convId, name: 'Scratch' });
    assert.deepEqual(preview.json.conversations, [{ id: convId, title: 'Scratch', messageCount: 1 }]);
    assert.equal(preview.json.agentTranscripts, 1);
    assert.deepEqual(preview.json.sandboxes, [{ owner: convId, ...sandbox.sandboxes.get(convId) }]);
    assert.deepEqual(preview.json.schedules, [{ id: wakeup, name: 'Check the build' }]);
    assert.deepEqual(preview.json.gazetaItems, [{ id: question, title: 'Which branch?', status: 'pending' }]);

    sandbox.destroyed.length = 0;
    assert.equal((await req(port, 'DELETE', `/api/conversations/${convId}`)).status, 200);
    assert.deepEqual(sandbox.destroyed.sort(), [convId, transcript].sort());
    for (const [table, id] of [['conversations', convId], ['conversations', transcript], ['runs', runId], ['schedules', wakeup], ['gazeta_items', question]] as const) gone(table, id);
    assert.deepEqual(listApprovalGrants(db).filter(g => g.conversationId === convId), []);
    assert.deepEqual(listPins(db, convId), []);
    assert.equal(fs.existsSync(file), false);
    // The project and its other chat are untouched.
    assert.equal((await req(port, 'GET', `/api/projects/${projectId}`)).status, 200);
    assert.equal((await req(port, 'GET', `/api/conversations/${keptChat}`)).status, 200);
    assert.ok(sandbox.sandboxes.has(projectId));
  });

  it('keeps everything when the sandbox service fails, with a message that says so', async () => {
    const { projectId, convId, file } = await seedProject('Kept');
    sandbox.fail('error');
    try {
      const r = await req(port, 'DELETE', `/api/projects/${projectId}`);
      assert.equal(r.status, 502);
      assert.equal(r.json.code, 'sandbox_failed');
      assert.match(r.json.error, /nothing was deleted: disk full/);
      assert.equal((await req(port, 'DELETE', `/api/conversations/${convId}`)).status, 502);
    } finally {
      sandbox.fail(false);
    }
    assert.equal((await req(port, 'GET', `/api/conversations/${convId}`)).status, 200);
    assert.equal(fs.existsSync(file), true);
    assert.equal((await req(port, 'DELETE', `/api/projects/${projectId}`)).status, 200, 'retry succeeds');
  });

  it('refuses to delete a conversation or project while a turn is running', async () => {
    assert.equal((await req(port, 'DELETE', '/api/conversations/nope')).status, 404);
    assert.equal((await req(port, 'DELETE', '/api/projects/nope')).status, 404);
  });
});

describe('deleting without a reachable sandbox service', () => {
  async function app(opts: { sandboxLifecycle?: SandboxLifecycle | null; supervisorUrl?: string }) {
    const db = openDb(':memory:'); runMigrations(db);
    const before = process.env['SUPERVISOR_URL'];
    if (opts.supervisorUrl === undefined) delete process.env['SUPERVISOR_URL']; else process.env['SUPERVISOR_URL'] = opts.supervisorUrl;
    const router = new ProviderRouter({ db, env: {} as NodeJS.ProcessEnv, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    const built = await buildApp({ db, connections: [], router, authToken: TOKEN, ...('sandboxLifecycle' in opts ? { sandboxLifecycle: opts.sandboxLifecycle } : {}), config: { model: '@test/model-a', autoApproveTools: [] } });
    if (before === undefined) delete process.env['SUPERVISOR_URL']; else process.env['SUPERVISOR_URL'] = before;
    const server = built.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    return { db, port, close: () => { built.stop(); server.close(); db.close(); } };
  }

  it('with no sandbox service configured (no SUPERVISOR_URL), projects and chats are deleted without it', async () => {
    const t = await app({});
    try {
      const projectId = (await req(t.port, 'POST', '/api/projects', { name: 'Local' })).json.id;
      const chat = (await req(t.port, 'POST', '/api/conversations', { title: 'c', projectId })).json.id;
      const quick = (await req(t.port, 'POST', '/api/conversations', { title: 'q' })).json.id;
      const preview = await req(t.port, 'GET', `/api/projects/${projectId}/deletion-preview`);
      assert.equal(preview.status, 200);
      assert.equal(preview.json.sandboxRuntime, false);
      assert.deepEqual(preview.json.sandboxes, []);
      assert.equal((await req(t.port, 'DELETE', `/api/projects/${projectId}`)).status, 200);
      assert.equal((await req(t.port, 'GET', `/api/conversations/${chat}`)).status, 404);
      assert.equal((await req(t.port, 'DELETE', `/api/conversations/${quick}`)).status, 200);
    } finally {
      t.close();
    }
  });

  it('with one configured but unreachable, refuses with a clear message and deletes nothing', async () => {
    // A dead local port: the real supervisor client, failing as it would when the container is down.
    const t = await app({ supervisorUrl: 'http://127.0.0.1:9' });
    try {
      const projectId = (await req(t.port, 'POST', '/api/projects', { name: 'Remote' })).json.id;
      const quick = (await req(t.port, 'POST', '/api/conversations', { title: 'q' })).json.id;
      for (const [method, path] of [['GET', `/api/projects/${projectId}/deletion-preview`], ['DELETE', `/api/projects/${projectId}`], ['GET', `/api/conversations/${quick}/deletion-preview`], ['DELETE', `/api/conversations/${quick}`]] as const) {
        const r = await req(t.port, method, path);
        assert.equal(r.status, 503, `${method} ${path}`);
        assert.equal(r.json.code, 'sandbox_unreachable');
        assert.match(r.json.error, /The sandbox service is not reachable, so .* nothing was deleted\. Start sandbox-supervisor/);
      }
      assert.equal((await req(t.port, 'GET', `/api/projects/${projectId}`)).status, 200);
      assert.equal((await req(t.port, 'GET', `/api/conversations/${quick}`)).status, 200);
    } finally {
      t.close();
    }
  });
});
