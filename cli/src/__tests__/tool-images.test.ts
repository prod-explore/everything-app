import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { MAX_IMAGES_PER_RESULT, MAX_IMAGE_CHARS, pickImages, toolResultContent } from '../tool-images.js';
import { dropOldToolImages } from '../context.js';
import { runTurn, type LlmClient } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { toChatMessages, type MetaStore } from '../providers/openai-compat.js';

const png = (n = 'AAAA'): Llm.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: n } });
const shotResult = (id: string, data: string): Llm.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `shot ${id}` }, png(data)] });

describe('pickImages', () => {
  it('keeps PNG, JPEG, WebP and GIF, normalises image/jpg, and leaves out anything else with a note', () => {
    const { images, notes } = pickImages([
      { type: 'text' },
      { type: 'image', data: 'aa', mimeType: 'image/PNG' },
      { type: 'image', data: 'bb', mimeType: 'image/jpg' },
      { type: 'image', data: 'cc', mimeType: 'image/svg+xml' },
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'image', data: 'dd' },
    ]);
    assert.deepEqual(images, [{ mediaType: 'image/png', data: 'aa' }, { mediaType: 'image/jpeg', data: 'bb' }]);
    assert.equal(notes.length, 3);
    assert.match(notes.join('\n'), /svg\+xml/);
    assert.match(notes.join('\n'), /empty image/);
    assert.match(notes.join('\n'), /unknown/);
  });

  it('leaves out an oversized image and everything past the per-result cap', () => {
    const big = pickImages([{ type: 'image', data: 'x'.repeat(MAX_IMAGE_CHARS + 1), mimeType: 'image/png' }]);
    assert.equal(big.images.length, 0);
    assert.match(big.notes[0]!, /too large/);

    const many = pickImages(Array.from({ length: MAX_IMAGES_PER_RESULT + 3 }, () => ({ type: 'image', data: 'aa', mimeType: 'image/png' })));
    assert.equal(many.images.length, MAX_IMAGES_PER_RESULT);
    assert.equal(many.notes.length, 1); // one note, not one per extra image
  });
});

describe('toolResultContent', () => {
  it('is plain text without images and text-then-images with them', () => {
    assert.equal(toolResultContent('hi'), 'hi');
    assert.equal(toolResultContent('hi', []), 'hi');
    assert.deepEqual(toolResultContent('hi', [{ mediaType: 'image/jpeg', data: 'zz' }]), [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'zz' } },
    ]);
  });
});

describe('dropOldToolImages', () => {
  const history = (): Llm.MessageParam[] => [
    { role: 'user', content: [{ type: 'text', text: 'look' }, png('USER')] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'shot', input: {} }] },
    { role: 'user', content: [shotResult('a', 'A')] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'shot', input: {} }] },
    { role: 'user', content: [shotResult('b', 'B')] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'shot', input: {} }] },
    { role: 'user', content: [shotResult('c', 'C')] },
  ];
  const imageData = (m: Llm.MessageParam): string[] =>
    Array.isArray(m.content)
      ? m.content.flatMap(b => (b.type === 'tool_result' && Array.isArray(b.content) ? b.content : [b])).flatMap(b => (b.type === 'image' && b.source.type === 'base64' ? [b.source.data] : []))
      : [];

  it('keeps the newest two tool images, replaces older ones with a note, never touches the user\'s own image, and never mutates its input', () => {
    const input = history();
    const snapshot = JSON.stringify(input);
    const out = dropOldToolImages(input, 2);
    assert.equal(JSON.stringify(input), snapshot);
    assert.deepEqual(imageData(out[0]!), ['USER']);
    assert.deepEqual(imageData(out[2]!), []);
    assert.deepEqual(imageData(out[4]!), ['B']);
    assert.deepEqual(imageData(out[6]!), ['C']);
    const dropped = (out[2]!.content as Llm.ToolResultBlockParam[])[0]!.content as Array<{ type: string; text?: string }>;
    assert.equal(dropped[0]!.text, 'shot a'); // the tool's own text stays
    assert.match(dropped[1]!.text!, /dropped to save context/);
  });

  it('returns the very same array when there is nothing to drop', () => {
    const input = history().slice(4);
    assert.equal(dropOldToolImages(input, 2), input);
    const plain: Llm.MessageParam[] = [{ role: 'user', content: 'plain' }];
    assert.equal(dropOldToolImages(plain), plain);
  });
});

function connectionReturning(images: boolean, isError = false): McpConnectionLike {
  return {
    name: 'pw',
    async listTools() { return [{ name: 'browser_screenshot', description: 'shot', inputSchema: { type: 'object' } }]; },
    async callTool() {
      return { text: 'Screenshot of x', isError, ...(images ? { images: [{ mediaType: 'image/jpeg' as const, data: 'JPEGDATA' }] } : {}) };
    },
  };
}

function scripted(turns: number): LlmClient & { calls: Llm.MessageCreateParamsNonStreaming[] } {
  const calls: Llm.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const msg = (content: unknown[], stop: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Llm.Message;
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(JSON.parse(JSON.stringify(params)) as Llm.MessageCreateParamsNonStreaming);
        i++;
        return i <= turns ? msg([{ type: 'tool_use', id: `t${i}`, name: 'pw__browser_screenshot', input: {} }], 'tool_use') : msg([{ type: 'text', text: 'done' }], 'end_turn');
      },
    },
  };
}

describe('tool images in the tool loop', () => {
  const run = async (conn: McpConnectionLike, turns: number) => {
    const tools = new ToolRegistry(['browser_screenshot']);
    await tools.loadFrom([conn]);
    const llm = scripted(turns);
    const history = await runTurn({ llm, model: '@t/m', tools, systemPrompt: 's', confirm: async () => true }, [], 'show me');
    return { llm, history };
  };

  it('puts the picture into the tool_result (stored with the history) and the model gets it on the next request', async () => {
    const { llm, history } = await run(connectionReturning(true), 1);
    const stored = history.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))!;
    const block = (stored.content as Llm.ToolResultBlockParam[])[0]!;
    assert.ok(Array.isArray(block.content));
    assert.deepEqual((block.content as Llm.ContentBlockParam[]).map(b => b.type), ['text', 'image']);
    const second = llm.calls[1]!.messages.at(-1)!.content as Llm.ToolResultBlockParam[];
    assert.ok(JSON.stringify(second).includes('JPEGDATA'));
  });

  it('a result without pictures, or a failed call, stays plain text', async () => {
    const plain = await run(connectionReturning(false), 1);
    const a = (plain.history.find(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'))!.content as Llm.ToolResultBlockParam[])[0]!;
    assert.equal(typeof a.content, 'string');
    const failed = await run(connectionReturning(true, true), 1);
    const b = (failed.history.find(m => Array.isArray(m.content) && m.content.some(bl => bl.type === 'tool_result'))!.content as Llm.ToolResultBlockParam[])[0]!;
    assert.equal(typeof b.content, 'string');
  });

  it('keeps only the newest two screenshots in what is sent, though all of them stay in the history', async () => {
    const { llm, history } = await run(connectionReturning(true), 4);
    const lastRequest = JSON.stringify(llm.calls.at(-1)!.messages);
    assert.equal(lastRequest.split('JPEGDATA').length - 1, 2);
    assert.match(lastRequest, /dropped to save context/);
    assert.equal(JSON.stringify(history).split('JPEGDATA').length - 1, 4);
  });
});

describe('tool images on the OpenAI-compatible wire', () => {
  const meta: MetaStore = { get: () => null, set: () => {} };
  const names = { safe: (n: string) => n, original: (n: string) => n, size: 0, resolve: (n: string) => n };
  const ctx = (supportsImages: boolean) => ({ modelInfo: { id: 'm', supportsImages } as never, meta, names: names as never });
  const params = (): Llm.MessageCreateParamsNonStreaming => ({
    model: 'm',
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'show me' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'shot', input: {} }] },
      { role: 'user', content: [shotResult('c1', 'ZZZZ')] },
    ],
  });

  it('a model that can see gets the picture in a user message right after the tool message', () => {
    const out = toChatMessages(params(), ctx(true));
    const toolIdx = out.findIndex(m => m.role === 'tool');
    assert.match((out[toolIdx] as { content: string }).content, /shot c1\n\[image — attached in the next message\]/);
    const next = out[toolIdx + 1] as { role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> };
    assert.equal(next.role, 'user');
    assert.match(next.content[0]!.text!, /returned by the tool call/);
    assert.equal(next.content[1]!.image_url!.url, 'data:image/png;base64,ZZZZ');
  });

  it('a model that cannot see gets a note and no picture', () => {
    const out = toChatMessages(params(), ctx(false));
    const tool = out.find(m => m.role === 'tool') as { content: string };
    assert.match(tool.content, /image omitted/);
    assert.equal(out.at(-1)!.role, 'tool');
    assert.equal(JSON.stringify(out).includes('ZZZZ'), false);
  });
});
