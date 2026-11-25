import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { runTurn, UNREADABLE_TOOL_CALL, type LlmClient } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import { estimateTokens, fitToWindow, isUserTurn } from '../context.js';
import { classifyError } from '../providers/errors.js';
import { OpenAiCompatClient, ProviderHttpError, type MetaStore } from '../providers/openai-compat.js';
import { getModelInfo } from '../providers/registry.js';
import { openDb, runMigrations } from '../db.js';
import { ModelCatalog } from '../providers/catalog.js';
import { modelMetadataRefreshHours } from '../providers/router.js';
import { seedBuiltinCatalog } from './catalog-fixture.js';

seedBuiltinCatalog();

/** What MindGate sends for a refusal from agy-cli-wrapper: the upstream status is spelled inside the body. */
const GATE_400 = JSON.stringify({
  error: {
    message: 'agy: Prompt body is 435973 characters; maximum context length is 100000 tokens (400000 characters for this bridge). Compact the conversation.',
    type: 'invalid_request_error', code: 'context_length_exceeded', provider: 'agy', model: 'gemini-4-hydrogen', upstream_status: 400,
  },
});
const GATE_502_UNREADABLE = JSON.stringify({
  message: 'agy: The model produced an unparsable tool-call block (bad-json); nothing was executed. Try again.',
  type: 'server_error', code: 'upstream_error', provider: 'agy', model: 'gemini-4-hydrogen',
});

const memoryMeta = (): MetaStore => { const s = new Map<string, Record<string, unknown>>(); return { get: id => s.get(id) ?? null, set: (id, m) => void s.set(id, m) }; };

function message(content: Llm.ContentBlock[], stop: Llm.StopReason): Llm.Message {
  return { id: 'm', container: null, content, model: 'x', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message',
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null } } as unknown as Llm.Message;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Llm.ContentBlock;

/** Answers each request with the next step: a message, or an error to throw. */
function scripted(steps: Array<Llm.Message | Error>): LlmClient & { calls: Llm.MessageCreateParamsNonStreaming[] } {
  const calls: Llm.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const step = steps[i++];
        if (!step) throw new Error('script ran out');
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
}

const run = (llm: LlmClient, extra: Partial<Parameters<typeof runTurn>[0]> = {}, history: Llm.MessageParam[] = [], prompt = 'go') =>
  runTurn({ llm, model: '@t/m', tools: new ToolRegistry([]), systemPrompt: 'sys', confirm: async () => true, ...extra }, history, prompt);

const big = (n: number) => 'x'.repeat(n);
/** A history that is one single user turn: a question, then `steps` rounds of tool call and a large result. */
function oneLongTurn(steps: number, resultChars: number): Llm.MessageParam[] {
  const out: Llm.MessageParam[] = [{ role: 'user', content: 'research this' }];
  for (let i = 0; i < steps; i++) {
    out.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'web_fetch', input: { url: `https://e.test/${i}` } }] });
    out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(resultChars) }] });
  }
  return out;
}

describe('a refusal for size is not asked twice', () => {
  it("MindGate's `upstream_status` in the body is not mistaken for a complaint about streaming", async () => {
    let requests = 0;
    const f = (async () => { requests++; return new Response(GATE_400, { status: 400 }); }) as unknown as typeof fetch;
    const client = new OpenAiCompatClient({ baseUrl: 'https://gate.test/v1', apiKey: 'k', meta: memoryMeta(), modelInfo: id => getModelInfo(`@mindgate/${id}`), fetchImpl: f, sleep: async () => {} });
    const stream = client.messages.stream!({ model: 'flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, {});
    await assert.rejects(stream.finalMessage(), (e: unknown) => e instanceof ProviderHttpError && e.status === 400);
    assert.equal(requests, 1, 'one request: the plain-request fallback is for servers that cannot stream, not for oversize prompts');
  });

  it('a 400 that really says streaming is unsupported still falls back to a plain request', async () => {
    const bodies: Array<{ stream?: boolean }> = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { stream?: boolean };
      bodies.push(b);
      return b.stream ? new Response('{"error":"streaming is not supported"}', { status: 400 })
        : new Response(JSON.stringify({ id: 'x', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatClient({ baseUrl: 'https://s.test/v1', apiKey: 'k', meta: memoryMeta(), modelInfo: id => getModelInfo(`@mindgate/${id}`), fetchImpl: f, sleep: async () => {} });
    const res = await client.messages.stream!({ model: 'flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, {}).finalMessage();
    assert.equal(bodies.length, 2);
    assert.equal((res.content[0] as Llm.TextBlock).text, 'ok');
  });
});

describe('classifyError', () => {
  it('reads the limit from the gateway refusal', () => {
    const i = classifyError(new ProviderHttpError('mindgate', 400, GATE_400, { code: 'context_length_exceeded' }));
    assert.equal(i.kind, 'context_too_long');
    assert.equal(i.limit, 100000);
  });
  it('treats the wrapper\'s unparsable tool-call block as a malformed tool call, not as an outage', () => {
    const i = classifyError(new ProviderHttpError('mindgate', 502, GATE_502_UNREADABLE, { code: 'upstream_error' }));
    assert.equal(i.kind, 'tool_parse');
  });
});

describe('fitToWindow', () => {
  it('stubs old results first and leaves a request that already fits alone', () => {
    const small = oneLongTurn(2, 100);
    assert.equal(fitToWindow(small, 100_000), small);
    const view = fitToWindow(oneLongTurn(20, 40_000), 100_000);
    assert.ok(estimateTokens(view) <= 100_000 * 0.9);
  });

  it('cuts further when the weight is not in old tool results (the newest result, a huge user message)', () => {
    const history: Llm.MessageParam[] = [
      { role: 'user', content: 'first question' }, { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big(600_000) }] },
    ];
    const view = fitToWindow(history, 100_000);
    assert.ok(estimateTokens(view) <= 100_000 * 0.9, `still ${estimateTokens(view)} tokens`);
    assert.equal(view.at(-1)!.role, 'user');
  });
});

const refused = () => new ProviderHttpError('mindgate', 400, GATE_400, { code: 'context_length_exceeded' });
const callUnknownTool = () => message([{ type: 'tool_use', id: 'u1', name: 'nope', input: {} } as unknown as Llm.ContentBlock], 'tool_use');

describe('runTurn — a request refused as too long', () => {
  it('on the first step: reports the window the provider named and leaves the repeat (with a summary) to the caller', async () => {
    const llm = scripted([refused()]);
    const limits: number[] = [];
    await assert.rejects(run(llm, { onContextLimit: l => limits.push(l) }, oneLongTurn(3, 100).slice(0, -1)), (e: unknown) => e instanceof ProviderHttpError);
    assert.equal(llm.calls.length, 1, 'no second request from here');
    assert.deepEqual(limits, [100000]);
  });

  it('with the window known to the caller (the repeat), the first step is cut to it before it is sent', async () => {
    const llm = scripted([message([text('ok')], 'end_turn')]);
    const full = oneLongTurn(30, 30_000).slice(0, -1);
    await run(llm, { contextWindow: 100_000 }, full);
    assert.ok(estimateTokens(llm.calls[0]!.messages) <= 100_000 * 0.9);
  });

  it('on a later step: cuts the view down, asks once more, and uses the named window from then on', async () => {
    const sizes: number[] = [];
    const steps: Array<Llm.Message | Error> = [callUnknownTool(), refused(), callUnknownTool(), message([text('done')], 'end_turn')];
    let i = 0;
    const llm: LlmClient = { messages: { async create(params) { sizes.push(estimateTokens(params.messages)); const s = steps[i++]!; if (s instanceof Error) throw s; return s; } } };
    const limits: number[] = [];
    await run(llm, { onContextLimit: l => limits.push(l) }, oneLongTurn(14, 50_000).slice(0, -1));
    assert.equal(sizes.length, 4, 'the refused request was repeated once, nothing more');
    assert.deepEqual(limits, [100000]);
    assert.ok(sizes[2]! < sizes[1]!, 'the repeat is smaller than the refused request');
    assert.ok(sizes[3]! <= 100_000 * 0.9, 'later steps already fit the named window');
  });

  it('is not retried when shrinking cannot make the request smaller', async () => {
    const llm = scripted([callUnknownTool(), refused()]);
    await assert.rejects(run(llm), (e: unknown) => e instanceof ProviderHttpError);
    assert.equal(llm.calls.length, 2);
  });
});

describe('runTurn — a tool call the gateway could not read', () => {
  it('keeps the turn: records the failed call, tells the model, and carries on', async () => {
    const llm = scripted([
      new ProviderHttpError('mindgate', 502, GATE_502_UNREADABLE, { code: 'upstream_error' }),
      message([text('second try')], 'end_turn'),
    ]);
    const results: Array<[string, boolean]> = [];
    const history = await run(llm, { onToolResult: (name, _f, _t, err) => results.push([name, err]) });
    assert.equal(llm.calls.length, 2);
    const assistant = history.at(-3)!; // what the next request carried: the failed call, then the notice, then the new reply
    const result = history.at(-2)!;
    assert.ok(Array.isArray(assistant.content) && assistant.content.some(b => b.type === 'tool_use' && b.name === UNREADABLE_TOOL_CALL));
    assert.ok(Array.isArray(result.content) && result.content[0]!.type === 'tool_result' && (result.content[0] as Llm.ToolResultBlockParam).is_error === true);
    assert.equal(isUserTurn(result), false, 'the notice is not a turn the person started, so compaction never cuts at it');
    assert.deepEqual(results, [[UNREADABLE_TOOL_CALL, true]]);
    assert.equal(((history.at(-1) as Llm.MessageParam).content as Llm.ContentBlockParam[])[0]!.type, 'text');
  });

  it('gives up after two unreadable replies in a row, and the count starts over after a good one', async () => {
    const bad = () => new ProviderHttpError('mindgate', 502, GATE_502_UNREADABLE, { code: 'upstream_error' });
    const llm = scripted([bad(), bad(), bad()]);
    await assert.rejects(run(llm), (e: unknown) => e instanceof ProviderHttpError);
    assert.equal(llm.calls.length, 3);
  });
});

describe('model catalog — what a provider reports', () => {
  const fresh = () => { const db = openDb(':memory:'); runMigrations(db); const c = new ModelCatalog(db, {}); c.create({ slug: 'gate', label: 'Gate', baseUrl: 'https://g.test/v1', keyOptional: true }); return c; };

  it('refreshReported updates what existing models report and never adds, enables or removes a model', () => {
    const c = fresh();
    c.applyDiscovered('gate', [{ id: 'agy/a' }, { id: 'agy/b' }]);
    assert.equal(c.providerModels('gate').find(m => m.upstream === 'agy/a')!.contextLength, undefined);
    const n = c.refreshReported('gate', [{ id: 'agy/a', context_length: 100000 }, { id: 'agy/new', context_length: 5 }]);
    assert.equal(n, 1);
    const models = c.providerModels('gate');
    assert.equal(models.find(m => m.upstream === 'agy/a')!.contextLength, 100000);
    assert.deepEqual(models.map(m => m.upstream).sort(), ['agy/a', 'agy/b']);
    assert.equal(c.refreshReported('gate', [{ id: 'agy/a', context_length: 100000 }]), 0, 'nothing changed, nothing written');
  });

  it('learnContextLength fills a missing window, yields to a reported or user-set one, and is replaced by the next discovery', () => {
    const c = fresh();
    c.applyDiscovered('gate', [{ id: 'agy/a' }, { id: 'agy/b', context_length: 64000 }]);
    assert.equal(c.learnContextLength('@gate/agy/a', 100000), true);
    assert.equal(c.providerModels('gate').find(m => m.upstream === 'agy/a')!.contextLength, 100000);
    assert.equal(c.learnContextLength('@gate/agy/b', 100000), false, 'a reported window wins');
    assert.equal(c.learnContextLength('@gate/agy/a', 50), false, 'an implausible figure is ignored');
    assert.equal(c.learnContextLength('@gate/missing', 100000), false);
    c.applyDiscovered('gate', [{ id: 'agy/a', context_length: 120000 }, { id: 'agy/b', context_length: 64000 }]);
    assert.equal(c.providerModels('gate').find(m => m.upstream === 'agy/a')!.contextLength, 120000);
  });

  it('MODEL_METADATA_REFRESH_HOURS: 6 by default, 0 switches it off, junk falls back to the default', () => {
    assert.equal(modelMetadataRefreshHours({}), 6);
    assert.equal(modelMetadataRefreshHours({ MODEL_METADATA_REFRESH_HOURS: '0' }), 0);
    assert.equal(modelMetadataRefreshHours({ MODEL_METADATA_REFRESH_HOURS: '12' }), 12);
    assert.equal(modelMetadataRefreshHours({ MODEL_METADATA_REFRESH_HOURS: 'soon' }), 6);
    assert.equal(modelMetadataRefreshHours({ MODEL_METADATA_REFRESH_HOURS: '-1' }), 6);
  });
});
