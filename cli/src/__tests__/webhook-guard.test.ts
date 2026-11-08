import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, runMigrations } from '../db.js';
import { KeyVault } from '../providers/key-vault.js';
import { Notifier, NotifyConfigError, NOTIFY_VAULT_KEY } from '../notifier.js';
import { assertSafeWebhookTarget, classifyAddress, guardedPost, WebhookBlockedError, type AddressClass } from '../webhook-guard.js';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const dns = (...addrs: string[]) => async () => addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('classifyAddress', () => {
  const cases: Array<[string, AddressClass]> = [
    ['127.0.0.1', 'loopback'], ['127.8.8.8', 'loopback'], ['::1', 'loopback'],
    ['169.254.169.254', 'link-local'], ['169.254.0.1', 'link-local'], ['fe80::1', 'link-local'], ['febf::1', 'link-local'],
    ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'], ['::', 'unspecified'],
    ['10.0.0.5', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.20', 'private'], ['fd12:3456::1', 'private'], ['fc00::1', 'private'],
    ['100.64.0.1', 'cgnat'], ['100.127.255.255', 'cgnat'],
    ['224.0.0.1', 'reserved'], ['255.255.255.255', 'reserved'], ['ff02::1', 'reserved'], ['192.0.2.1', 'reserved'], ['2001:db8::1', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:169.254.169.254', 'link-local'], ['::ffff:10.0.0.1', 'private'], ['::ffff:a9fe:a9fe', 'link-local'],
    ['64:ff9b::7f00:1', 'loopback'], ['2002:7f00:1::', 'loopback'], ['::127.0.0.1', 'loopback'],
    ['93.184.216.34', 'public'], ['8.8.8.8', 'public'], ['172.32.0.1', 'public'], ['100.128.0.1', 'public'], ['2606:4700::1111', 'public'], ['::ffff:8.8.8.8', 'public'],
    ['not-an-ip', 'reserved'], ['999.1.1.1', 'reserved'],
  ];
  for (const [ip, want] of cases) it(`${ip} -> ${want}`, () => assert.equal(classifyAddress(ip), want));
});

describe('assertSafeWebhookTarget', () => {
  const blocked = (url: string, opts = {}, pattern?: RegExp) =>
    assert.rejects(assertSafeWebhookTarget(url, { resolve: dns('93.184.216.34'), ...opts }), (e: Error) => e instanceof WebhookBlockedError && (!pattern || pattern.test(e.message)));

  it('refuses other schemes, junk and credentials', async () => {
    await blocked('ftp://ntfy.sh/x', {}, /http/);
    await blocked('file:///etc/passwd', {}, /http/);
    await blocked('nope', {}, /valid URL/);
    await blocked('https://user:pw@ntfy.sh/x', {}, /credentials/);
  });

  it('refuses IP literals of every blocked class, IPv4 and IPv6 including mapped', async () => {
    for (const u of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/x', 'http://0.0.0.0/x', 'http://[::]/x',
      'http://10.1.2.3/x', 'http://192.168.0.5:8080/x', 'http://172.20.0.2/x', 'http://[fd00::1]/x', 'http://100.100.1.1/x',
      'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:169.254.169.254]/x', 'http://[::ffff:10.0.0.1]/x', 'http://2130706433/x', 'http://0x7f.1/x']) {
      await blocked(u);
    }
  });

  it('refuses names that resolve to a blocked address, and mixed answers', async () => {
    await blocked('https://evil.example/x', { resolve: dns('127.0.0.1') }, /loopback/);
    await blocked('https://evil.example/x', { resolve: dns('169.254.169.254') }, /metadata/);
    await blocked('https://evil.example/x', { resolve: dns('192.168.1.5') }, /NOTIFY_ALLOW_PRIVATE_NETWORK/);
    await blocked('https://evil.example/x', { resolve: dns('93.184.216.34', '10.0.0.1') });
    await blocked('https://evil.example/x', { resolve: dns('::ffff:7f00:1') });
    await blocked('https://evil.example/x', { resolve: dns() }, /resolve/);
    await blocked('https://evil.example/x', { resolve: async () => { throw new Error('ENOTFOUND'); } }, /resolve/);
  });

  it('allows a public host (stubbed resolver)', async () => {
    const u = await assertSafeWebhookTarget('https://ntfy.sh/topic', { resolve: async () => PUBLIC });
    assert.equal(u.hostname, 'ntfy.sh');
    await assertSafeWebhookTarget('https://v6.example/x', { resolve: dns('2606:4700::1111') });
  });

  it('opt-in allows private, unique-local and CGNAT targets, but never loopback, link-local or unspecified', async () => {
    const on = { allowPrivateNetwork: true };
    await assertSafeWebhookTarget('http://192.168.1.20:8080/ea', on);
    await assertSafeWebhookTarget('http://ntfy.lan/ea', { ...on, resolve: dns('10.0.0.7') });
    await assertSafeWebhookTarget('http://nas/ea', { ...on, resolve: dns('fd12::5') });
    await assertSafeWebhookTarget('http://100.101.102.103/ea', on);
    for (const u of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/x', 'http://[fe80::1]/x', 'http://0.0.0.0/x', 'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:169.254.169.254]/x']) {
      await blocked(u, on);
    }
    await blocked('http://sneaky.example/x', { ...on, resolve: dns('10.0.0.7', '127.0.0.1') });
  });
});

describe('guardedPost connects only to vetted addresses', () => {
  const listen = () => new Promise<{ server: http.Server; port: number; hits: number[] }>(resolve => {
    const hits: number[] = [];
    const server = http.createServer((req, res) => { hits.push(1); req.resume(); res.writeHead(204).end(); });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, hits }));
  });
  const req = { headers: { 'Content-Type': 'text/plain' }, body: 'hi' };

  it('DNS rebinding: public at check time, loopback at connect time -> refused, nothing is sent', async () => {
    const { server, port, hits } = await listen();
    try {
      let calls = 0;
      // 1st answer (the pre-flight) is public, every later one (the socket's own lookup) is the local server.
      const resolve = async () => (calls++ === 0 ? PUBLIC : [{ address: '127.0.0.1', family: 4 }]);
      await assert.rejects(guardedPost(`http://rebind.example:${port}/hook`, req, { resolve }), (e: Error) => /loopback/.test(e.message));
      assert.equal(calls, 2, 'the address was checked again at connect time');
      assert.equal(hits.length, 0, 'the local server never saw a request');
    } finally { server.close(); }
  });

  it('the opt-in does not unlock loopback even if the name resolves there', async () => {
    const { server, port, hits } = await listen();
    try {
      await assert.rejects(guardedPost(`http://local.example:${port}/hook`, req, { allowPrivateNetwork: true, resolve: dns('127.0.0.1') }), /loopback/);
      assert.equal(hits.length, 0);
    } finally { server.close(); }
  });
});

describe('Notifier integration', () => {
  function make(env: NodeJS.ProcessEnv, resolve: () => Promise<Array<{ address: string; family: number }>>) {
    const db = openDb(':memory:'); runMigrations(db);
    const vault = new KeyVault(db, 'k'.repeat(40));
    const sent: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response('ok'); }) as typeof fetch;
    return { n: new Notifier({ db, vault, env, fetchImpl, resolve }), vault, sent };
  }
  const payload = { title: 'T', message: 'M', priority: 3 };

  it('checkUrl (used when saving) explains why a URL is refused', async () => {
    const { n } = make({}, dns('192.168.1.9'));
    await assert.rejects(n.checkUrl('http://ntfy.lan/ea'), (e: Error) => e instanceof NotifyConfigError && /NOTIFY_ALLOW_PRIVATE_NETWORK/.test(e.message));
    await assert.rejects(n.checkUrl('http://127.0.0.1:8080/ea'), /loopback/);
    await assert.rejects(n.checkUrl('https://u:p@ntfy.sh/x'), /credentials/);
    assert.equal(await make({}, async () => PUBLIC).n.checkUrl(' https://ntfy.sh/abc '), 'https://ntfy.sh/abc');
  });

  it('checkUrl honours NOTIFY_ALLOW_PRIVATE_NETWORK', async () => {
    const { n } = make({ NOTIFY_ALLOW_PRIVATE_NETWORK: 'true' }, dns('192.168.1.9'));
    assert.equal(await n.checkUrl('http://ntfy.lan/ea'), 'http://ntfy.lan/ea');
    await assert.rejects(n.checkUrl('http://169.254.169.254/x'), /metadata/);
  });

  it('send re-validates even for a stored or env URL, and reports the reason', async () => {
    const { n, vault, sent } = make({}, dns('10.0.0.2'));
    vault.set(NOTIFY_VAULT_KEY, 'http://ntfy.lan/ea');
    await assert.rejects(n.send(payload), /private network/);
    assert.equal(sent.length, 0);
    assert.match(n.lastError ?? '', /Could not deliver/);

    const ok = make({}, async () => PUBLIC);
    ok.vault.set(NOTIFY_VAULT_KEY, 'https://ntfy.sh/ea');
    await ok.n.send(payload);
    assert.deepEqual(ok.sent, ['https://ntfy.sh/ea']);
  });
});
