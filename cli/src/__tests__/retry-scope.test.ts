import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import type { RetryInfo } from '../providers/openai-compat.js';

const ok = { choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const req = (model: string) => ({ model, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }) as Llm.MessageCreateParamsNonStreaming;

async function setup(retryMin: number | null) {
  const db = openDb(':memory:');
  runMigrations(db);
  let chatCalls = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm', kind: 'chat' }] }), { status: 200 });
    chatCalls++;
    return chatCalls % 2 === 1
      ? new Response('busy', { status: 429, headers: { 'retry-after': '1' } })
      : new Response(JSON.stringify(ok), { status: 200 });
  }) as typeof fetch;
  const router = new ProviderRouter({ db, env: { KEY_VAULT_SECRET: 'z'.repeat(48) } as NodeJS.ProcessEnv, fetchImpl });
  router.catalog.create({ slug: 'p', label: 'P', baseUrl: 'https://p.example/v1', keyOptional: false, retryMin });
  router.saveKey('p', 'sk-test-key-00000000');
  await router.refreshModels('p');
  const seen: RetryInfo[] = [];
  router.onProviderRetry = i => seen.push(i);
  return { router, seen, calls: () => chatCalls };
}

describe('retry notices belong to the conversation that waits', () => {
  it('a chat turn carries its conversation id; housekeeping carries none', async () => {
    const { router, seen } = await setup(null);
    await router.clientFor('@p/m', { conversationId: 'conv-1' }).client.messages.create(req('@p/m'));
    assert.deepEqual(seen.map(i => i.conversationId), ['conv-1']);
    assert.equal(seen[0]!.status, 429);
    assert.equal(seen[0]!.delayMs, 1000);
  });

  it('housekeeping uses the quick policy and is not scoped to a chat', async () => {
    const { router, seen } = await setup(30);
    await router.clientFor('@p/m', { quickRetries: true }).client.messages.create(req('@p/m'));
    assert.equal(seen.length, 1);
    assert.equal('conversationId' in seen[0]!, false);
    assert.equal(seen[0]!.remainingMs, 0, 'count-based, not the provider window');
  });

  it('a provider window of 0 turns the automatic retries off for chat turns', async () => {
    const { router, seen, calls } = await setup(0);
    await assert.rejects(router.clientFor('@p/m', { conversationId: 'c' }).client.messages.create(req('@p/m')), /429/);
    assert.equal(calls(), 1);
    assert.equal(seen.length, 0);
  });
});
