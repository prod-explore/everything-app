import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server.js';
import type { Config } from '../config.js';
import type { SupervisorClient } from '../supervisor-client.js';

const config = { supervisorUrl: 'http://127.0.0.1:9', mcpPort: 0, sandboxTimeoutMs: 1000, apiKey: 'k'.repeat(32) } as Config;
const supervisor = { status: async () => ({ running: 0, maxRunning: 1 }) } as unknown as SupervisorClient;

async function withApp(limit: number | undefined, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await new Promise<import('node:http').Server>(r => { const s: import('node:http').Server = createApp(config, supervisor, { rateLimitPerMinute: limit }).listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.closeAllConnections(); server.close(); }
}

describe('rate limit', () => {
  it('answers 429 JSON with standard headers once a client exceeds the ceiling, before auth', async () => {
    await withApp(3, async base => {
      for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/mcp/health`)).status, 401);
      const r = await fetch(`${base}/mcp/health`, { headers: { authorization: `Bearer ${config.apiKey}` } });
      assert.equal(r.status, 429);
      assert.deepEqual(await r.json(), { error: 'Too many requests' });
      assert.ok(r.headers.get('retry-after'));
      assert.equal(r.headers.get('x-ratelimit-limit'), null);
    });
  });

  it('the default ceiling (600/min) leaves normal traffic alone', async () => {
    await withApp(undefined, async base => {
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`${base}/mcp/health`, { headers: { authorization: `Bearer ${config.apiKey}` } });
        assert.equal(r.status, 200);
        await r.arrayBuffer();
      }
      const r = await fetch(`${base}/mcp/health`, { headers: { authorization: `Bearer ${config.apiKey}` } });
      assert.match(r.headers.get('ratelimit') ?? '', /limit=600/);
    });
  });
});
