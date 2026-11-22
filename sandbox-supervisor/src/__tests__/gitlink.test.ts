import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { SandboxManager, gitLinkNetworkName, previewNetworkName } from '../sandboxes.js';
import { createSupervisorApp } from '../api.js';
import { fakeOps } from './helpers.js';

const GP = 'everythingapp-git-proxy';

describe('git-proxy link (sandbox ↔ git-proxy, no published port)', () => {
  it('puts the sandbox and git-proxy on one private network; git-proxy answers as "git-proxy"', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { gitProxyContainer: GP });
    const r = await m.linkGitProxy('proj-1');
    assert.equal(r.host, 'git-proxy');
    assert.match(r.network, /^ea-gitlink-[0-9a-f]{16}$/);
    assert.notEqual(r.network, previewNetworkName('proj-1'));
    const net = f.networks.get(r.network)!;
    assert.deepEqual([...net.attached.keys()].sort(), ['c1', GP].sort());
    assert.deepEqual(net.attached.get(GP), ['git-proxy']);
    assert.deepEqual(net.attached.get('c1'), []);
    await m.shutdown();
  });

  it('is idempotent and per owner', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { gitProxyContainer: GP });
    const a = await m.linkGitProxy('a');
    assert.deepEqual(await m.linkGitProxy('a'), a);
    const b = await m.linkGitProxy('b');
    assert.notEqual(a.network, b.network);
    assert.equal(f.networks.size, 2);
    assert.equal(f.networks.get(a.network)!.attached.has('c2'), false);
    assert.equal(gitLinkNetworkName('a'), a.network);
    await m.shutdown();
  });

  it('501 when git-proxy is not configured; 502 and no leftover network when it cannot be attached', async () => {
    const m = new SandboxManager(fakeOps().ops);
    await assert.rejects(m.linkGitProxy('p'), (e: Error & { status?: number }) => e.status === 501);
    await m.shutdown();
    const f = fakeOps();
    const m2 = new SandboxManager(f.ops, { gitProxyContainer: 'missing-browser' });
    await assert.rejects(m2.linkGitProxy('p'), (e: Error & { status?: number }) => e.status === 502);
    assert.equal(f.networks.size, 0);
    await m2.shutdown();
  });

  it('is cut when the sandbox stops and when it is destroyed', async () => {
    const f = fakeOps();
    const m = new SandboxManager(f.ops, { gitProxyContainer: GP });
    await m.linkGitProxy('a');
    await m.stop('a');
    assert.equal(f.networks.size, 0);
    await m.linkGitProxy('a');
    assert.equal(f.networks.size, 1);
    await m.destroy('a');
    assert.equal(f.networks.size, 0);
    await m.shutdown();
  });

  it('POST /gitlink validates the owner and links', async () => {
    const mgr = new SandboxManager(fakeOps().ops, { gitProxyContainer: GP });
    const server = createSupervisorApp(mgr, 5000).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (body: unknown) => {
      const res = await fetch(base + '/gitlink', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    const ok = await post({ ownerId: 'proj1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.host, 'git-proxy');
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ ownerId: '../x' })).status, 400);
    server.closeAllConnections();
    server.close();
    await mgr.shutdown();
  });
});
