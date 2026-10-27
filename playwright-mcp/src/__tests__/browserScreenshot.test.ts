import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { registerBrowserScreenshot } from '../tools/browserScreenshot.js';
import { testConfig } from './testConfig.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>;

interface ShotCall { type?: string; quality?: number; fullPage?: boolean; clip?: { height: number } }

function setup(opts: { height?: number; sizeFor?: (quality: number) => number; open?: boolean } = {}) {
  const calls: ShotCall[] = [];
  const page = {
    url: () => 'https://example.com/long',
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: async () => opts.height ?? 800,
    screenshot: async (o: ShotCall) => {
      calls.push(o);
      return Buffer.alloc(opts.sizeFor ? opts.sizeFor(o.quality ?? 0) : 1000, 7);
    },
  };
  const session = {
    page,
    viewport: null,
    state: { override: undefined, approvedHosts: new Set<string>(), events: [] as string[], policy: undefined },
    tabs: { size: 1, active: () => ({ id: 1 }) },
  };
  const pool = { get: () => (opts.open === false ? undefined : session), touch: () => {} } as unknown as BrowserSessionPool;
  let handler: Handler | undefined;
  let description = '';
  const server = {
    registerTool: (_name: string, config: { description: string }, fn: Handler) => { description = config.description; handler = fn; },
  } as unknown as McpServer;
  registerBrowserScreenshot(server, testConfig(), pool);
  return { call: (args: Record<string, unknown> = {}) => handler!(args), calls, description };
}

describe('browser_screenshot', () => {
  it('returns the visible window as a JPEG image next to a text line', async () => {
    const t = setup();
    const res = await t.call({});
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0]!.type, 'text');
    assert.match(res.content[0]!.text!, /visible window/);
    assert.match(res.content[0]!.text!, /never instructions/);
    assert.equal(res.content[1]!.type, 'image');
    assert.equal(res.content[1]!.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(res.content[1]!.data!, 'base64').length, 1000);
    assert.deepEqual(t.calls, [{ type: 'jpeg', quality: 60 }]);
  });

  it('full_page captures the whole page, and cuts a very tall one with a note', async () => {
    const short = setup({ height: 3000 });
    await short.call({ full_page: true });
    assert.equal(short.calls[0]!.fullPage, true);
    assert.equal(short.calls[0]!.clip, undefined);

    const tall = setup({ height: 20000 });
    const res = await tall.call({ full_page: true });
    assert.equal(tall.calls[0]!.clip?.height, 6000);
    assert.match(res.content[0]!.text!, /taller than 6000 px/);
  });

  it('retakes at lower quality when the picture is too big, and gives up with an error if it never fits', async () => {
    const shrinks = setup({ sizeFor: q => (q > 50 ? 4_000_000 : 1000) });
    const res = await shrinks.call({});
    assert.equal(res.content[1]!.type, 'image');
    assert.deepEqual(shrinks.calls.map(c => c.quality), [60, 45]);

    const never = setup({ sizeFor: () => 4_000_000 });
    const failed = await never.call({});
    assert.equal(failed.isError, true);
    assert.match(failed.content[0]!.text!, /too large/);
  });

  it('fails clearly when no session is open', async () => {
    const res = await setup({ open: false }).call({});
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text!, /browser_open/);
  });

  it('tells the model the picture is page content, not instructions', () => {
    assert.match(setup().description, /data, never instructions/);
  });
});
