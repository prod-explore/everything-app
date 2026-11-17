import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { HELPER_COOLDOWN_MS, backgroundModel, fallbackTitle, generateTitle, helperParked, noteHelperFailure } from '../background.js';
import { truncateToolOutput } from '../output-truncator.js';
import { openDb, runMigrations } from '../db.js';
import { generateDailySummary } from '../gazeta.js';
import { createGazetaItem } from '../db.js';
import { setSlots } from '../slots.js';
import type { ProviderRouter } from '../providers/router.js';

const usage = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const reply = (t: string) => ({ id: 'm', content: [{ type: 'text', text: t, citations: null }], model: 'm', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;

describe('background (free tier) calls', () => {
  it('cleans the generated title and reports usage', async () => {
    let used = 0;
    const bg = { model: 'f', provider: 'gemini', client: { messages: { create: async () => reply('"Fix login redirect bug."\nextra') } } } as any;
    assert.equal(await generateTitle(bg, 'my login redirects wrongly', 'Check the callback URL', () => used++), 'Fix login redirect bug');
    assert.equal(used, 1);
  });

  it('picks the helper slot, else the first usable free model — never a paid one', () => {
    const db = openDb(':memory:'); runMigrations(db);
    const model = (id: string, tags: string[]) => ({ id, tags, kind: 'chat' });
    const router = (models: Array<{ id: string; tags: string[]; kind: string }>, ok: (id: string) => boolean) =>
      ({ chatCandidates: () => models, isAvailable: ok, clientFor: (id: string) => ({ provider: 'x', info: {}, client: {}, id }) }) as unknown as ProviderRouter;
    const paid = model('@p/paid', ['reasoning']);
    const free = model('@p/free', ['free']);
    assert.equal(backgroundModel(db, router([paid], () => true)), null, 'a paid model must not be used for housekeeping');
    assert.equal(backgroundModel(db, router([free], () => false)), null, 'no usable model → null');
    assert.equal(backgroundModel(db, router([paid, free], () => true))?.model, '@p/free');
    setSlots(db, { helper: '@p/paid' });
    assert.equal(backgroundModel(db, router([paid, free], () => true))?.model, '@p/paid', 'an explicit helper slot wins');
  });

  it('a failed title call returns null, parks the helper for a few minutes, and releases it afterwards', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    const free = { id: '@p/offline', tags: ['free'], kind: 'chat' };
    const calls: unknown[] = [];
    const router = { chatCandidates: () => [free], isAvailable: () => true, clientFor: (id: string, use: unknown) => (calls.push(use), { provider: 'x', info: {}, client: {}, id }) } as unknown as ProviderRouter;
    const bg = backgroundModel(db, router)!;
    assert.deepEqual(calls, [{ quickRetries: true }], 'housekeeping asks for the quick retry policy');
    const down = { ...bg, client: { messages: { create: async () => { throw new Error('503 node_unavailable'); } } } } as any;
    assert.equal(await generateTitle(down, 'hello there', 'hi'), null);
    assert.equal(helperParked('@p/offline'), true);
    assert.equal(backgroundModel(db, router), null, 'no new attempt while it is parked');
    assert.equal(helperParked('@p/offline', Date.now() + HELPER_COOLDOWN_MS + 1), false);
    noteHelperFailure('@p/other', 0);
    assert.equal(helperParked('@p/other'), false, 'a stale entry expires');
  });

  it('fallbackTitle: the first 8 words of the message, without markup or trailing punctuation', () => {
    assert.equal(fallbackTitle('How do I configure nginx to proxy websockets to a node backend on the same host?'), 'How do I configure nginx to proxy websockets');
    assert.equal(fallbackTitle('  **Fix** the login redirect bug!!  '), 'Fix the login redirect bug');
    assert.equal(fallbackTitle('Short one.'), 'Short one');
    assert.equal(fallbackTitle('x'.repeat(100)).length, 60);
    assert.equal(fallbackTitle('   '), 'New conversation');
    assert.ok(fallbackTitle('a '.repeat(30)).split(' ').length <= 8);
  });

  it('digest reports usage and stores the summary', async () => {
    const db = openDb(':memory:'); runMigrations(db);
    createGazetaItem(db, { type: 'report', title: 'R1', description: 'x' });
    let used = 0;
    const id = await generateDailySummary(db, { messages: { create: async () => reply('Digest!') } } as any, 'f', () => used++);
    assert.ok(id); assert.equal(used, 1);
  });

  it('tool output cap defaults to 12k and keeps head and tail', () => {
    const r = truncateToolOutput('a'.repeat(5000) + 'MID' + 'b'.repeat(50_000));
    assert.ok(r.wasTruncated && r.truncated.length < 12_100);
    assert.ok(r.truncated.startsWith('aaaa') && r.truncated.endsWith('bbbb'));
  });
});
