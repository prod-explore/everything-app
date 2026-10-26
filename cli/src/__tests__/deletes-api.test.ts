import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addPin, appendMessage, createApprovalGrant, createArtifact, listApprovalGrants, listPins, openDb, runMigrations } from '../db.js';
import { createRun } from '../runs.js';
import { ProviderRouter } from '../providers/router.js';
import type { SandboxInventory, SandboxLifecycle } from '../supervisor-client.js';

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
  let failing = false;
  const lifecycle: SandboxLifecycle = {
    async inventory(owner) {
      if (failing) throw new Error('supervisor down');
      return sandboxes.get(owner) ?? { containers: 0, running: false, workspace: null, processes: [] };
    },
    async destroy(owner) {
      if (failing) throw new Error('supervisor down');
      destroyed.push(owner);
      const had = sandboxes.get(owner);
      sandboxes.delete(owner);
      return { containersRemoved: had?.containers ?? 0, volumeRemoved: had?.workspace != null };
    },
  };
  return { lifecycle, sandboxes, destroyed, fail: (on: boolean) => { failing = on; } };
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

  /** A project with a chat that has history, a report snapshot on disk, a grant, a pin and a stale agent run. */
  async function seedProject(name: string) {
    const projectId = (await req(port, 'POST', '/api/projects', { name })).json.id as string;
    const convId = (await req(port, 'POST', '/api/conversations', { title: `${name} chat`, projectId })).json.id as string;
    appendMessage(db, convId, 'user', 'hello');
    const snapshot = createArtifact(db, { conversationId: convId, filename: 'report.md', mimeType: 'text/markdown', sizeBytes: 5, source: 'report-pin' });
    const file = path.join(artifactsDir, `${snapshot.id}_report.md`);
    fs.writeFileSync(file, 'hello');
    createApprovalGrant(db, { toolLabel: 'cmd:npm test', scope: 'project', subjectType: null, subjectId: null, conversationId: null, projectId, expiresAt: null });
    createApprovalGrant(db, { toolLabel: 'cmd:ls', scope: 'chat', subjectType: null, subjectId: null, conversationId: convId, projectId: null, expiresAt: null });
    addPin(db, projectId, '/workspace/a.ts');
    const run = createRun(db, { projectId, conversationId: convId, model: 'm', goal: 'g', label: 'worker', depth: 1 });
    sandbox.sandboxes.set(projectId, {
      containers: 1,
      running: true,
      workspace: { entries: [{ name: 'node_modules', type: 'directory', bytes: 9000 }, { name: 'index.ts', type: 'file', bytes: 120 }], totalBytes: 9120 },
      processes: [{ pid: 40, command: 'node server.js' }],
    });
    // A chat moved in from outside keeps its own sandbox; it goes with the project too.
    sandbox.sandboxes.set(convId, { containers: 1, running: false, workspace: { entries: [{ name: 'notes.md', type: 'file', bytes: 10 }], totalBytes: 10 }, processes: [] });
    return { projectId, convId, file, runId: run.id };
  }

  it('the deletion preview lists exactly what will be removed', async () => {
    const { projectId, convId, runId } = await seedProject('Preview');
    const r = await req(port, 'GET', `/api/projects/${projectId}/deletion-preview`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      project: { id: projectId, name: 'Preview' },
      conversations: [{ id: convId, title: 'Preview chat', messageCount: 1 }],
      agentTranscripts: 0,
      running: [{ runId, kind: 'agent', label: 'worker' }],
      sandboxes: [
        { owner: projectId, ...sandbox.sandboxes.get(projectId) },
        { owner: convId, conversationTitle: 'Preview chat', ...sandbox.sandboxes.get(convId) },
      ],
      snapshots: 1,
    });
    assert.deepEqual(sandbox.destroyed, [], 'a preview removes nothing');
    assert.equal((await req(port, 'GET', '/api/projects/nope/deletion-preview')).status, 404);
  });

  it('deleting a project removes its sandboxes, chats, runs, grants, pins and snapshot files; there is no keep option', async () => {
    const { projectId, convId, file, runId } = await seedProject('Gone');
    sandbox.destroyed.length = 0;
    assert.equal((await req(port, 'DELETE', `/api/projects/${projectId}?conversations=keep`)).status, 200);
    assert.deepEqual(sandbox.destroyed, [projectId, convId]);
    assert.equal((await req(port, 'GET', `/api/conversations/${convId}`)).status, 404);
    assert.equal((await req(port, 'GET', `/api/projects/${projectId}`)).status, 404);
    assert.equal(db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId), undefined);
    assert.deepEqual(listApprovalGrants(db).filter(g => g.projectId === projectId || g.conversationId === convId), []);
    assert.deepEqual(listPins(db, projectId), []);
    assert.equal(fs.existsSync(file), false, 'the snapshot file is gone');
  });

  it('keeps the project intact when its sandbox cannot be removed', async () => {
    const { projectId, convId, file } = await seedProject('Kept');
    sandbox.fail(true);
    try {
      const r = await req(port, 'DELETE', `/api/projects/${projectId}`);
      assert.equal(r.status, 502);
      assert.match(r.json.error, /not deleted.*supervisor down/);
      assert.equal((await req(port, 'GET', `/api/projects/${projectId}/deletion-preview`)).status, 502);
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
