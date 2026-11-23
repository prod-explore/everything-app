import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Llm from '../llm-types.js';
import { buildApp } from '../server.js';
import { openDb, runMigrations } from '../db.js';
import { EmptyAnswerError, FirstByteTimeoutError, runTurn, type LlmClient, type MessageStreamLike, type ModelRetryInfo } from '../llm-loop.js';
import { OpenAiCompatClient } from '../providers/openai-compat.js';
import { getModelInfo } from '../providers/registry.js';
import { ToolRegistry } from '../tool-registry.js';
import { classifyTurnError, firstByteTimeoutMs, firstContentTimeoutMs } from '../turn-errors.js';

// A model that thinks for a long time sends keep-alives (SSE comments) and then answers. The turn must tell that from a hung
// provider: an idle limit restarted by every byte, a hard limit on the time to the first content, and one automatic repeat of a
// request that produced nothing - never of one that already streamed text, never of a tool.

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function reply(content: Llm.ContentBlock[], stop: Llm.StopReason = 'end_turn'): Llm.Message {
  return {
    id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
  } as unknown as Llm.Message;
}
const text = (t: string): Llm.ContentBlock => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;
const toolUse = (id: string): Llm.ContentBlock => ({ type: 'tool_use', id, name: 'x__t', input: {} }) as unknown as Llm.ContentBlock;

interface Ctx {
  activity(): void;
  text(t: string): void;
  thinking(t: string): void;
  signal: AbortSignal | undefined;
  /** Sleeps, and fails like a cancelled request when the turn aborts it. */
  wait(ms: number): Promise<void>;
  /** Sends `activity()` every `everyMs` for `forMs`. */
  beat(everyMs: number, forMs: number): Promise<void>;
  hang(): Promise<never>;
}
type Script = (c: Ctx) => Promise<Llm.Message>;

function scriptedClient(scripts: Script[]): LlmClient & { requests: number } {
  const state = { requests: 0 };
  const client = {
    get requests() { return state.requests; },
    messages: {
      async create() { throw new Error('streaming only'); },
      stream(_params: Llm.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; onActivity?: () => void }): MessageStreamLike {
        const script = scripts[Math.min(state.requests++, scripts.length - 1)]!;
        const listeners: Array<(e: Llm.MessageStreamEvent) => void> = [];
        const signal = options?.signal;
        const aborted = () => new Error('The operation was aborted');
        const wait = (ms: number) => new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(aborted());
          const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
          const onAbort = () => { clearTimeout(t); reject(aborted()); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        const emit = (delta: Llm.MessageStreamEvent['delta']) => { for (const l of listeners) l({ type: 'content_block_delta', index: 0, delta }); };
        const ctx: Ctx = {
          activity: () => options?.onActivity?.(),
          text: t => emit({ type: 'text_delta', text: t }),
          thinking: t => emit({ type: 'thinking_delta', thinking: t }),
          signal,
          wait,
          async beat(everyMs, forMs) {
            for (let spent = 0; spent < forMs; spent += everyMs) {
              await wait(everyMs);
              options?.onActivity?.();
            }
          },
          hang: () => new Promise<never>((_, reject) => {
            if (signal?.aborted) return reject(aborted());
            signal?.addEventListener('abort', () => reject(aborted()), { once: true });
          }),
        };
        const final = (async () => { await Promise.resolve(); return script(ctx); })();
        return { on(_e, l) { listeners.push(l); return this; }, finalMessage: () => final };
      },
    },
  };
  return client as unknown as LlmClient & { requests: number };
}

const emptyTools = () => new ToolRegistry([]);
const noop = async () => true;
const base = { model: 'm', tools: emptyTools(), systemPrompt: 's', confirm: noop, onTextDelta: () => {} };
const answered = (t: string): Script => async c => { c.text(t); return reply([text(t)]); };

describe('idle limit: every byte of the provider counts', () => {
  it('a model that thinks longer than the limit stays alive while keep-alives arrive', async () => {
    const retries: ModelRetryInfo[] = [];
    const llm = scriptedClient([async c => { await c.beat(30, 300); c.text('done'); return reply([text('done')]); }]);
    const started = Date.now();
    const out = await runTurn({ ...base, llm, firstByteTimeoutMs: 100, onModelRetry: r => retries.push(r) }, [], 'hi');
    assert.ok(Date.now() - started >= 280, 'it really waited past the 100 ms limit');
    assert.equal(out.length, 2);
    assert.equal(llm.requests, 1);
    assert.deepEqual(retries, []);
  });

  it('without keep-alives the idle limit is the old first-byte limit', async () => {
    const llm = scriptedClient([answered('late')]);
    const slow: Script = async c => { await c.wait(250); c.text('late'); return reply([text('late')]); };
    const retries: ModelRetryInfo[] = [];
    const out = await runTurn({ ...base, llm: scriptedClient([slow, answered('quick')]), firstByteTimeoutMs: 100, onModelRetry: r => retries.push(r) }, [], 'hi');
    assert.equal(retries.length, 1);
    assert.equal(retries[0]!.reason, 'idle');
    assert.equal((out[1]!.content as Llm.TextBlock[])[0]!.text, 'quick');
    assert.equal(llm.requests, 0);
  });

  it('keep-alives stop mattering once the answer has started (the adapter\'s own stall limit takes over)', async () => {
    const llm = scriptedClient([async c => { c.text('a'); await c.wait(250); c.text('b'); return reply([text('ab')]); }]);
    const out = await runTurn({ ...base, llm, firstByteTimeoutMs: 100, firstContentTimeoutMs: 100 }, [], 'hi');
    assert.equal(out.length, 2);
    assert.equal(llm.requests, 1);
  });

  it('is not running while the adapter backs off before its own retry', async () => {
    const wait = { until: Date.now() + 250 };
    const llm = scriptedClient([async c => { await c.wait(200); c.text('late'); return reply([text('late')]); }]);
    const out = await runTurn({ ...base, llm, firstByteTimeoutMs: 50, firstContentTimeoutMs: 80, waitingUntil: () => wait.until }, [], 'hi');
    assert.equal(out.length, 2);
    assert.equal(llm.requests, 1);
  });
});

describe('hard limit on the time to the first content', () => {
  it('stops a model that is kept "alive" by keep-alives but never answers, and says so', async () => {
    const llm = scriptedClient([async c => { await c.beat(20, 5000); return reply([text('never')]); }]);
    const started = Date.now();
    await assert.rejects(
      runTurn({ ...base, llm, firstByteTimeoutMs: 100, firstContentTimeoutMs: 200, modelRetries: 0 }, [], 'hi'),
      (err: unknown) => err instanceof FirstByteTimeoutError && err.kind === 'first_content' && err.ms === 200 && err.attempts === 1,
    );
    assert.ok(Date.now() - started < 1500);
  });

  it('counts reasoning as content: a model that thinks aloud is not cut off', async () => {
    const llm = scriptedClient([async c => { await c.wait(40); c.thinking('hmm'); await c.beat(20, 300); c.text('ok'); return reply([text('ok')]); }]);
    const out = await runTurn({ ...base, llm, onThinkingDelta: () => {}, firstByteTimeoutMs: 100, firstContentTimeoutMs: 200 }, [], 'hi');
    assert.equal(out.length, 2);
    assert.equal(llm.requests, 1);
  });

  it('reads FIRST_CONTENT_TIMEOUT_S (default 10 min, 0 = off) next to FIRST_BYTE_TIMEOUT_S (default 90 s)', () => {
    assert.equal(firstContentTimeoutMs({}), 600_000);
    assert.equal(firstContentTimeoutMs({ FIRST_CONTENT_TIMEOUT_S: '120' }), 120_000);
    assert.equal(firstContentTimeoutMs({ FIRST_CONTENT_TIMEOUT_S: '0' }), 0);
    assert.equal(firstContentTimeoutMs({ FIRST_CONTENT_TIMEOUT_S: '-5' }), 600_000);
    assert.equal(firstContentTimeoutMs({ FIRST_CONTENT_TIMEOUT_S: 'later' }), 600_000);
    assert.equal(firstByteTimeoutMs({}), 90_000);
    assert.equal(firstByteTimeoutMs({ FIRST_BYTE_TIMEOUT_S: '0' }), 0);
  });
});

describe('one automatic repeat of a request that produced nothing', () => {
  it('silence -> one retry -> success, announced before it happens', async () => {
    const seen: string[] = [];
    const llm = scriptedClient([async c => c.hang(), answered('second try')]);
    const out = await runTurn({ ...base, llm, firstByteTimeoutMs: 60, onModelRetry: r => seen.push(`${r.reason}#${r.attempt}`) }, [], 'hi');
    assert.deepEqual(seen, ['idle#2']);
    assert.equal(llm.requests, 2);
    assert.equal((out[1]!.content as Llm.TextBlock[])[0]!.text, 'second try');
  });

  it('two timeouts in a row fail the turn, with the failure of the repeat and the number of tries', async () => {
    const llm = scriptedClient([async c => c.hang()]);
    await assert.rejects(
      runTurn({ ...base, llm, firstByteTimeoutMs: 50 }, [], 'hi'),
      (err: unknown) => {
        if (!(err instanceof FirstByteTimeoutError)) return false;
        assert.equal(err.attempts, 2);
        assert.match(classifyTurnError(err).message, /already retried once/);
        return true;
      },
    );
    assert.equal(llm.requests, 2);
  });

  it('a hard-limit timeout is repeated too', async () => {
    const seen: string[] = [];
    const llm = scriptedClient([async c => { await c.beat(20, 5000); return reply([]); }, answered('fine')]);
    const out = await runTurn({ ...base, llm, firstByteTimeoutMs: 100, firstContentTimeoutMs: 150, onModelRetry: r => seen.push(r.reason) }, [], 'hi');
    assert.deepEqual(seen, ['first_content']);
    assert.equal(out.length, 2);
  });

  it('an empty answer -> one retry -> success; the discarded response is still counted as usage', async () => {
    const seen: string[] = [];
    let usages = 0;
    const llm = scriptedClient([async () => reply([]), answered('now with words')]);
    const out = await runTurn({ ...base, llm, onUsage: () => { usages++; }, onModelRetry: r => seen.push(r.reason) }, [], 'hi');
    assert.deepEqual(seen, ['empty']);
    assert.equal(usages, 2);
    assert.equal(out.length, 2, 'the empty response is not part of the history');
    assert.equal((out[1]!.content as Llm.TextBlock[])[0]!.text, 'now with words');
  });

  it('two empty answers fail with EmptyAnswerError', async () => {
    const llm = scriptedClient([async () => reply([])]);
    await assert.rejects(runTurn({ ...base, llm }, [], 'hi'), EmptyAnswerError);
    assert.equal(llm.requests, 2);
  });

  it('only one repeat per request, whichever kind of failure comes first', async () => {
    const llm = scriptedClient([async () => reply([]), async c => c.hang(), answered('never reached')]);
    await assert.rejects(runTurn({ ...base, llm, firstByteTimeoutMs: 50 }, [], 'hi'), FirstByteTimeoutError);
    assert.equal(llm.requests, 2);
  });

  it('modelRetries: 0 switches it off', async () => {
    const llm = scriptedClient([async c => c.hang(), answered('x')]);
    await assert.rejects(runTurn({ ...base, llm, firstByteTimeoutMs: 50, modelRetries: 0 }, [], 'hi'), (e: unknown) => e instanceof FirstByteTimeoutError && e.attempts === 1);
    assert.equal(llm.requests, 1);
  });

  it('never repeats a request that already streamed text (the person has read it), and a provider error is never repeated', async () => {
    const llm = scriptedClient([async c => { c.text('Half an ans'); await c.hang(); throw new Error('unreachable'); }, answered('again')]);
    const batches: unknown[][] = [];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(runTurn({ ...base, llm, firstByteTimeoutMs: 1000, onMessages: b => batches.push(b), signal: ac.signal }, [], 'hi'));
    assert.equal(llm.requests, 1);
    assert.equal(batches.flat().length, 1, 'the half answer is kept, not repeated');
    const boom = scriptedClient([async () => { throw new Error('upstream closed the stream'); }, answered('again')]);
    await assert.rejects(runTurn({ ...base, llm: boom }, [], 'hi'), /upstream closed/);
    assert.equal(boom.requests, 1);
  });

  it('the stop button wins: an aborted turn is not repeated', async () => {
    const ac = new AbortController();
    const llm = scriptedClient([async c => c.hang(), answered('x')]);
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(runTurn({ ...base, llm, signal: ac.signal, firstByteTimeoutMs: 5000 }, [], 'hi'));
    assert.equal(llm.requests, 1);
  });

  it('repeats the request, never a tool: a step that times out after a tool ran asks the model again and the tool runs once', async () => {
    let runs = 0;
    const registry = new ToolRegistry(['x__t']);
    await registry.loadFrom([{ name: 'x', async listTools() { return [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]; }, async callTool() { runs++; return { text: 'ok', isError: false }; } }]);
    const llm = scriptedClient([async () => reply([toolUse('c1')], 'tool_use'), async c => c.hang(), answered('after the tool')]);
    const out = await runTurn({ ...base, llm, tools: registry, firstByteTimeoutMs: 60 }, [], 'go');
    assert.equal(runs, 1);
    assert.equal(llm.requests, 3);
    assert.equal(out.length, 4);
  });
});

// ─── a real SSE stream through the OpenAI-compatible adapter ───────────────────────────────

/** An OpenAI-style server: `behave(n)` decides what the n-th request gets (keep-alive comments, a delay, then the answer). */
async function sseServer(behave: (n: number, res: http.ServerResponse) => Promise<void>): Promise<{ url: string; requests: () => number; close(): Promise<void> }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      n++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      void behave(n, res).catch(() => {}).finally(() => res.end());
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests: () => n,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
const event = (o: unknown) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;
const answerEvents = (words: string[]) => [
  ...words.map(w => event({ id: 'r', model: 'm', choices: [{ delta: { content: w } }] })),
  event({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  event({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  event('[DONE]'),
];
const compat = (url: string) => new OpenAiCompatClient({ baseUrl: url, apiKey: 'k', modelInfo: getModelInfo, meta: { get: () => null, set: () => {} }, maxRetries: 0 });

describe('the adapter reports every received byte, comments included', () => {
  it('a gateway that keeps the stream alive with comments for longer than the idle limit gets its answer', async () => {
    const srv = await sseServer(async (_n, res) => {
      res.write(event({ choices: [{ delta: { role: 'assistant', content: '' } }] })); // the empty opening chunk is activity, not content
      for (let i = 0; i < 12; i++) { res.write(': keep-alive\n\n'); await sleep(40); }
      for (const e of answerEvents(['It ', 'worked'])) res.write(e);
    });
    try {
      const retries: ModelRetryInfo[] = [];
      const deltas: string[] = [];
      const out = await runTurn(
        { ...base, llm: compat(srv.url), firstByteTimeoutMs: 150, onTextDelta: d => deltas.push(d.text), onModelRetry: r => retries.push(r) },
        [],
        'think',
      );
      assert.equal(deltas.join(''), 'It worked');
      assert.equal(out.length, 2);
      assert.equal(srv.requests(), 1);
      assert.deepEqual(retries, []);
    } finally { await srv.close(); }
  });

  it('a stream that goes silent is cut at the idle limit, repeated once, and the second request answers', async () => {
    const srv = await sseServer(async (n, res) => {
      if (n === 1) { res.write(': keep-alive\n\n'); await sleep(1500); return; } // one comment, then nothing
      for (const e of answerEvents(['second'])) res.write(e);
    });
    try {
      const retries: ModelRetryInfo[] = [];
      const t0 = Date.now();
      const out = await runTurn({ ...base, llm: compat(srv.url), firstByteTimeoutMs: 200, onModelRetry: r => retries.push(r) }, [], 'think');
      assert.ok(Date.now() - t0 < 1200);
      assert.equal(srv.requests(), 2);
      assert.deepEqual(retries.map(r => r.reason), ['idle']);
      assert.equal((out[1]!.content as Llm.TextBlock[])[0]!.text, 'second');
    } finally { await srv.close(); }
  });

  it('keep-alives without an answer end at the hard limit, twice, with the matching message', async () => {
    const srv = await sseServer(async (_n, res) => { for (let i = 0; i < 100; i++) { res.write(': keep-alive\n\n'); await sleep(30); } });
    try {
      await assert.rejects(
        runTurn({ ...base, llm: compat(srv.url), firstByteTimeoutMs: 200, firstContentTimeoutMs: 400 }, [], 'think'),
        (err: unknown) => {
          if (!(err instanceof FirstByteTimeoutError)) return false;
          assert.equal(err.kind, 'first_content');
          assert.equal(err.attempts, 2);
          assert.equal(classifyTurnError(err).kind, 'first_byte_timeout');
          assert.match(classifyTurnError(err).message, /kept the connection open but had not started answering/);
          return true;
        },
      );
      assert.equal(srv.requests(), 2);
    } finally { await srv.close(); }
  });
});

describe('the messages', () => {
  it('say which limit was hit, and that the request was already repeated', () => {
    const idle = new FirstByteTimeoutError(90_000);
    assert.match(classifyTurnError(idle).message, /did not start answering within 90 s: nothing arrived, not even a keep-alive\. Retry, or try another model\.$/);
    idle.attempts = 2;
    assert.match(classifyTurnError(idle).message, /already retried once automatically/);
    assert.match(classifyTurnError(new FirstByteTimeoutError(600_000, 'first_content')).message, /after 10 min/);
    assert.equal(classifyTurnError(new FirstByteTimeoutError(600_000, 'first_content')).transient, true);
  });
});

// ─── over HTTP: what the person's chat sees ─────────────────────────────────────────────

const TOKEN = 'model-retry-token';

describe('chat over HTTP', () => {
  async function setUp(llm: LlmClient) {
    const db = openDb(':memory:');
    runMigrations(db);
    const built = await buildApp({ db, connections: [], llm, authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: [] }, firstByteTimeoutMs: 80, firstContentTimeoutMs: 0 });
    const server = built.app.listen(0);
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    /** The conversation's event stream, as the browser reads it. */
    const events: string[] = [];
    let open: http.IncomingMessage | undefined;
    const listen = (conv: string) => new Promise<void>(resolve => {
      http.get({ host: '127.0.0.1', port, path: `/api/conversations/${conv}/stream`, headers: { authorization: `Bearer ${TOKEN}` } }, res => {
        open = res;
        res.setEncoding('utf8');
        res.on('data', (d: string) => events.push(d));
        resolve();
      });
    });
    return { call, events, listen, async teardown() { open?.destroy(); built.stop(); await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); db.close(); } };
  }
  const until = async (ok: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) throw new Error('timed out'); await sleep(15); } };

  it('a silent first request is repeated: the turn ends done, and the chat was told it is retrying', async () => {
    const llm = scriptedClient([async c => c.hang(), answered('Here is the answer.')]);
    const t = await setUp(llm);
    try {
      const conv = (await t.call('POST', '/api/conversations', {})).json['id'] as string;
      await t.listen(conv);
      await t.call('POST', `/api/conversations/${conv}/message`, { content: 'q' });
      await until(async () => (await t.call('GET', `/api/conversations/${conv}/status`)).json['status'] === 'done');
      assert.equal(llm.requests, 2);
      const log = t.events.join('');
      const retry = /event: provider:retry\ndata: (.+)\n/.exec(log);
      assert.ok(retry, log);
      assert.deepEqual(
        { status: JSON.parse(retry[1]!).status, attempt: JSON.parse(retry[1]!).attempt, delayMs: JSON.parse(retry[1]!).delayMs, conversationId: JSON.parse(retry[1]!).conversationId },
        { status: 'timeout', attempt: 1, delayMs: 0, conversationId: conv },
      );
      const msgs = (await t.call('GET', `/api/conversations/${conv}/messages`)).json['messages'] as Array<{ role: string }>;
      assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant']);
    } finally { await t.teardown(); }
  });

  it('two silent requests end the turn with the sentence that says it was retried', async () => {
    const t = await setUp(scriptedClient([async c => c.hang()]));
    try {
      const conv = (await t.call('POST', '/api/conversations', {})).json['id'] as string;
      await t.call('POST', `/api/conversations/${conv}/message`, { content: 'q' });
      await until(async () => (await t.call('GET', `/api/conversations/${conv}/status`)).json['status'] === 'error');
      const status = (await t.call('GET', `/api/conversations/${conv}/status`)).json;
      assert.equal(status['kind'], 'first_byte_timeout');
      assert.match(String(status['error']), /already retried once automatically/);
    } finally { await t.teardown(); }
  });

  it('an empty answer is repeated once, and tells the chat', async () => {
    const t = await setUp(scriptedClient([async () => reply([]), answered('words')]));
    try {
      const conv = (await t.call('POST', '/api/conversations', {})).json['id'] as string;
      await t.listen(conv);
      await t.call('POST', `/api/conversations/${conv}/message`, { content: 'q' });
      await until(async () => (await t.call('GET', `/api/conversations/${conv}/status`)).json['status'] === 'done');
      assert.match(t.events.join(''), /event: provider:retry\ndata: .*"status":"empty"/);
    } finally { await t.teardown(); }
  });
});
