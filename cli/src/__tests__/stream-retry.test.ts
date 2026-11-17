import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { OpenAiCompatClient, ProviderHttpError, type RetryInfo } from '../providers/openai-compat.js';
import { classifyError } from '../providers/errors.js';
import { getModelInfo } from '../providers/registry.js';

type Step = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | { sse: unknown[] } | 'network';

function sse(events: unknown[]): Response {
  const body = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const answer = (text: string) => ({ sse: [{ id: 'r', model: 'm', choices: [{ delta: { content: text }, finish_reason: 'stop' }] }, '[DONE]'] });

/** Plays the steps in order (the last one repeats) and records every request body. */
function server(steps: Step[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const step = steps[Math.min(bodies.length - 1, steps.length - 1)]!;
    if (step === 'network') throw new TypeError('fetch failed');
    if ('sse' in step) return sse(step.sse);
    return new Response(step.text ?? JSON.stringify(step.json ?? {}), { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  return { impl, bodies, streamFlags: () => bodies.map(b => b['stream']) };
}

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiCompatClient>[0]> = {}) {
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  const c = new OpenAiCompatClient({
    baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl, modelInfo: id => getModelInfo(id), meta: { get: () => null, set: () => {} },
    sleep: async ms => { sleeps.push(ms); },
    onRetry: r => retries.push(r),
    ...extra,
  });
  return { c, sleeps, retries };
}

const params = { model: 'deepseek-chat', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] } as unknown as Llm.MessageCreateParamsNonStreaming;

async function run(c: OpenAiCompatClient) {
  const texts: string[] = [];
  const s = c.messages.stream!(params);
  s.on('streamEvent', e => { if (e.delta.type === 'text_delta') texts.push(e.delta.text); });
  const message = await s.finalMessage();
  return { message, texts };
}

describe('streamed requests share the retry loop', () => {
  it('a 429 with Retry-After is retried as a stream — one request per attempt, never a non-stream duplicate', async () => {
    const srv = server([{ status: 429, text: 'slow down', headers: { 'retry-after': '5' } }, answer('hello')]);
    const { c, sleeps, retries } = client(srv.impl);
    const { texts } = await run(c);
    assert.deepEqual(texts, ['hello']);
    assert.deepEqual(srv.streamFlags(), [true, true]);
    assert.deepEqual(sleeps, [5000]);
    assert.deepEqual([retries[0]!.attempt, retries[0]!.status, retries[0]!.delayMs], [1, 429, 5000]);
  });

  it('502/503/504 and dropped connections are retried; flaky servers still end up answering', async () => {
    const srv = server([{ status: 503, text: 'x' }, 'network', { status: 504, text: 'y' }, answer('ok')]);
    const { message } = await run(client(srv.impl).c);
    assert.equal((message.content[0] as Llm.TextBlock).text, 'ok');
    assert.deepEqual(srv.streamFlags(), [true, true, true, true]);
  });

  it('gives up with the real status when the window is spent, still without a non-stream request', async () => {
    const srv = server([{ status: 503, text: 'down' }]);
    const { c } = client(srv.impl, { retryBudgetMs: 2500 });
    await assert.rejects(run(c), (e: Error) => e instanceof ProviderHttpError && e.status === 503);
    assert.deepEqual(srv.streamFlags(), [true, true, true]);
  });

  it('retryBudgetMs 0: one request and the error', async () => {
    const srv = server([{ status: 429, text: 'no' }]);
    await assert.rejects(run(client(srv.impl, { retryBudgetMs: 0 }).c), ProviderHttpError);
    assert.deepEqual(srv.streamFlags(), [true]);
  });

  it('a non-transient 4xx is not retried and does not fall back either', async () => {
    const srv = server([{ status: 400, text: 'bad request' }]);
    await assert.rejects(run(client(srv.impl).c), (e: Error) => e instanceof ProviderHttpError && e.status === 400);
    assert.deepEqual(srv.streamFlags(), [true]);
  });

  it('only a server that refuses streaming gets the plain request', async () => {
    const srv = server([{ status: 400, json: { error: { message: 'stream is not supported' } } }, { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: 'plain' } }] } }]);
    const { message } = await run(client(srv.impl).c);
    assert.equal((message.content[0] as Llm.TextBlock).text, 'plain');
    assert.deepEqual(srv.streamFlags(), [true, false]);
  });

  it('keeps accepting a plain JSON answer to a streaming request', async () => {
    const srv = server([{ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: 'json' } }] }, headers: { 'content-type': 'application/json' } }]);
    const { message } = await run(client(srv.impl).c);
    assert.equal((message.content[0] as Llm.TextBlock).text, 'json');
    assert.deepEqual(srv.streamFlags(), [true]);
  });

  it('a JSON error object inside a 200 is an error, not "no completion choices"', async () => {
    const srv = server([{ status: 200, json: { error: { code: 'upstream_overloaded', message: 'busy' } }, headers: { 'content-type': 'application/json' } }]);
    const err = await run(client(srv.impl, { retryBudgetMs: 0 }).c).catch(e => e);
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.status, 503);
  });

  it('the stop button ends a wait between stream attempts', async () => {
    const srv = server([{ status: 429, text: 'x' }]);
    const ctl = new AbortController();
    const { c } = client(srv.impl, { sleep: () => new Promise<void>(() => {}), onRetry: () => queueMicrotask(() => ctl.abort(new Error('killed'))) });
    await assert.rejects(c.messages.stream!(params, { signal: ctl.signal }).finalMessage(), /killed/);
    assert.deepEqual(srv.streamFlags(), [true]);
  });
});

describe('error events inside a stream', () => {
  const rateLimited = { sse: [{ error: { message: 'slow down', type: 'rate_limit', code: 'upstream_rate_limited', retry_after_s: 3 } }] };

  it('before any content: retried under the budget, honouring retry_after_s, and the answer arrives once', async () => {
    const srv = server([rateLimited, answer('fine')]);
    const { c, sleeps } = client(srv.impl);
    const { texts, message } = await run(c);
    assert.deepEqual(texts, ['fine']);
    assert.equal((message.content[0] as Llm.TextBlock).text, 'fine');
    assert.deepEqual(sleeps, [3000]);
    assert.deepEqual(srv.streamFlags(), [true, true]);
  });

  it('keeps its classification: rate limit → 429, overloaded → 503, timeout → 504, anything else → 502', async () => {
    const cases: Array<[unknown, number]> = [
      [{ code: 'upstream_rate_limited' }, 429],
      [{ code: 'upstream_overloaded' }, 503],
      [{ code: 'pacing_timeout' }, 504],
      [{ message: 'weird' }, 502],
    ];
    for (const [error, status] of cases) {
      const err = await run(client(server([{ sse: [{ error }] }]).impl, { retryBudgetMs: 0 }).c).catch(e => e);
      assert.ok(err instanceof ProviderHttpError, JSON.stringify(error));
      assert.equal(err.status, status, JSON.stringify(error));
    }
  });

  it('an exhausted quota or budget in the stream is never retried and names the reset', async () => {
    const reset = new Date(Date.now() + 5 * 3_600_000).toISOString();
    for (const code of ['upstream_quota_exhausted', 'budget_exhausted']) {
      const srv = server([{ sse: [{ error: { message: 'out', code, provider: 'acme', reset_at: reset } }] }]);
      const err = await run(client(srv.impl).c).catch(e => e);
      assert.equal(srv.bodies.length, 1, code);
      assert.equal(err.status, 429);
      const incident = classifyError(err);
      assert.equal(incident.kind, 'budget_exhausted');
      assert.match(incident.message, /(comes back|resets) (at|on)/);
    }
  });

  it('after content has been emitted it is not retried: the text is never duplicated', async () => {
    const srv = server([
      { sse: [{ choices: [{ delta: { content: 'Half an ' } }] }, { error: { code: 'upstream_overloaded', message: 'gone' } }] },
      answer('SHOULD NOT BE REQUESTED'),
    ]);
    const texts: string[] = [];
    const s = client(srv.impl).c.messages.stream!(params);
    s.on('streamEvent', e => { if (e.delta.type === 'text_delta') texts.push(e.delta.text); });
    const err = await s.finalMessage().catch(e => e);
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.status, 503);
    assert.equal(classifyError(err).kind, 'busy');
    assert.deepEqual(texts, ['Half an ']);
    assert.equal(srv.bodies.length, 1);
  });

  it('a reasoning or tool-call delta counts as content too', async () => {
    for (const delta of [{ reasoning_content: 'hmm' }, { tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{' } }] }]) {
      const srv = server([{ sse: [{ choices: [{ delta }] }, { error: { code: 'upstream_rate_limited' } }] }, answer('again')]);
      await assert.rejects(run(client(srv.impl).c), ProviderHttpError);
      assert.equal(srv.bodies.length, 1);
    }
  });

  it('a stream cut off before any content is retried; one cut off after content is not', async () => {
    const early = server([{ sse: [] }, answer('ok')]);
    const { texts } = await run(client(early.impl).c);
    assert.deepEqual(texts, ['ok']);
    assert.equal(early.bodies.length, 2);
    const late = server([{ sse: [{ choices: [{ delta: { content: 'part' } }] }] }, answer('ok')]);
    await assert.rejects(run(client(late.impl).c), /ended before the answer was complete/);
    assert.equal(late.bodies.length, 1);
  });

  it('a wait the server asks for that exceeds the window fails now, saying when to retry', async () => {
    const srv = server([{ sse: [{ error: { code: 'upstream_rate_limited', retry_after_s: 900 } }] }]);
    const err = await run(client(srv.impl).c).catch(e => e);
    assert.equal(srv.bodies.length, 1);
    assert.match(classifyError(err).message, /wait about 15 min/);
  });
});
