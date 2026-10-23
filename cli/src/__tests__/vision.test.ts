import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import type { LlmClient } from '../llm-loop.js';
import { DescriptionCache, describeImages, withImageDescriptions, type Describer } from '../vision.js';
import { openDb, runMigrations } from '../db.js';
import { ProviderRouter } from '../providers/router.js';
import { setSlots } from '../slots.js';

const usage = { input_tokens: 1, output_tokens: 1 };
const reply = (text: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }) as unknown as Llm.Message;
const png = (n: string): Llm.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `data-${n}` } });
const user = (...content: Llm.ContentBlockParam[]): Llm.MessageParam => ({ role: 'user', content });
const textsOf = (m: Llm.MessageParam): string[] => (Array.isArray(m.content) ? m.content.flatMap(b => (b.type === 'text' ? [b.text] : [])) : []);

function describer(calls: string[], fail = false): Describer {
  return {
    model: '@eyes/seer',
    async describe(image) {
      const data = image.source.type === 'base64' ? image.source.data : image.source.url;
      calls.push(data);
      if (fail) throw new Error('vision model down');
      return `a picture of ${data}`;
    },
  };
}

describe('describeImages', () => {
  it('replaces each image by its description and says who looked', async () => {
    const calls: string[] = [];
    const out = await describeImages([user({ type: 'text', text: 'what is this?' }, png('cat'))], '@blind/wrapper', describer(calls), new DescriptionCache());
    const t = textsOf(out[0]!);
    assert.equal(t[0], 'what is this?');
    assert.match(t[1]!, /described by @eyes\/seer because @blind\/wrapper cannot read images/);
    assert.match(t[1]!, /a picture of data-cat/);
    assert.deepEqual(calls, ['data-cat']);
  });

  it('describes an image once, however often it appears and across calls', async () => {
    const calls: string[] = [];
    const cache = new DescriptionCache();
    const msgs = [user(png('a')), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }, user(png('a'), png('b'))];
    await describeImages(msgs, 't', describer(calls), cache);
    await describeImages(msgs, 't', describer(calls), cache);
    assert.deepEqual(calls.sort(), ['data-a', 'data-b']);
  });

  it('also reaches images inside tool results (a screenshot from the browser)', async () => {
    const out = await describeImages([user({ type: 'tool_result', tool_use_id: 'x', content: [png('shot')] })], 't', describer([]), new DescriptionCache());
    const block = (out[0]!.content as Llm.ContentBlockParam[])[0] as Llm.ToolResultBlockParam;
    assert.equal((block.content as Llm.TextBlockParam[])[0]!.type, 'text');
  });

  it('leaves the image as it is when it cannot be described, so the turn does not fail', async () => {
    const out = await describeImages([user(png('x'))], 't', describer([], true), new DescriptionCache());
    assert.equal((out[0]!.content as Llm.ContentBlockParam[])[0]!.type, 'image');
  });

  it('does not touch the stored messages', async () => {
    const msgs = [user(png('keep'))];
    await describeImages(msgs, 't', describer([]), new DescriptionCache());
    assert.equal((msgs[0]!.content as Llm.ContentBlockParam[])[0]!.type, 'image');
  });

  it('describes at most eight new images per request', async () => {
    const calls: string[] = [];
    await describeImages([user(...Array.from({ length: 12 }, (_, i) => png(String(i))))], 't', describer(calls), new DescriptionCache());
    assert.equal(calls.length, 8);
  });
});

describe('withImageDescriptions', () => {
  const seen: Llm.MessageCreateParamsNonStreaming[] = [];
  const inner: LlmClient = {
    messages: {
      async create(p) { seen.push(p); return reply('ok'); },
      stream(p) {
        seen.push(p);
        const ls: Array<(e: Llm.MessageStreamEvent) => void> = [];
        return { on(_e, l) { ls.push(l); return this; }, finalMessage: async () => reply('streamed') };
      },
    },
  };
  const params = (...content: Llm.ContentBlockParam[]): Llm.MessageCreateParamsNonStreaming => ({ model: 'm', max_tokens: 10, messages: [user(...content)] }) as never;

  it('passes a request without images through untouched', async () => {
    seen.length = 0;
    const p = params({ type: 'text', text: 'hi' });
    const c = withImageDescriptions(inner, 't', () => { throw new Error('must not look for eyes'); }, new DescriptionCache());
    await c.messages.create(p);
    assert.equal(seen[0], p);
  });

  it('rewrites images for create and for stream', async () => {
    seen.length = 0;
    const c = withImageDescriptions(inner, 't', () => describer([]), new DescriptionCache());
    await c.messages.create(params(png('1')));
    const s = c.messages.stream!(params(png('2')));
    s.on('streamEvent', () => {});
    assert.equal((await s.finalMessage()).content[0]!.type, 'text');
    for (const p of seen) assert.match(textsOf(p.messages[0]!)[0]!, /a picture of/);
  });

  it('sends the images as they are when no model can see', async () => {
    seen.length = 0;
    const c = withImageDescriptions(inner, 't', () => null, new DescriptionCache());
    await c.messages.create(params(png('z')));
    assert.equal((seen[0]!.messages[0]!.content as Llm.ContentBlockParam[])[0]!.type, 'image');
  });
});

describe('ProviderRouter: which model looks', () => {
  function setup() {
    const db = openDb(':memory:');
    runMigrations(db);
    const asked: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      asked.push({ url: String(url), body });
      const sawImage = JSON.stringify(body.messages).includes('image_url');
      const text = sawImage ? 'a lovely description' : 'plain answer';
      return new Response(JSON.stringify({ id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const router = new ProviderRouter({ db, env: {}, fetchImpl });
    const add = (slug: string, local: boolean, models: Record<string, Record<string, unknown>>) => {
      router.catalog.create({ slug, label: slug, baseUrl: `https://${slug}.example/v1`, keyOptional: true, local });
      for (const [id, f] of Object.entries(models)) router.catalog.addManual(slug, id, f as never);
    };
    add('blind', false, { wrapper: {} });
    add('eyes', false, { seer: { supportsImages: true }, free: { supportsImages: true, tags: ['free'] } });
    add('home', true, { tiny: {}, lseer: { supportsImages: true } });
    return { db, router, asked };
  }
  const ask = (router: ProviderRouter, model: string) =>
    router.clientFor(model).client.messages.create({ model, max_tokens: 20, messages: [user(png('p'), { type: 'text', text: 'look' })] });
  const sentTo = (asked: Array<{ url: string; body: any }>) => asked.map(a => `${new URL(a.url).host}:${a.body.model}`);

  it('a blind cloud model is helped by a free model that can see, and receives text', async () => {
    const { router, asked } = setup();
    await ask(router, '@blind/wrapper');
    const [looked, answered] = asked;
    assert.match(looked!.url, /eyes\.example/);
    assert.equal(looked!.body.model, 'free');
    assert.ok(JSON.stringify(looked!.body.messages).includes('image_url'));
    assert.ok(!JSON.stringify(answered!.body.messages).includes('image_url'));
    assert.match(JSON.stringify(answered!.body.messages), /a lovely description/);
  });

  it('the helper slot wins when it can see', async () => {
    const { router, db, asked } = setup();
    setSlots(db, { helper: '@eyes/seer' });
    await ask(router, '@blind/wrapper');
    assert.equal(sentTo(asked)[0], 'eyes.example:seer');
  });

  it('a local blind model is only ever helped by a local one: the image never leaves for the cloud', async () => {
    const { router, asked } = setup();
    await ask(router, '@home/tiny');
    assert.match(asked[0]!.url, /home\.example/);
    assert.equal(asked[0]!.body.model, 'lseer');
    assert.ok(!sentTo(asked).some(s => s.startsWith('eyes.example')));
  });

  it('a local blind model with no local eye gets no description and nothing goes to the cloud', async () => {
    const { router, asked } = setup();
    assert.ok(router.catalog.updateModel('@home/lseer', { enabled: false }));
    await ask(router, '@home/tiny');
    assert.ok(!sentTo(asked).some(s => s.startsWith('eyes.example')));
  });

  it('a model that can see is not interfered with', async () => {
    const { router, asked } = setup();
    await ask(router, '@eyes/seer');
    assert.equal(asked.length, 1);
    assert.ok(JSON.stringify(asked[0]!.body.messages).includes('image_url'));
  });
});
