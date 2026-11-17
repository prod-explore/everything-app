import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp } from '../server.js';
import { appendMessage, getAllMessagesFull, getMessagesTimed, openDb, runMigrations, selectVersion } from '../db.js';
import { EmptyAnswerError, FirstByteTimeoutError, runTurn, sanitizeHistory, type LlmClient, type MessageStreamLike, type TurnMessage } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import { joinReply, CONTINUE_PROMPT } from '../continue-reply.js';
import { LiveTurn } from '../live-turn.js';
import { classifyTurnError, firstByteTimeoutMs } from '../turn-errors.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const AUTH_TOKEN = 'chat-ux-test-token';

function reply(content: Llm.ContentBlock[], stop: Llm.StopReason = 'end_turn'): Llm.Message {
  return {
    id: 'm', container: null, content, model: '@test/model-a', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}
const text = (t: string): Llm.ContentBlock => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;
const thinking = (t: string): Llm.ContentBlock => ({ type: 'thinking', thinking: t }) as unknown as Llm.ContentBlock;

/** What a streamed request does: send these deltas, then finish with a message, fail, or stay silent until aborted. */
type StreamScript = { deltas?: Array<{ text?: string; thinking?: string; wait?: number }>; end: 'reply'; message: Llm.Message } | { deltas?: Array<{ text?: string; thinking?: string; wait?: number }>; end: 'fail'; error: Error } | { deltas?: []; end: 'hang' } | { deltas: Array<{ text?: string; thinking?: string; wait?: number }>; end: 'until-abort' };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function streamingClient(scripts: StreamScript[]): LlmClient & { requests: Llm.MessageCreateParamsNonStreaming[] } {
  let i = 0;
  const requests: Llm.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    messages: {
      async create() { throw new Error('streaming only'); },
      stream(params, options): MessageStreamLike {
        requests.push(JSON.parse(JSON.stringify(params)) as Llm.MessageCreateParamsNonStreaming);
        const script = scripts[Math.min(i++, scripts.length - 1)]!;
        const listeners: Array<(e: Llm.MessageStreamEvent) => void> = [];
        const final = (async () => {
          await Promise.resolve();
          for (const d of script.deltas ?? []) {
            if (d.wait) await sleep(d.wait);
            for (const l of listeners) {
              l({ type: 'content_block_delta', index: 0, delta: d.thinking !== undefined ? { type: 'thinking_delta', thinking: d.thinking } : { type: 'text_delta', text: d.text ?? '' } } as Llm.MessageStreamEvent);
            }
          }
          if (script.end === 'reply') return script.message;
          if (script.end === 'fail') throw script.error;
          await new Promise<never>((_, reject) => {
            const abort = () => reject(new Error('The operation was aborted'));
            if (options?.signal?.aborted) abort();
            options?.signal?.addEventListener('abort', abort, { once: true });
          });
          throw new Error('unreachable');
        })();
        return { on(_e, l) { listeners.push(l); return this; }, finalMessage: () => final };
      },
    },
  } as LlmClient & { requests: Llm.MessageCreateParamsNonStreaming[] };
}

const emptyTools = () => new ToolRegistry([]);
const noop = async () => true;

// ─── a reply cut short is kept ─────────────────────────────────────────────────

describe('runTurn: a reply cut short', () => {
  it('stores what was streamed, marked as stopped, when the turn is aborted', async () => {
    const controller = new AbortController();
    const batches: TurnMessage[][] = [];
    const llm = streamingClient([{ deltas: [{ text: 'Hello ' }, { text: 'wor' }], end: 'until-abort' }]);
    const run = runTurn(
      { llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, signal: controller.signal, onTextDelta: () => {}, onMessages: b => batches.push(b) },
      [],
      'hi',
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(run);
    const stored = batches.flat();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.role, 'assistant');
    assert.deepEqual(stored[0]!.content, [{ type: 'text', text: 'Hello wor' }]);
    assert.equal(stored[0]!.incomplete?.reason, 'stopped');
  });

  it('stores it as an error, with the failure, when the provider breaks mid-answer; reasoning comes first', async () => {
    const batches: TurnMessage[][] = [];
    const boom = new Error('response stream went silent');
    const llm = streamingClient([{ deltas: [{ thinking: 'hmm' }, { text: 'Partial answer' }], end: 'fail', error: boom }]);
    await assert.rejects(
      runTurn({ llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, onTextDelta: () => {}, onMessages: b => batches.push(b) }, [], 'hi'),
      /went silent/,
    );
    const stored = batches.flat();
    assert.equal(stored.length, 1);
    // How long the model thought is measured (0 ms in a test), so only the words are compared.
    assert.deepEqual(
      (stored[0]!.content as unknown as Array<Record<string, unknown>>).map(({ durationMs: _ms, ...rest }) => rest),
      [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Partial answer' }],
    );
    assert.deepEqual(stored[0]!.incomplete, { reason: 'error', error: boom });
  });

  it('keeps the finished steps and never leaves a tool call open', async () => {
    const batches: TurnMessage[][] = [];
    const registry = new ToolRegistry(['x__t']);
    await registry.loadFrom([{ name: 'x', async listTools() { return [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]; }, async callTool() { return { text: 'ok', isError: false }; } }]);
    const llm = streamingClient([
      { end: 'reply', message: reply([{ type: 'tool_use', id: 'c1', name: 'x__t', input: {} } as unknown as Llm.ContentBlock], 'tool_use') },
      { deltas: [{ text: 'Based on that' }], end: 'fail', error: new Error('boom') },
    ]);
    await assert.rejects(runTurn({ llm, model: 'm', tools: registry, systemPrompt: 's', confirm: noop, onTextDelta: () => {}, onMessages: b => batches.push(b) }, [], 'go'));
    const stored = batches.flat();
    assert.deepEqual(stored.map(m => m.role), ['assistant', 'user', 'assistant']);
    assert.ok(stored[1]!.content instanceof Array && (stored[1]!.content as Llm.ContentBlockParam[]).some(b => b.type === 'tool_result'));
    assert.equal(stored[2]!.incomplete?.reason, 'error');
    assert.equal((stored[2]!.content as Llm.ContentBlockParam[]).some(b => b.type === 'tool_use'), false);
  });

  it('stores nothing when nothing had been streamed', async () => {
    const batches: TurnMessage[][] = [];
    const llm = streamingClient([{ end: 'fail', error: new Error('no connection') }]);
    await assert.rejects(runTurn({ llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, onTextDelta: () => {}, onMessages: b => batches.push(b) }, [], 'hi'));
    assert.equal(batches.flat().length, 0);
  });
});

describe('sanitizeHistory and the next request after a cut-off reply', () => {
  it('sends the partial text as an ordinary assistant message (the marker never reaches the model)', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }], incomplete: { reason: 'stopped' } } as Llm.MessageParam,
    ]);
    assert.deepEqual(out[1], { role: 'assistant', content: [{ type: 'text', text: 'partial' }] });
  });

  it('drops a reply that only reasoned and keeps the roles alternating', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      { role: 'user', content: 'again' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.role, 'user');
    assert.match(JSON.stringify(out[0]!.content), /again/);
    assert.match(JSON.stringify(out[0]!.content), /"q"|q/);
  });
});

// ─── empty answers and the first-byte guard ───────────────────────────────────────

describe('runTurn: empty answer', () => {
  it('fails with EmptyAnswerError when the model says nothing and calls nothing', async () => {
    const llm: LlmClient = { messages: { async create() { return reply([]); } } };
    await assert.rejects(runTurn({ llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop }, [], 'hi'), EmptyAnswerError);
  });
  it('also when it only reasoned', async () => {
    const llm: LlmClient = { messages: { async create() { return reply([thinking('hmm')]); } } };
    await assert.rejects(runTurn({ llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop }, [], 'hi'), EmptyAnswerError);
  });
  it('is classified for the UI', () => {
    const i = classifyTurnError(new EmptyAnswerError());
    assert.equal(i.kind, 'empty_answer');
    assert.match(i.message, /empty answer/);
    assert.equal(i.transient, true);
  });
});

describe('runTurn: first-byte guard', () => {
  it('fails the attempt when a streamed request stays silent', async () => {
    const llm = streamingClient([{ end: 'hang' }]);
    const started = Date.now();
    await assert.rejects(
      runTurn({ llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, onTextDelta: () => {}, firstByteTimeoutMs: 60 }, [], 'hi'),
      (err: unknown) => err instanceof FirstByteTimeoutError && err.ms === 60,
    );
    assert.ok(Date.now() - started < 1000);
  });

  it('stops watching at the first token', async () => {
    const llm = streamingClient([{ deltas: [{ text: 'a' }, { text: 'b', wait: 120 }], end: 'reply', message: reply([text('ab')]) }]);
    const out = await runTurn({ llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, onTextDelta: () => {}, firstByteTimeoutMs: 50 }, [], 'hi');
    assert.equal(out.length, 2);
  });

  it('does not count the time the adapter is backing off before a retry', async () => {
    const wait = { until: Date.now() + 150 };
    const llm = streamingClient([{ deltas: [{ text: 'late', wait: 120 }], end: 'reply', message: reply([text('late')]) }]);
    const out = await runTurn(
      { llm, model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, onTextDelta: () => {}, firstByteTimeoutMs: 50, waitingUntil: () => wait.until },
      [],
      'hi',
    );
    assert.equal(out.length, 2);
  });

  it('is off when the limit is 0 and reads FIRST_BYTE_TIMEOUT_S', () => {
    assert.equal(firstByteTimeoutMs({}), 90_000);
    assert.equal(firstByteTimeoutMs({ FIRST_BYTE_TIMEOUT_S: '30' }), 30_000);
    assert.equal(firstByteTimeoutMs({ FIRST_BYTE_TIMEOUT_S: '0' }), 0);
    assert.equal(firstByteTimeoutMs({ FIRST_BYTE_TIMEOUT_S: 'soon' }), 90_000);
    assert.match(classifyTurnError(new FirstByteTimeoutError(90_000)).message, /within 90 s/);
  });
});

// ─── pieces ─────────────────────────────────────────────────────────────────────

describe('joinReply', () => {
  it('runs the last text of the first part into the first text of the second', () => {
    assert.deepEqual(
      joinReply([{ type: 'text', text: 'Hello wo' }], [{ type: 'text', text: 'rld' }, { type: 'tool_use', id: 'a', name: 'n', input: {} }]),
      [{ type: 'text', text: 'Hello world' }, { type: 'tool_use', id: 'a', name: 'n', input: {} }],
    );
  });
  it('gathers the reasoning in front', () => {
    assert.deepEqual(
      joinReply([{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'x' }], [{ type: 'thinking', thinking: 'b' }, { type: 'text', text: 'y' }]),
      [{ type: 'thinking', thinking: 'a\n\nb' }, { type: 'text', text: 'xy' }],
    );
  });
});

describe('LiveTurn', () => {
  it('mirrors what the client assembles from the events, with the clocks of the server', () => {
    let now = 1000;
    const live = new LiveTurn(3, 41, false, () => now);
    live.thinkingDelta('think');
    now = 2500;
    live.textDelta(0, 'He');
    live.textDelta(0, 'llo');
    now = 4000;
    live.toolUse('Run');
    live.toolResult('run_bash', 'out', false, false);
    now = 9000;
    const snap = live.snapshot();
    assert.deepEqual(snap.parts.map(p => p.type), ['reasoning', 'text', 'tool']);
    assert.equal((snap.parts[0] as { endedAt?: number }).endedAt, 2500);
    assert.equal((snap.parts[1] as { text: string }).text, 'Hello');
    assert.equal(snap.elapsedMs, 8000);
    assert.equal(snap.idleMs, 5000);
    live.text('Hello!');
    assert.deepEqual(live.snapshot().parts[1], { type: 'text', text: 'Hello!' });
  });
});

// ─── stored versions ─────────────────────────────────────────────────────────────

describe('versions of a message', () => {
  function seed() {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO conversations (id) VALUES ('c')`).run();
    return db;
  }

  it('lists every version on the visible message and switches the whole branch', () => {
    const db = seed();
    const u1 = appendMessage(db, 'c', 'user', 'first');
    const a1 = appendMessage(db, 'c', 'assistant', [{ type: 'text', text: 'A1' }], u1);
    // regenerate: the old branch is retired, a new version of the same message takes its place
    db.prepare(`UPDATE messages SET is_active = 0 WHERE id >= ?`).run(u1);
    const u2 = appendMessage(db, 'c', 'user', 'first', null, { versionOf: u1 });
    const a2 = appendMessage(db, 'c', 'assistant', [{ type: 'text', text: 'A2' }], u2);
    const next = appendMessage(db, 'c', 'user', 'second', a2);
    appendMessage(db, 'c', 'assistant', [{ type: 'text', text: 'A3' }], next);

    const shown = getMessagesTimed(db, 'c');
    assert.deepEqual(shown.map(m => m.id).slice(0, 2), [u2, a2]);
    assert.deepEqual(shown[0]!.versions, [u1, u2]);
    assert.equal(shown[1]!.versions, undefined);

    assert.equal(selectVersion(db, 'c', u1), true);
    const back = getMessagesTimed(db, 'c');
    assert.deepEqual(back.map(m => m.id), [u1, a1]);
    assert.deepEqual(back[0]!.versions, [u1, u2]);

    // and forth again: the later turns that hung off the second version come back with it
    assert.equal(selectVersion(db, 'c', u2), true);
    assert.equal(getMessagesTimed(db, 'c').length, 4);
    assert.equal(getAllMessagesFull(db, 'c').filter(m => m.isActive).length, 4);
  });

  it('refuses a message that has no other version', () => {
    const db = seed();
    const u = appendMessage(db, 'c', 'user', 'only');
    assert.equal(selectVersion(db, 'c', u), false);
    assert.equal(selectVersion(db, 'c', 999), false);
  });
});

// ─── over HTTP ───────────────────────────────────────────────────────────────────

interface JsonResponse { status: number; json: Record<string, unknown> }
function call(port: number, method: string, path: string, body?: unknown): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${AUTH_TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setUp(llm: LlmClient, extra: { firstByteTimeoutMs?: number } = {}) {
  const db = openDb(':memory:');
  runMigrations(db);
  const built = await buildApp({ db, connections: [], llm, authToken: AUTH_TOKEN, config: { model: '@test/model-a', autoApproveTools: [] }, ...extra });
  const server = built.app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    db, port,
    async teardown() { built.stop(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); },
  };
}

type Msg = { id: number; role: string; content: unknown; incomplete?: string; errorText?: string; versions?: number[] };
async function messages(port: number, conv: string): Promise<Msg[]> {
  return (await call(port, 'GET', `/api/conversations/${conv}/messages`)).json['messages'] as Msg[];
}
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await sleep(15);
  }
}

describe('chat UX over HTTP', () => {
  it('a stopped turn keeps its partial answer, and Continue appends to that same message', async () => {
    const llm = streamingClient([
      { deltas: [{ text: 'The answer is ' }], end: 'until-abort' },
      { deltas: [{ text: '42.' }], end: 'reply', message: reply([text('42.')]) },
    ]);
    const { port, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'question' });
      await until(() => call(port, 'GET', `/api/conversations/${conv}/status`), r => (r.json as { status?: string }).status === 'running');
      await sleep(40);
      assert.equal((await call(port, 'POST', `/api/conversations/${conv}/kill`)).status, 200);

      const stopped = await until(() => messages(port, conv), m => m.length === 2);
      assert.equal(stopped[1]!.incomplete, 'stopped');
      assert.deepEqual(stopped[1]!.content, [{ type: 'text', text: 'The answer is ' }]);

      assert.equal((await call(port, 'POST', `/api/conversations/${conv}/continue`, {})).status, 200);
      const done = await until(() => messages(port, conv), m => m.length === 2 && m[1]!.incomplete === undefined && JSON.stringify(m[1]!.content).includes('42'));
      assert.deepEqual(done[1]!.content, [{ type: 'text', text: 'The answer is 42.' }]);
      assert.equal(done[1]!.id, stopped[1]!.id, 'the same stored message');

      // the model saw the partial text and was asked to carry on
      const sent = llm.requests[1]!.messages;
      assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user']);
      assert.match(JSON.stringify(sent[1]), /The answer is /);
      assert.match(JSON.stringify(sent[2]), new RegExp(CONTINUE_PROMPT.slice(0, 30)));
    } finally { await teardown(); }
  });

  it('refuses to continue a reply that was not cut short', async () => {
    const llm = streamingClient([{ deltas: [{ text: 'fine' }], end: 'reply', message: reply([text('fine')]) }]);
    const { port, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'q' });
      await until(() => messages(port, conv), m => m.length === 2);
      assert.equal((await call(port, 'POST', `/api/conversations/${conv}/continue`, {})).status, 409);
    } finally { await teardown(); }
  });

  it('a provider failure after some text is kept with its error sentence', async () => {
    const llm = streamingClient([{ deltas: [{ text: 'Half of an ans' }], end: 'fail', error: new Error('upstream closed the stream') }]);
    const { port, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'q' });
      const m = await until(() => messages(port, conv), v => v.length === 2);
      assert.equal(m[1]!.incomplete, 'error');
      assert.match(m[1]!.errorText ?? '', /upstream closed the stream/);
    } finally { await teardown(); }
  });

  it('a silent provider fails the attempt after the first-byte limit', async () => {
    const llm = streamingClient([{ end: 'hang' }]);
    const { port, teardown } = await setUp(llm, { firstByteTimeoutMs: 80 });
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'q' });
      const status = await until(() => call(port, 'GET', `/api/conversations/${conv}/status`), r => (r.json as { status?: string }).status === 'error');
      assert.equal((status.json as { kind?: string }).kind, 'first_byte_timeout');
      assert.match((status.json as { error?: string }).error ?? '', /did not start answering/);
    } finally { await teardown(); }
  });

  it('an empty completion is reported as such', async () => {
    const llm: LlmClient = { messages: { async create() { return reply([]); } } };
    const { port, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'q' });
      const status = await until(() => call(port, 'GET', `/api/conversations/${conv}/status`), r => (r.json as { status?: string }).status === 'error');
      assert.equal((status.json as { kind?: string }).kind, 'empty_answer');
    } finally { await teardown(); }
  });

  it('regenerate and edit by id keep every version reachable, and selecting one restores its branch', async () => {
    let n = 0;
    const llm: LlmClient = { messages: { async create() { return reply([text(`reply ${++n}`)]); } } };
    const { port, db, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'hello' });
      const first = await until(() => messages(port, conv), m => m.length === 2);
      assert.equal(first[0]!.versions, undefined);

      await call(port, 'POST', `/api/conversations/${conv}/regenerate`, { parentId: null });
      const second = await until(() => messages(port, conv), m => m.length === 2 && m[0]!.id !== first[0]!.id && m[1]!.role === 'assistant');
      assert.deepEqual(second[0]!.versions, [first[0]!.id, second[0]!.id]);

      await call(port, 'POST', `/api/conversations/${conv}/edit`, { messageId: second[0]!.id, content: 'hello, edited' });
      const third = await until(() => messages(port, conv), m => m.length === 2 && JSON.stringify(m[0]!.content).includes('edited') && m[1]!.role === 'assistant');
      assert.equal(third[0]!.versions!.length, 3);
      assert.equal(third[0]!.versions![0], first[0]!.id);

      assert.equal((await call(port, 'POST', `/api/conversations/${conv}/versions/select`, { messageId: first[0]!.id })).status, 200);
      const back = await messages(port, conv);
      assert.deepEqual(back.map(m => m.id), [first[0]!.id, first[1]!.id]);
      assert.equal((await call(port, 'POST', `/api/conversations/${conv}/versions/select`, { messageId: 99999 })).status, 400);
      assert.equal(getAllMessagesFull(db, conv).length, 6);
    } finally { await teardown(); }
  });

  it('a reply can be rewritten in place, without a new turn', async () => {
    const llm: LlmClient = { messages: { async create() { return reply([text('first'), text('second')]); } } };
    const { port, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'q' });
      const m = await until(() => messages(port, conv), v => v.length === 2);
      assert.equal((await call(port, 'PATCH', `/api/conversations/${conv}/messages/${m[1]!.id}`, { text: 'better' })).status, 200);
      const after = await messages(port, conv);
      assert.deepEqual((after[1]!.content as Array<{ text: string }>).map(b => b.text), ['first', 'better']);
      assert.equal(after.length, 2);
      assert.equal((await call(port, 'PATCH', `/api/conversations/${conv}/messages/${m[0]!.id}`, { text: 'x' })).status, 400, 'only replies');
    } finally { await teardown(); }
  });

  it('a stream that connects while a turn runs is caught up with what it produced', async () => {
    const llm = streamingClient([{ deltas: [{ text: 'streamed so far' }], end: 'until-abort' }]);
    const { port, teardown } = await setUp(llm);
    try {
      const conv = (await call(port, 'POST', '/api/conversations', {})).json['id'] as string;
      await call(port, 'POST', `/api/conversations/${conv}/message`, { content: 'q' });
      await sleep(60);
      const seen = await new Promise<string>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/conversations/${conv}/stream`, headers: { authorization: `Bearer ${AUTH_TOKEN}` } }, res => {
          let buf = '';
          res.on('data', c => { buf += c; if (buf.includes('turn:snapshot') && buf.includes('\n\n', buf.indexOf('turn:snapshot'))) { req.destroy(); resolve(buf); } });
        });
        req.on('error', e => (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e));
        setTimeout(() => { req.destroy(); reject(new Error('no snapshot')); }, 2000);
      });
      const data = JSON.parse(/event: turn:snapshot\ndata: (.*)\n/.exec(seen)![1]!) as { parts: Array<{ type: string; text?: string }>; userMessageId: number; continuing: boolean };
      assert.deepEqual(data.parts.map(p => p.text), ['streamed so far']);
      assert.equal(data.continuing, false);
      assert.ok(data.userMessageId > 0);
      await call(port, 'POST', `/api/conversations/${conv}/kill`);
    } finally { await teardown(); }
  });
});
