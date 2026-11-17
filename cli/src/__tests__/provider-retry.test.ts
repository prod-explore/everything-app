import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { getModelInfo } from '../providers/registry.js';
import { DEFAULT_RETRY_BUDGET_MS, OpenAiCompatClient, ProviderHttpError, parseErrorPayload, parseRetryAfter, retryDelayMs, statusForErrorEvent, type RetryInfo } from '../providers/openai-compat.js';
import { classifyError } from '../providers/errors.js';

const ok = { choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const req = { model: 'gemini-3.5-flash-lite', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] } as Llm.MessageCreateParamsNonStreaming;

function scripted(steps: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | 'network'>) {
  let i = 0;
  const impl = (async () => {
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step === 'network') throw new TypeError('fetch failed');
    return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}), { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return { impl, calls: () => i };
}

function client(f: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiCompatClient>[0]> = {}) {
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  const c = new OpenAiCompatClient({
    baseUrl: 'https://api.example.test',
    apiKey: 'k',
    meta: { get: () => null, set: () => {} },
    modelInfo: getModelInfo,
    fetchImpl: f,
    sleep: async ms => { sleeps.push(ms); },
    onRetry: r => retries.push(r),
    ...extra,
  });
  return { c, sleeps, retries };
}

describe('retryDelayMs', () => {
  it('backs off exponentially with ±20% jitter, never above the cap or below 1 s', () => {
    assert.equal(retryDelayMs(0, undefined, 300_000, () => 0.5), 1000);
    assert.equal(retryDelayMs(3, undefined, 300_000, () => 0.5), 8000);
    assert.equal(retryDelayMs(3, undefined, 300_000, () => 0), 6400);
    assert.equal(retryDelayMs(20, undefined, 300_000, () => 1), 300_000);
  });
  it('lets the server Retry-After win, still capped', () => {
    assert.equal(retryDelayMs(0, 42, 300_000), 42_000);
    assert.equal(retryDelayMs(0, 9999, 300_000), 300_000);
  });
});

describe('budgeted retry (provider peak hours)', () => {
  it('keeps retrying past the classic 2-retry limit until the provider recovers', async () => {
    const f = scripted([...Array(6).fill({ status: 429, body: 'quota' }), { status: 200, body: ok }]);
    const { c, sleeps, retries } = client(f.impl, { retryBudgetMs: 12 * 3_600_000 });
    const res = await c.messages.create(req);
    assert.equal((res.content[0] as Llm.TextBlock).text, 'done');
    assert.equal(f.calls(), 7);
    assert.equal(sleeps.length, 6);
    assert.ok(sleeps.every(ms => ms >= 1000 && ms <= 300_000));
    assert.deepEqual(retries.map(r => r.attempt), [1, 2, 3, 4, 5, 6]);
    assert.equal(retries[0]!.status, 429);
  });

  it('honours Retry-After', async () => {
    const f = scripted([{ status: 429, body: 'slow down', headers: { 'retry-after': '90' } }, { status: 200, body: ok }]);
    const { c, sleeps } = client(f.impl, { retryBudgetMs: 3_600_000 });
    await c.messages.create(req);
    assert.deepEqual(sleeps, [90_000]);
  });

  it('retries network errors in budget mode', async () => {
    const f = scripted(['network', 'network', { status: 200, body: ok }]);
    const { c, sleeps } = client(f.impl, { retryBudgetMs: 3_600_000 });
    await c.messages.create(req);
    assert.equal(sleeps.length, 2);
  });

  it('gives up when the budget cannot cover another wait, and says so', async () => {
    const f = scripted([{ status: 503, body: 'overloaded' }]);
    const { c } = client(f.impl, { retryBudgetMs: 2500 });
    await assert.rejects(c.messages.create(req), (e: Error) => e instanceof ProviderHttpError && e.status === 503 && /gave up/.test(e.message));
    assert.equal(f.calls(), 3);
  });

  it('never retries a non-transient error', async () => {
    const f = scripted([{ status: 400, body: 'bad request' }]);
    const { c } = client(f.impl, { retryBudgetMs: 3_600_000 });
    await assert.rejects(c.messages.create(req), (e: Error) => e instanceof ProviderHttpError && e.status === 400);
    assert.equal(f.calls(), 1);
  });

  it('the kill switch interrupts a long wait immediately', async () => {
    const f = scripted([{ status: 429, body: 'quota' }]);
    const ctl = new AbortController();
    const { c } = client(f.impl, {
      retryBudgetMs: 12 * 3_600_000,
      sleep: () => new Promise<void>(() => {}), // would wait "forever"
      onRetry: () => queueMicrotask(() => ctl.abort(new Error('killed'))),
    });
    await assert.rejects(c.messages.create(req, { signal: ctl.signal }), /killed/);
    assert.equal(f.calls(), 1);
  });

  it('quick mode (maxRetries): two retries after 1 s and 2 s, then gives up', async () => {
    const busy = scripted([{ status: 503, body: 'x' }]);
    const { c, sleeps } = client(busy.impl, { maxRetries: 2 });
    await assert.rejects(c.messages.create(req), ProviderHttpError);
    assert.equal(busy.calls(), 3);
    assert.deepEqual(sleeps, [1000, 2000]);
    const net = scripted(['network', { status: 200, body: ok }]);
    await client(net.impl, { maxRetries: 2 }).c.messages.create(req);
    assert.equal(net.calls(), 2);
    const none = scripted([{ status: 503, body: 'x' }]);
    await assert.rejects(client(none.impl, { maxRetries: 0 }).c.messages.create(req), ProviderHttpError);
    assert.equal(none.calls(), 1);
  });
});

describe('default retry window (2 minutes)', () => {
  it('retries a transient failure with no setting at all, backing off until the window is spent', async () => {
    const f = scripted([{ status: 503, body: 'down' }]);
    const { c, sleeps, retries } = client(f.impl);
    await assert.rejects(c.messages.create(req), (e: Error) => e instanceof ProviderHttpError && e.status === 503 && /gave up/.test(e.message));
    assert.ok(sleeps.length >= 6 && sleeps.length <= 9, `backoff doubles until a pause no longer fits the ${DEFAULT_RETRY_BUDGET_MS / 1000} s window (${sleeps.length} waits)`);
    assert.equal(f.calls(), sleeps.length + 1);
    assert.equal(retries[0]!.remainingMs > 100_000, true);
  });

  it('recovers when the provider comes back inside the window, network errors included', async () => {
    const f = scripted(['network', { status: 502, body: 'bad gateway' }, { status: 504, body: 'timeout' }, { status: 200, body: ok }]);
    const { c } = client(f.impl);
    assert.equal(((await c.messages.create(req)).content[0] as Llm.TextBlock).text, 'done');
    assert.equal(f.calls(), 4);
  });

  it('an explicit window of 0 means no automatic retries', async () => {
    const f = scripted([{ status: 429, body: 'slow down' }]);
    const { c, sleeps } = client(f.impl, { retryBudgetMs: 0 });
    await assert.rejects(c.messages.create(req), ProviderHttpError);
    assert.equal(f.calls(), 1);
    assert.deepEqual(sleeps, []);
  });

  it('honours a Retry-After far beyond 30 s when it fits the window, as seconds or as a date', async () => {
    const f = scripted([{ status: 429, body: 'slow down', headers: { 'retry-after': '75' } }, { status: 200, body: ok }]);
    const a = client(f.impl);
    await a.c.messages.create(req);
    assert.deepEqual(a.sleeps, [75_000]);
    const at = new Date(Date.now() + 50_000).toUTCString();
    const g = scripted([{ status: 429, body: 'x', headers: { 'retry-after': at } }, { status: 200, body: ok }]);
    const b = client(g.impl);
    await b.c.messages.create(req);
    assert.ok(b.sleeps[0]! >= 48_000 && b.sleeps[0]! <= 50_000, String(b.sleeps[0]));
  });

  it('a wait longer than the window fails at once and says when to retry', async () => {
    const f = scripted([{ status: 429, body: '{"error":{"code":"upstream_rate_limited"}}', headers: { 'retry-after': '600' } }]);
    const { c, sleeps } = client(f.impl);
    const err = await c.messages.create(req).catch(e => e);
    assert.ok(err instanceof ProviderHttpError);
    assert.equal(err.retryAfterMs, 600_000);
    assert.equal(f.calls(), 1);
    assert.deepEqual(sleeps, []);
    const incident = classifyError(err);
    assert.equal(incident.kind, 'rate_limited');
    assert.match(incident.message, /wait about 10 min/);
  });

  it('reads the wait from the body (retry_after_s) when there is no header', async () => {
    const f = scripted([{ status: 429, body: '{"error":{"code":"upstream_rate_limited","message":"slow","retry_after_s":7}}' }, { status: 200, body: ok }]);
    const { c, sleeps } = client(f.impl);
    await c.messages.create(req);
    assert.deepEqual(sleeps, [7000]);
  });

  it('never retries an exhausted quota or budget, and shows when it resets', async () => {
    const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const f = scripted([{ status: 429, body: JSON.stringify({ error: { code: 'upstream_quota_exhausted', provider: 'acme', reset_at: reset } }) }]);
    const { c } = client(f.impl);
    const err = await c.messages.create(req).catch(e => e);
    assert.equal(f.calls(), 1);
    const incident = classifyError(err);
    assert.equal(incident.kind, 'budget_exhausted');
    assert.match(incident.message, /comes back (at|on)/);
  });

  it('500 and 408 get two retries, not the whole window', async () => {
    const f = scripted([{ status: 500, body: 'oops' }]);
    const { c } = client(f.impl);
    await assert.rejects(c.messages.create(req), ProviderHttpError);
    assert.equal(f.calls(), 3);
  });

  it('the stop button interrupts a real wait without leaving the timer behind', async () => {
    const f = scripted([{ status: 503, body: 'down' }]);
    const ctl = new AbortController();
    const c = new OpenAiCompatClient({
      baseUrl: 'https://api.example.test', apiKey: 'k', meta: { get: () => null, set: () => {} }, modelInfo: getModelInfo, fetchImpl: f.impl,
      onRetry: () => setTimeout(() => ctl.abort(new Error('killed')), 20),
    });
    const t0 = Date.now();
    await assert.rejects(c.messages.create(req, { signal: ctl.signal }), /killed/);
    assert.ok(Date.now() - t0 < 900, 'the 1 s wait was cut short');
    assert.equal(f.calls(), 1);
  });
});

describe('parseRetryAfter / error events', () => {
  it('parses seconds, dates and rubbish', () => {
    assert.equal(parseRetryAfter('12'), 12_000);
    assert.equal(parseRetryAfter('1.5'), 1500);
    assert.equal(parseRetryAfter('0'), undefined);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:30 GMT')), 30_000);
  });

  it('maps an error object to the status it stands for', () => {
    const st = (e: unknown) => statusForErrorEvent(parseErrorPayload(e));
    assert.equal(st({ error: { code: 'upstream_rate_limited' } }), 429);
    assert.equal(st({ error: { type: 'rate_limit_error' } }), 429);
    assert.equal(st({ error: { code: 'budget_exhausted' } }), 429);
    assert.equal(st({ error: { code: 'upstream_quota_exhausted' } }), 429);
    assert.equal(st({ error: { code: 'upstream_overloaded' } }), 503);
    assert.equal(st({ error: { code: 'node_unavailable' } }), 503);
    assert.equal(st({ error: { code: 'pacing_timeout' } }), 504);
    assert.equal(st({ error: { code: 'invalid_request_error' } }), 400);
    assert.equal(st({ error: { code: 'something_else', status: 429 } }), 429);
    assert.equal(st({ error: { code: 429 } }), 429);
    assert.equal(st({ error: { message: 'boom' } }), 502);
    assert.equal(st('boom'), 502);
  });

  it('reads retry_after_s from the error or beside it, and reset_at only for a failure that can wait it out', () => {
    assert.equal(parseErrorPayload({ error: { retry_after_s: 4 } }).retryAfterMs, 4000);
    assert.equal(parseErrorPayload({ error: { code: 'x' }, retry_after_s: 9 }).retryAfterMs, 9000);
    const at = new Date(Date.now() + 60_000).toISOString();
    assert.ok((parseErrorPayload({ error: { code: 'upstream_rate_limited', reset_at: at } }).retryAfterMs ?? 0) > 50_000);
    assert.equal(parseErrorPayload({ error: { code: 'budget_exhausted', reset_at: at } }).retryAfterMs, undefined);
  });
});
