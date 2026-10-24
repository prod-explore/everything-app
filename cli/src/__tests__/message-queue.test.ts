import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations } from '../db.js';
import { listQueue, editQueuedMessage, enqueueMessage, promoteQueuedMessage, takeNextQueued, MAX_QUEUED_MESSAGES } from '../message-queue.js';

const AUTH_TOKEN = 'queue-test-token';
const PNG = 'iVBORw0KGgo=';

function reply(text: string): Llm.Message {
  return {
    id: 'msg_fake', container: null, content: [{ type: 'text', text, citations: null }], model: '@test/model-a', role: 'assistant',
    stop_reason: 'end_turn', stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}

/** A model whose answers are held back until the test lets them through; a stopped turn rejects. */
function gatedClient() {
  const waiting: Array<{ release: () => void; fail: (e: Error) => void }> = [];
  const seen: string[] = [];
  return {
    waiting,
    seen,
    messages: {
      create(params: { messages: Array<{ role: string; content: unknown }> }, options?: { signal?: AbortSignal }) {
        const last = params.messages[params.messages.length - 1]!;
        seen.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
        return new Promise<Llm.Message>((resolve, reject) => {
          const fail = (e: Error) => reject(e);
          waiting.push({ release: () => resolve(reply(`answer ${seen.length}`)), fail });
          options?.signal?.addEventListener('abort', () => fail(new Error('aborted')));
        });
      },
      batches: { create() { throw new Error('unused'); }, retrieve() { throw new Error('unused'); }, results() { throw new Error('unused'); } },
    },
  };
}

function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${AUTH_TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

async function setUp() {
  const db = openDb(':memory:');
  runMigrations(db);
  const llm = gatedClient();
  const built: BuiltApp = await buildApp({ db, connections: [], llm, authToken: AUTH_TOKEN, config: { model: '@test/model-a', autoApproveTools: [] } });
  const server = built.app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const convId = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
  const queue = async () => (await call(port, 'GET', `/api/conversations/${convId}/queue`)).json as { items: Array<{ id: number; text: string; images: number }>; paused: boolean };
  const messages = async () => (await call(port, 'GET', `/api/conversations/${convId}/messages`)).json['messages'] as Array<{ role: string; content: unknown }>;
  return {
    db, port, convId, llm, queue, messages,
    async teardown() {
      for (const w of llm.waiting) w.fail(new Error('teardown'));
      await new Promise(r => setTimeout(r, 30));
      built.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    },
  };
}

describe('message queue (storage)', () => {
  it('keeps order, edits text but keeps images, promotes, and is capped', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO conversations (id) VALUES ('c')`).run();
    const a = enqueueMessage(db, 'c', 'first')!;
    const b = enqueueMessage(db, 'c', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: 'look' }])!;
    assert.deepEqual(listQueue(db, 'c').map(m => m.id), [a.id, b.id]);
    assert.equal(editQueuedMessage(db, 'c', b.id, 'look closer'), 'edited');
    const edited = listQueue(db, 'c')[1]!.content as Array<{ type: string }>;
    assert.deepEqual(edited.map(x => x.type), ['image', 'text']);
    assert.equal(editQueuedMessage(db, 'c', b.id, '  '), 'edited'); // image-only is still a message
    assert.equal(editQueuedMessage(db, 'c', a.id, ''), 'removed');
    assert.equal(editQueuedMessage(db, 'c', 999, 'x'), 'missing');
    const c = enqueueMessage(db, 'c', 'third')!;
    assert.ok(promoteQueuedMessage(db, 'c', c.id));
    assert.equal(takeNextQueued(db, 'c')!.id, c.id);
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) enqueueMessage(db, 'c', `m${i}`);
    assert.equal(enqueueMessage(db, 'c', 'one too many'), null);
    db.close();
  });
});

describe('message queue (server)', () => {
  it('holds a message while a turn runs and sends it by itself afterwards', async () => {
    const t = await setUp();
    try {
      await call(t.port, 'POST', `/api/conversations/${t.convId}/message`, { content: 'one' });
      await until(() => t.llm.waiting.length === 1, 'first call');
      const queued = await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'two' });
      assert.equal(queued.status, 200);
      assert.deepEqual((await t.queue()).items.map(i => i.text), ['two']);
      assert.equal(t.llm.seen.length, 1); // not sent yet

      t.llm.waiting[0]!.release();
      await until(() => t.llm.waiting.length === 2, 'the queued message to start');
      assert.equal(t.llm.seen[1], 'two');
      assert.deepEqual((await t.queue()).items, []);
      t.llm.waiting[1]!.release();
      await until(async () => (await t.messages()).length === 4, 'four messages');
    } finally {
      await t.teardown();
    }
  });

  it('sends a queued message straight away when nothing is running', async () => {
    const t = await setUp();
    try {
      await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'hello' });
      await until(() => t.llm.waiting.length === 1, 'the turn');
      assert.equal(t.llm.seen[0], 'hello');
      assert.deepEqual((await t.queue()).items, []);
    } finally {
      await t.teardown();
    }
  });

  it('carries images and lets the text be edited or the message removed while it waits', async () => {
    const t = await setUp();
    try {
      await call(t.port, 'POST', `/api/conversations/${t.convId}/message`, { content: 'busy' });
      await until(() => t.llm.waiting.length === 1, 'first call');
      const withImage = await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'what is this', attachments: [{ mediaType: 'image/png', data: PNG }] });
      const second = await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'drop me' });
      assert.deepEqual((await t.queue()).items.map(i => [i.text, i.images]), [['what is this', 1], ['drop me', 0]]);

      assert.equal((await call(t.port, 'PATCH', `/api/conversations/${t.convId}/queue/${withImage.json['id']}`, { text: 'what is this picture' })).status, 200);
      assert.equal((await call(t.port, 'DELETE', `/api/conversations/${t.convId}/queue/${second.json['id']}`)).status, 200);
      assert.equal((await call(t.port, 'DELETE', `/api/conversations/${t.convId}/queue/${second.json['id']}`)).status, 404);

      t.llm.waiting[0]!.release();
      await until(() => t.llm.waiting.length === 2, 'queued message to start');
      const sent = JSON.parse(t.llm.seen[1]!) as Array<{ type: string; text?: string }>;
      assert.deepEqual(sent.map(b => b.type), ['image', 'text']);
      assert.equal(sent[1]!.text, 'what is this picture');
    } finally {
      await t.teardown();
    }
  });

  it('send now stops the running turn and goes first', async () => {
    const t = await setUp();
    try {
      await call(t.port, 'POST', `/api/conversations/${t.convId}/message`, { content: 'long job' });
      await until(() => t.llm.waiting.length === 1, 'first call');
      await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'later' });
      const urgent = await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'urgent' });
      assert.equal((await call(t.port, 'POST', `/api/conversations/${t.convId}/queue/${urgent.json['id']}/send-now`)).status, 200);
      await until(() => t.llm.waiting.length === 2, 'the urgent turn');
      assert.equal(t.llm.seen[1], 'urgent');
      assert.deepEqual((await t.queue()).items.map(i => i.text), ['later']);
    } finally {
      await t.teardown();
    }
  });

  it('waits for the person after a failed turn, and send now gets it going', async () => {
    const t = await setUp();
    try {
      await call(t.port, 'POST', `/api/conversations/${t.convId}/message`, { content: 'will fail' });
      await until(() => t.llm.waiting.length === 1, 'first call');
      const q = await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: 'after the failure' });
      t.llm.waiting[0]!.fail(new Error('provider exploded'));
      await until(async () => (await t.queue()).paused, 'the queue to pause');
      await new Promise(r => setTimeout(r, 50));
      assert.equal(t.llm.seen.length, 1);
      assert.deepEqual((await t.queue()).items.map(i => i.text), ['after the failure']);

      await call(t.port, 'POST', `/api/conversations/${t.convId}/queue/${q.json['id']}/send-now`);
      await until(() => t.llm.waiting.length === 2, 'the queued turn');
      assert.equal(t.llm.seen[1], 'after the failure');
    } finally {
      await t.teardown();
    }
  });

  it('answers 404 for an unknown conversation and 400 for an empty message', async () => {
    const t = await setUp();
    try {
      assert.equal((await call(t.port, 'POST', '/api/conversations/nope/queue', { content: 'x' })).status, 404);
      assert.equal((await call(t.port, 'POST', `/api/conversations/${t.convId}/queue`, { content: '  ' })).status, 400);
    } finally {
      await t.teardown();
    }
  });
});
