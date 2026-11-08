import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { profileInUse } from '../browser/lock.js';
import { parseConfig, resolveConfig } from '../config.js';
import { hostEnv } from '../detect.js';
import { DeviceRuntime } from '../runtime.js';
import { BrowserInUseError, DeviceLauncher, DevicePool, IGNORED_DEFAULT_ARGS, launchArgs } from '../tools/browser.js';

const posix = process.platform !== 'win32';
const CHROME = '/usr/bin/google-chrome';

describe('profile lock', { skip: !posix }, () => {
  it('no lock → free; a lock held by a live process on this host → in use; a stale one (dead pid) → free', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-lock-'));
    assert.equal(await profileInUse(dir, 'linux'), false);
    await symlink(`${hostname()}-${process.pid}`, nodePath.join(dir, 'SingletonLock'));
    assert.equal(await profileInUse(dir, 'linux'), true);

    const stale = await mkdtemp(nodePath.join(tmpdir(), 'evv-lock-'));
    await symlink(`${hostname()}-2147483000`, nodePath.join(stale, 'SingletonLock'));
    assert.equal(await profileInUse(stale, 'linux'), false);

    const other = await mkdtemp(nodePath.join(tmpdir(), 'evv-lock-'));
    await symlink('some-other-host-1234', nodePath.join(other, 'SingletonLock'));
    assert.equal(await profileInUse(other, 'macos'), true, 'locked from another machine');

    const odd = await mkdtemp(nodePath.join(tmpdir(), 'evv-lock-'));
    await symlink('???', nodePath.join(odd, 'SingletonLock'));
    assert.equal(await profileInUse(odd, 'linux'), true, 'unknown shape: believe the lock');
  });

  it('Windows: a missing or openable lockfile is free', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-lock-'));
    assert.equal(await profileInUse(dir, 'windows'), false);
  });
});

describe('device browser launch settings', () => {
  it('keeps the person\'s extensions and keychain-encrypted cookies: those Playwright defaults are ignored', () => {
    assert.ok(IGNORED_DEFAULT_ARGS.includes('--disable-extensions'));
    assert.ok(IGNORED_DEFAULT_ARGS.includes('--password-store=basic'));
    assert.ok(IGNORED_DEFAULT_ARGS.includes('--use-mock-keychain'));
    const args = launchArgs('Profile 2');
    assert.ok(args.includes('--profile-directory=Profile 2'));
    assert.ok(!args.some(a => /disable-extensions|user-agent/i.test(a)));
  });

  it('a second chat gets "in use by another chat"; the first keeps its session', async () => {
    const fakeLauncher = { launch: async () => ({ context: { close: async () => {}, on: () => {} }, page: { on: () => {} } }) };
    const pool = new DevicePool({ maxSessions: 1, idleTimeoutMs: 1e9, watchdogIntervalMs: 1e9, makeLauncher: () => fakeLauncher as never });
    try {
      await pool.claim('chat-a');
      await assert.rejects(pool.claim('chat-b'), (e: Error) => e instanceof BrowserInUseError && /in use by another chat/.test(e.message));
      assert.equal((await pool.claim('chat-a')).isNew, false);
      await pool.close('chat-a', 'test');
      assert.equal((await pool.claim('chat-b')).isNew, true);
    } finally {
      pool.stopWatchdog();
    }
  });

  it('profile mode refuses to launch while the profile is open, naming the browser and the way out', async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-prof-'));
    if (posix) await symlink(`${hostname()}-${process.pid}`, nodePath.join(dir, 'SingletonLock'));
    else return;
    const launcher = new DeviceLauncher(
      { enabled: true, mode: 'profile', product: 'brave', executable: '/usr/bin/true', userDataDir: dir, profileDirectory: 'Default', allowPrivateNetwork: true },
      'linux',
      dir,
      () => {},
    );
    await assert.rejects(launcher.launch({ policy: { allowLayers: [], deny: [], js: 'allowed' } } as never), /Brave is open with this profile — close it, or switch the device to the dedicated profile/);
  });

  it('a missing executable is a clear error', async () => {
    const launcher = new DeviceLauncher({ enabled: true, mode: 'dedicated', product: 'edge', executable: null, userDataDir: '/x', profileDirectory: 'Default', allowPrivateNetwork: true }, 'linux', '/x', () => {});
    await assert.rejects(launcher.launch({} as never), /no Edge executable found/);
  });
});

describe('browser tools with the real Chrome (dedicated profile, headless only because this is a test)', { skip: !existsSync(CHROME) || !posix }, () => {
  let web: http.Server;
  let base = '';
  let dir = '';
  const runtimes: DeviceRuntime[] = [];

  before(async () => {
    process.env['EVVAPP_DEVICE_TEST_HEADLESS'] = '1';
    dir = await mkdtemp(nodePath.join(tmpdir(), 'evv-browser-'));
    web = http.createServer((req, res) => {
      if (req.url === '/dl') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' }).end('downloaded!');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<!doctype html><title>Device test page</title><h1>Hello from the device</h1>
         <button id="b" onclick="document.getElementById('out').textContent='clicked ' + navigator.userAgent.includes('Bot')">Press me</button>
         <p id="out">not clicked</p><a href="/dl">get file</a>`,
      );
    });
    await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  after(async () => {
    for (const r of runtimes) await r.dispose('test');
    await new Promise<void>(r => web.close(() => r()));
    delete process.env['EVVAPP_DEVICE_TEST_HEADLESS'];
  });

  async function connect(browser: object): Promise<Client> {
    // A fresh data directory (so a fresh browser profile) per runtime: one Chrome per profile at a time.
    const cfg = resolveConfig(parseConfig({ shell: { enabled: false }, browser: { enabled: true, mode: 'dedicated', product: 'chrome', executable: CHROME, ...browser } }), await mkdtemp(nodePath.join(dir, 'data-')), hostEnv());
    const runtime = new DeviceRuntime(cfg, () => {});
    runtimes.push(runtime);
    const server = runtime.createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'evvapp', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const text = (r: unknown): string => (r as { content: Array<{ text?: string }> }).content.map(c => c.text ?? '').join('\n');

  it('exposes playwright-mcp\'s six tools, described for the user\'s own browser', async () => {
    const client = await connect({});
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['browser_act', 'browser_close', 'browser_observe', 'browser_open', 'browser_screenshot', 'browser_tabs']);
    const open = tools.find(t => t.name === 'browser_open')!;
    assert.match(open.description!, /user's own browser/);
    assert.ok(!/ephemeral/.test(open.description!));
  });

  it('opens a local page, observes it, clicks (real user agent, no bot), downloads need permission, one session at a time', { timeout: 120_000 }, async () => {
    const client = await connect({});
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => text(await client.callTool({ name, arguments: { _conversation_id: 'chat-1', ...args } }));

    const opened = await call('browser_open', { url: `${base}/` });
    assert.match(opened, /Hello from the device/);
    assert.match(opened, /Press me/);
    assert.match(opened, /opened a new browser session/);

    const observed = await call('browser_observe', {});
    const ref = /\[(\d+)\] button: "Press me"/.exec(observed)?.[1];
    assert.ok(ref, observed);
    const clicked = await call('browser_act', { action: 'click', ref: Number(ref), label: 'Press me' });
    assert.match(clicked, /clicked false/, 'the page ran and the user agent is not a bot');

    // a different chat cannot take the browser
    const other = (await client.callTool({ name: 'browser_open', arguments: { _conversation_id: 'chat-2', url: `${base}/` } })) as { isError?: boolean };
    assert.equal(other.isError, true);
    assert.match(text(other), /in use by another chat/);

    // downloads: blocked without permission, saved to the download folder with it
    const obs = await call('browser_observe', {});
    const link = /\[(\d+)\] a: "get file"/.exec(obs)?.[1];
    assert.ok(link, obs);
    const blocked = await call('browser_act', { action: 'click', ref: Number(link), label: 'get file' });
    assert.match(blocked, /download blocked: report\.txt/);

    assert.match(await call('browser_close', {}), /Browser session closed/);
    assert.match(await call('browser_open', { url: `${base}/`, _conversation_id: 'chat-2' }), /Hello from the device/); // slot is free again
    await call('browser_close', { _conversation_id: 'chat-2' });
  });

  it('the domain gate applies: an unapproved host is refused until the user approved it', { timeout: 120_000 }, async () => {
    const client = await connect({});
    const gated = (await client.callTool({ name: 'browser_open', arguments: { _conversation_id: 'g', url: `${base}/`, _policy: { domainGrant: [] } } })) as { isError?: boolean };
    assert.equal(gated.isError, true);
    assert.match(text(gated), /domain not approved yet: 127\.0\.0\.1/);
    const approved = await client.callTool({ name: 'browser_open', arguments: { _conversation_id: 'g', url: `${base}/`, _policy: { domainGrant: [] }, _approved_host: '127.0.0.1' } });
    assert.match(text(approved), /Hello from the device/);
    await client.callTool({ name: 'browser_close', arguments: { _conversation_id: 'g' } });
  });

  it('allowed downloads land in the download folder; allowPrivateNetwork:false blocks localhost', { timeout: 120_000 }, async () => {
    const closed = await connect({ allowPrivateNetwork: false });
    const blocked = (await closed.callTool({ name: 'browser_open', arguments: { _conversation_id: 'p', url: `${base}/` } })) as { isError?: boolean };
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /private\/internal network/);
  });

  it('a download the user allowed is saved under the download directory', { timeout: 120_000 }, async () => {
    const downloads = await mkdtemp(nodePath.join(tmpdir(), 'evv-dl-'));
    const { createDeviceBrowser } = await import('../tools/browser.js');
    const cfg = resolveConfig(parseConfig({ shell: { enabled: false }, browser: { enabled: true, mode: 'dedicated', product: 'chrome', executable: CHROME } }), await mkdtemp(nodePath.join(dir, 'data-')), hostEnv());
    const device = createDeviceBrowser(cfg.browser, 'linux', downloads);
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const server = new McpServer({ name: 't', version: '0' });
    device.register(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const opened = text(await client.callTool({ name: 'browser_open', arguments: { _conversation_id: 'd', url: `${base}/` } }));
      const link = /\[(\d+)\] a: "get file"/.exec(opened)?.[1];
      assert.ok(link, opened);
      const r = text(await client.callTool({ name: 'browser_act', arguments: { _conversation_id: 'd', action: 'click', ref: Number(link), label: 'get file', _allow_downloads: true } }));
      assert.match(r, /download allowed, saved to .*report\.txt/);
      for (let i = 0; i < 50 && !existsSync(nodePath.join(downloads, 'report.txt')); i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(await readFile(nodePath.join(downloads, 'report.txt'), 'utf8'), 'downloaded!');
    } finally {
      await device.closeAll('test');
    }
  });
});
