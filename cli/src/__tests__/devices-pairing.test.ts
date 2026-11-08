import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as http from 'node:http';
import { openDb, runMigrations, createApprovalGrant, listApprovalGrants } from '../db.js';
import { PairingError, PairingManager, USER_CODE_ALPHABET, USER_CODE_RE } from '../devices/pairing.js';
import { DeviceStore, hashDeviceToken, migrateDevices, newDeviceToken, slugify } from '../devices/store.js';
import { createDeviceService } from '../devices/index.js';
import { ToolRegistry } from '../tool-registry.js';
import { listen } from './devices-fixture.js';

const req = { name: 'Desktop PC', platform: 'windows' as const, agentVersion: '0.1.0', ip: '10.0.0.1' };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('pairing manager (ADR 0018)', () => {
  it('start gives a code in the contract format, poll is pending until a person approves, and the token is delivered exactly once', () => {
    const c = clock();
    const m = new PairingManager({ now: c.now });
    const s = m.start(req);
    assert.match(s.userCode, USER_CODE_RE);
    for (const ch of s.userCode.replace('-', '')) assert.ok(USER_CODE_ALPHABET.includes(ch));
    assert.equal(s.deviceCode.length, 43);
    assert.equal(s.verificationPath, `/devices/pair?code=${s.userCode}`);
    assert.equal(s.expiresIn, 600);
    assert.equal(s.interval, 2);
    assert.deepEqual(m.poll(s.deviceCode), { status: 'pending' });
    assert.equal(m.view(s.userCode)?.ip, '10.0.0.1');
    assert.equal(m.view(s.userCode.toLowerCase())?.name, 'Desktop PC', 'the code is compared case-insensitively');

    const grant = m.approve(s.userCode, () => ({ deviceId: 'abcd', deviceToken: 'tok', connectionName: 'device-desktop-pc' }));
    assert.equal(grant?.deviceId, 'abcd');
    assert.deepEqual(m.poll(s.deviceCode), { status: 'approved', deviceId: 'abcd', deviceToken: 'tok', connectionName: 'device-desktop-pc' });
    assert.deepEqual(m.poll(s.deviceCode), { status: 'expired' }, 'the pairing is gone after the token was handed out');
    assert.equal(m.view(s.userCode), null);
    assert.equal(m.approve(s.userCode, () => { throw new Error('must not issue twice'); }), null);
  });

  it('a pairing expires after 10 minutes; an approved one nobody collected reports its orphan', () => {
    const c = clock();
    const orphans: string[] = [];
    const m = new PairingManager({ now: c.now, onUncollected: id => orphans.push(id) });
    const a = m.start(req);
    const b = m.start({ ...req, ip: '10.0.0.2' });
    m.approve(b.userCode, () => ({ deviceId: 'dev-b', deviceToken: 't', connectionName: 'device-x' }));
    c.advance(10 * 60 * 1000 - 1);
    assert.deepEqual(m.poll(a.deviceCode), { status: 'pending' });
    c.advance(1);
    assert.deepEqual(m.poll(a.deviceCode), { status: 'expired' });
    assert.equal(m.view(a.userCode), null);
    assert.deepEqual(orphans, ['dev-b']);
    assert.deepEqual(m.poll(b.deviceCode), { status: 'expired' });
  });

  it('deny answers the poll with denied once, and the code cannot be approved afterwards', () => {
    const m = new PairingManager();
    const s = m.start(req);
    assert.equal(m.deny(s.userCode), true);
    assert.equal(m.approve(s.userCode, () => { throw new Error('no'); }), null);
    assert.deepEqual(m.poll(s.deviceCode), { status: 'denied' });
    assert.deepEqual(m.poll(s.deviceCode), { status: 'expired' });
    assert.equal(m.deny(s.userCode), false);
  });

  it('an unknown device code is expired, not an error', () => {
    assert.deepEqual(new PairingManager().poll('nope'), { status: 'expired' });
  });

  it('allows 10 starts per minute per address (the 11th is refused, other addresses are not), and the window slides', () => {
    const c = clock();
    const m = new PairingManager({ now: c.now, maxPending: 100 });
    for (let i = 0; i < 10; i++) m.start(req);
    assert.throws(() => m.start(req), (e: unknown) => e instanceof PairingError && e.code === 'rate_limited');
    assert.doesNotThrow(() => m.start({ ...req, ip: '10.0.0.9' }));
    c.advance(61_000);
    assert.doesNotThrow(() => m.start(req));
  });

  it('holds at most 20 pending pairings', () => {
    const m = new PairingManager();
    for (let i = 0; i < 20; i++) m.start({ ...req, ip: `10.0.1.${i}` });
    assert.equal(m.pendingCount(), 20);
    assert.throws(() => m.start({ ...req, ip: '10.0.2.1' }), (e: unknown) => e instanceof PairingError && e.code === 'too_many_pending');
  });

  it('keeps no plaintext device code in memory', () => {
    const m = new PairingManager();
    const s = m.start(req);
    const dump = JSON.stringify([...(m as unknown as { byDevice: Map<string, unknown> }).byDevice.keys()]);
    assert.ok(!dump.includes(s.deviceCode));
  });
});

describe('device store: tokens and slugs', () => {
  const fresh = () => { const db = openDb(':memory:'); runMigrations(db); migrateDevices(db); return { db, store: new DeviceStore(db) }; };

  it('stores only the SHA-256 of the token and finds the device by it', () => {
    const { db, store } = fresh();
    const token = newDeviceToken();
    assert.equal(token.length, 43);
    const row = store.create({ name: 'PC', platform: 'linux', agentVersion: '1', tokenHash: hashDeviceToken(token) });
    assert.match(row.id, /^[0-9a-f]{16}$/);
    const raw = db.prepare(`SELECT * FROM devices`).all() as Array<Record<string, unknown>>;
    assert.equal(JSON.stringify(raw).includes(token), false);
    assert.equal(raw[0]!['token_hash'], hashDeviceToken(token));
    assert.equal(store.findByToken(token)?.id, row.id);
    assert.equal(store.findByToken(newDeviceToken()), null);
    assert.equal(store.findByToken(''), null);
  });

  it('slugs are [a-z0-9-], 1-24 characters, unique with -2, -3', () => {
    assert.equal(slugify('Mikołaj\'s Desktop PC!!'), 'mikolaj-s-desktop-pc');
    assert.equal(slugify('***'), 'device');
    assert.equal(slugify('a'.repeat(40)).length, 24);
    const { store } = fresh();
    const mk = (n: string) => store.create({ name: n, platform: 'linux', agentVersion: '1', tokenHash: hashDeviceToken(newDeviceToken()) }).slug;
    assert.equal(mk('PC'), 'pc');
    assert.equal(mk('pc'), 'pc-2');
    assert.equal(mk('PC'), 'pc-3');
    const long = 'x'.repeat(30);
    assert.equal(mk(long), 'x'.repeat(24));
    assert.equal(mk(long), `${'x'.repeat(22)}-2`);
  });

  it('migrating twice is harmless and a rename keeps the slug', () => {
    const { db, store } = fresh();
    migrateDevices(db);
    const row = store.create({ name: 'PC', platform: 'linux', agentVersion: '1', tokenHash: hashDeviceToken('t') });
    store.rename(row.id, 'Work laptop');
    assert.equal(store.get(row.id)?.slug, 'pc');
    assert.equal(store.get(row.id)?.name, 'Work laptop');
  });
});

describe('device REST API', () => {
  async function setup() {
    const db = openDb(':memory:');
    runMigrations(db);
    const registry = new ToolRegistry([]);
    const c = clock();
    const changes: string[] = [];
    const svc = createDeviceService({ db, registry, onChange: id => changes.push(id), pairing: { now: c.now } });
    const app = express();
    app.use(express.json());
    app.use('/api', svc.routes.public);
    // stand-in for the app's login: the authenticated router only sees requests that carry this header
    app.use('/api', (r, res, next) => (r.headers['x-test-auth'] === 'yes' ? next() : void res.status(401).json({ error: 'unauthorized' })));
    app.use('/api', svc.routes.api);
    const server = http.createServer(app);
    const port = await listen(server);
    const call = (method: string, path: string, body?: unknown, auth = true) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': 'yes' } : {}) } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }); });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
    return { db, svc, call, changes, clock: c, close: () => { server.closeAllConnections(); server.close(); } };
  }
  const start = { name: 'Desktop PC', platform: 'windows', agentVersion: '0.1.0' };

  it('pair start/poll are open; everything else needs the login', async () => {
    const t = await setup();
    try {
      assert.equal((await t.call('POST', '/api/devices/pair/start', start, false)).status, 200);
      assert.equal((await t.call('GET', '/api/devices', undefined, false)).status, 401);
      assert.equal((await t.call('POST', '/api/devices/pair/ABCD-EFGH/approve', {}, false)).status, 401);
    } finally { t.close(); }
  });

  it('validates the start request', async () => {
    const t = await setup();
    try {
      for (const bad of [{}, { ...start, name: '' }, { ...start, name: 'x'.repeat(41) }, { ...start, platform: 'amiga' }, { ...start, agentVersion: '' }, { ...start, name: 'a\u0007b' }]) {
        assert.equal((await t.call('POST', '/api/devices/pair/start', bad, false)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await t.call('POST', '/api/devices/pair/poll', {}, false)).status, 400);
    } finally { t.close(); }
  });

  it('full flow: start, poll pending, approve, poll delivers the token once, the token identifies the device', async () => {
    const t = await setup();
    try {
      const s = (await t.call('POST', '/api/devices/pair/start', start, false)).json;
      assert.deepEqual(Object.keys(s).sort(), ['deviceCode', 'expiresIn', 'interval', 'userCode', 'verificationPath']);
      assert.deepEqual((await t.call('POST', '/api/devices/pair/poll', { deviceCode: s.deviceCode }, false)).json, { status: 'pending' });

      const view = await t.call('GET', `/api/devices/pair/${s.userCode}`);
      assert.equal(view.status, 200);
      assert.deepEqual(Object.keys(view.json).sort(), ['agentVersion', 'createdAt', 'expiresAt', 'ip', 'name', 'platform', 'userCode']);
      assert.equal(view.json.name, 'Desktop PC');

      const approved = await t.call('POST', `/api/devices/pair/${s.userCode}/approve`, { name: 'Work PC' });
      assert.equal(approved.status, 200);
      assert.match(approved.json.deviceId, /^[0-9a-f]{16}$/);
      assert.deepEqual(t.changes, [approved.json.deviceId]);

      const poll = await t.call('POST', '/api/devices/pair/poll', { deviceCode: s.deviceCode }, false);
      assert.equal(poll.status, 200);
      assert.equal(poll.json.status, 'approved');
      assert.equal(poll.json.deviceId, approved.json.deviceId);
      assert.equal(poll.json.connectionName, 'device-work-pc');
      assert.equal(poll.json.deviceToken.length, 43);
      assert.equal(t.svc.store.findByToken(poll.json.deviceToken)?.id, approved.json.deviceId);

      const again = await t.call('POST', '/api/devices/pair/poll', { deviceCode: s.deviceCode }, false);
      assert.equal(again.status, 410);
      assert.equal(again.json.status, 'expired');

      const list = await t.call('GET', '/api/devices');
      assert.equal(list.json.devices.length, 1);
      const d = list.json.devices[0];
      assert.deepEqual(Object.keys(d).sort(), ['agentVersion', 'connectedAt', 'connectionName', 'createdAt', 'id', 'lastSeenAt', 'name', 'online', 'platform', 'policy', 'report', 'tools']);
      assert.equal(d.name, 'Work PC');
      assert.equal(d.online, false);
      assert.deepEqual(d.policy, { shell: 'allowlist', filesWrite: 'ask', browserAct: 'ask' });
      assert.equal(d.report, null);
      assert.deepEqual(d.tools, []);
    } finally { t.close(); }
  });

  it('deny answers the poll with 410 denied; unknown or expired codes are 404', async () => {
    const t = await setup();
    try {
      const s = (await t.call('POST', '/api/devices/pair/start', start, false)).json;
      assert.equal((await t.call('POST', `/api/devices/pair/${s.userCode}/deny`)).status, 200);
      const poll = await t.call('POST', '/api/devices/pair/poll', { deviceCode: s.deviceCode }, false);
      assert.deepEqual([poll.status, poll.json], [410, { status: 'denied' }]);
      assert.equal((await t.call('GET', `/api/devices/pair/${s.userCode}`)).status, 404);
      assert.equal((await t.call('POST', `/api/devices/pair/${s.userCode}/approve`, {})).status, 404);
      assert.equal((await t.call('GET', '/api/devices/pair/not-a-code')).status, 404);

      const s2 = (await t.call('POST', '/api/devices/pair/start', start, false)).json;
      t.clock.advance(11 * 60 * 1000);
      assert.equal((await t.call('GET', `/api/devices/pair/${s2.userCode}`)).status, 404);
      const expired = await t.call('POST', '/api/devices/pair/poll', { deviceCode: s2.deviceCode }, false);
      assert.deepEqual([expired.status, expired.json], [410, { status: 'expired' }]);
      assert.equal(t.svc.store.list().length, 0, 'nothing is created without an approval');
    } finally { t.close(); }
  });

  it('answers 429 after 10 starts per minute from one address', async () => {
    const t = await setup();
    try {
      for (let i = 0; i < 10; i++) assert.equal((await t.call('POST', '/api/devices/pair/start', start, false)).status, 200);
      const r = await t.call('POST', '/api/devices/pair/start', start, false);
      assert.equal(r.status, 429);
    } finally { t.close(); }
  });

  it('an approval nobody collected does not leave a device behind', async () => {
    const t = await setup();
    try {
      const s = (await t.call('POST', '/api/devices/pair/start', start, false)).json;
      await t.call('POST', `/api/devices/pair/${s.userCode}/approve`, {});
      assert.equal(t.svc.store.list().length, 1);
      t.clock.advance(11 * 60 * 1000);
      assert.equal((await t.call('GET', '/api/devices')).json.devices.length, 0);
    } finally { t.close(); }
  });

  it('PATCH changes the name and policy (validated); DELETE revokes the token and deletes only that device\'s grants', async () => {
    const t = await setup();
    try {
      const pair = async (name: string) => {
        const s = (await t.call('POST', '/api/devices/pair/start', { ...start, name }, false)).json;
        await t.call('POST', `/api/devices/pair/${s.userCode}/approve`, {});
        return (await t.call('POST', '/api/devices/pair/poll', { deviceCode: s.deviceCode }, false)).json;
      };
      const pc = await pair('pc');
      const pc2 = await pair('pc');
      assert.equal(pc2.connectionName, 'device-pc-2');

      const patched = await t.call('PATCH', `/api/devices/${pc.deviceId}`, { name: 'Renamed', policy: { shell: 'auto', filesWrite: 'auto' } });
      assert.equal(patched.status, 200);
      assert.equal(patched.json.name, 'Renamed');
      assert.equal(patched.json.connectionName, 'device-pc', 'the connection name does not follow the display name');
      assert.deepEqual(patched.json.policy, { shell: 'auto', filesWrite: 'auto', browserAct: 'ask' });
      for (const bad of [{ policy: { shell: 'yolo' } }, { policy: { filesWrite: 'allowlist' } }, { policy: { extra: 1 } }, { policy: 'auto' }, { name: '' }]) {
        assert.equal((await t.call('PATCH', `/api/devices/${pc.deviceId}`, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await t.call('PATCH', '/api/devices/0000000000000000', { name: 'x' })).status, 404);

      const grant = (label: string) => createApprovalGrant(t.db, { toolLabel: label, scope: 'always', subjectType: null, subjectId: null, conversationId: null, projectId: null, expiresAt: null });
      for (const l of ['device-pc/fs_write', 'cmd@device-pc:git push', 'device-pc-2/fs_write', 'cmd@device-pc-2:git push', 'cmd:git push', 'sandbox/run_bash', 'device-pcx/fs_write']) grant(l);

      assert.equal((await t.call('DELETE', `/api/devices/${pc.deviceId}`)).status, 200);
      assert.equal(t.svc.store.findByToken(pc.deviceToken), null, 'the token no longer identifies anything');
      assert.notEqual(t.svc.store.findByToken(pc2.deviceToken), null);
      assert.deepEqual(listApprovalGrants(t.db).map(g => g.toolLabel).sort(), ['cmd:git push', 'cmd@device-pc-2:git push', 'device-pc-2/fs_write', 'device-pcx/fs_write', 'sandbox/run_bash']);
      assert.equal((await t.call('DELETE', `/api/devices/${pc.deviceId}`)).status, 404);
    } finally { t.close(); }
  });
});
