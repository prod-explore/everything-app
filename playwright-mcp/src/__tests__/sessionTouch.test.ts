import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from 'playwright';
import { createApp } from '../server.js';
import { BrowserSessionPool, type ContextLauncher } from '../sessionPool.js';
import { testConfig } from './testConfig.js';

function fakeLauncher(): ContextLauncher {
  return {
    async launch() {
      const context = {
        on: () => {},
        close: async () => {},
      } as unknown as BrowserContext;
      const page = { on: () => {} } as unknown as Page;
      return { context, page };
    },
  };
}

function makeTestPool(): BrowserSessionPool {
  return new BrowserSessionPool({
    maxSessions: 4,
    idleTimeoutMs: 1_000,
    watchdogIntervalMs: 120_000,
    makeLauncher: () => fakeLauncher(),
  });
}

async function withTouchApp(
  pool: BrowserSessionPool,
  fn: (base: string, apiKey: string) => Promise<void>,
): Promise<void> {
  const config = testConfig();
  const server = await new Promise<import('node:http').Server>(resolve => {
    const s: import('node:http').Server = createApp(config, { pool }).app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, config.apiKey);
  } finally {
    pool.stopWatchdog();
    server.closeAllConnections();
    server.close();
  }
}

describe('POST /mcp/browser-sessions/:id/touch', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const pool = makeTestPool();
    await withTouchApp(pool, async base => {
      const res = await fetch(`${base}/mcp/browser-sessions/conv-1/touch`, { method: 'POST' });
      assert.equal(res.status, 401);
    });
  });

  it('rejects requests with the wrong bearer key with 403', async () => {
    const pool = makeTestPool();
    await withTouchApp(pool, async base => {
      const res = await fetch(`${base}/mcp/browser-sessions/conv-1/touch`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-key' },
      });
      assert.equal(res.status, 403);
    });
  });

  it('returns 200 { ok: true, touched: false } when no session is open', async () => {
    const pool = makeTestPool();
    await withTouchApp(pool, async (base, apiKey) => {
      const res = await fetch(`${base}/mcp/browser-sessions/missing-conv/touch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, touched: false });
    });
  });

  it('returns 200 { ok: true, touched: true } and renews lastActivityAt when a session exists', async () => {
    const pool = makeTestPool();
    const { session } = await pool.claim('conv-active');
    session.lastActivityAt = new Date(Date.now() - 5_000);

    await withTouchApp(pool, async (base, apiKey) => {
      const res = await fetch(`${base}/mcp/browser-sessions/conv-active/touch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, touched: true });
      assert.ok(Date.now() - session.lastActivityAt.getTime() < 500);
    });
  });
});
