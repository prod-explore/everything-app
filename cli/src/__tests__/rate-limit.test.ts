import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../server.js';
import { openDb, runMigrations } from '../db.js';

const TOKEN = 'rl-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const listen = (b: BuiltApp) => new Promise<http.Server>(r => { const s: http.Server = b.app.listen(0, '127.0.0.1', () => r(s)); });

describe('API rate limit', () => {
  let db: ReturnType<typeof openDb>; let db2: ReturnType<typeof openDb>;
  let tight: BuiltApp; let tightServer: http.Server; let tightBase: string;
  let normal: BuiltApp; let normalServer: http.Server; let normalBase: string;

  before(async () => {
    db = openDb(':memory:'); runMigrations(db);
    db2 = openDb(':memory:'); runMigrations(db2);
    const common = { db, connections: [], authToken: TOKEN, config: { model: '@test/model-a', autoApproveTools: [] }, scheduler: { autostart: false } };
    tight = await buildApp({ ...common, rateLimit: { limit: 5 } });
    tightServer = await listen(tight);
    tightBase = `http://127.0.0.1:${(tightServer.address() as AddressInfo).port}`;
    normal = await buildApp({ ...common, db: db2 });
    normalServer = await listen(normal);
    normalBase = `http://127.0.0.1:${(normalServer.address() as AddressInfo).port}`;
  });
  after(() => { tight.stop(); normal.stop(); tightServer.closeAllConnections(); normalServer.closeAllConnections(); tightServer.close(); normalServer.close(); db.close(); db2.close(); });

  it('answers 429 with the app\'s { error } shape and standard headers once a client exceeds the limit', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${tightBase}/api/settings`, { headers: auth })).status, 200, `request ${i + 1}`);
    const r = await fetch(`${tightBase}/api/settings`, { headers: auth });
    assert.equal(r.status, 429);
    assert.match(String((await r.json() as { error: string }).error), /too many requests/);
    assert.ok(r.headers.get('retry-after'));
    assert.ok(r.headers.get('ratelimit') || r.headers.get('ratelimit-policy'), 'standard RateLimit headers');
    assert.equal(r.headers.get('x-ratelimit-limit'), null, 'no legacy headers');
  });

  it('covers unauthenticated paths and the web app files too, but not /health', async () => {
    assert.equal((await fetch(`${tightBase}/api/settings`)).status, 429, 'limit is checked before auth');
    assert.equal((await fetch(`${tightBase}/some/page`)).status, 429, 'the web app files share the same per-IP budget');
    assert.equal((await fetch(`${tightBase}/health`)).status, 200);
  });

  it('the default ceiling never bothers a normal owner session', async () => {
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${normalBase}/api/settings`, { headers: auth });
      assert.equal(r.status, 200, `request ${i + 1}`);
      await r.arrayBuffer();
    }
    assert.match(String((await fetch(`${normalBase}/api/settings`, { headers: auth })).headers.get('ratelimit') ?? ''), /limit=1200/);
  });
});
