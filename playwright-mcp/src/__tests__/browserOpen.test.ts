import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserContext, Page } from 'playwright';
import { BrowserSessionPool, type ClaimOptions } from '../sessionPool.js';
import { approvedHostFor, approvedHostsFor, registerBrowserOpen } from '../tools/browserOpen.js';
import { registerBrowserTabs } from '../tools/browserTabs.js';
import { testConfig } from './testConfig.js';

type ToolRes = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<ToolRes>;

function mockPage(initialUrl: string, titleText: string) {
  let url = initialUrl;
  const gotos: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const page = {
    url: () => url,
    title: async () => titleText,
    goto: async (u: string) => { gotos.push(u); url = u; },
    bringToFront: async () => {},
    setDefaultTimeout: () => {},
    setViewportSize: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({ title: titleText, text: `Body of ${url}`, elements: [] }),
    on: (ev: string, fn: (...args: unknown[]) => void) => { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); return page; },
    off: (ev: string, fn: (...args: unknown[]) => void) => { handlers.set(ev, (handlers.get(ev) ?? []).filter(f => f !== fn)); return page; },
    close: async () => { for (const f of handlers.get('close') ?? []) f(); },
    gotos,
  };
  return page;
}

describe('approvedHostFor (_approved_host from the orchestrator)', () => {
  it('accepts exactly the host of the URL being opened', () => {
    assert.equal(approvedHostFor('https://Shop.Example/cart?x=1', 'shop.example'), 'shop.example');
    assert.equal(approvedHostFor('https://shop.example:8443/', 'SHOP.example.'), 'shop.example');
  });
  it('ignores anything wider, different or missing', () => {
    assert.equal(approvedHostFor('https://shop.example/', 'example'), null);
    assert.equal(approvedHostFor('https://shop.example/', '*.example'), null);
    assert.equal(approvedHostFor('https://evil.example/', 'shop.example'), null);
    assert.equal(approvedHostFor('https://shop.example/', undefined), null);
    assert.equal(approvedHostFor('not a url', 'shop.example'), null);
  });

  it('approvedHostsFor pairs apex and www siblings for two-label public domains', () => {
    assert.deepEqual(approvedHostsFor('https://github.com/prod-explore', 'github.com'), ['github.com', 'www.github.com']);
    assert.deepEqual(approvedHostsFor('https://www.github.com/login', 'www.github.com'), ['www.github.com', 'github.com']);
    assert.deepEqual(approvedHostsFor('https://api.github.com/user', 'api.github.com'), ['api.github.com']);
    assert.deepEqual(approvedHostsFor('http://127.0.0.1:8080/', '127.0.0.1'), ['127.0.0.1']);
  });
});

describe('device profile gating & safe user-tab attachment', () => {
  it('requires _personal_profile_approved for personal profile, lists user tabs, gates unapproved switch, and attaches without reload', async () => {
    const userTab = mockPage('https://github.com/prod-explore/everything-app', 'GitHub Repo');
    const agentTab = mockPage('about:blank', '');
    const claimedProfiles: Array<ClaimOptions['profile']> = [];

    const pool = new BrowserSessionPool({
      maxSessions: 2,
      idleTimeoutMs: 60_000,
      watchdogIntervalMs: 60_000,
      maxTabs: 6,
      makeLauncher: () => ({
        async launch(state) {
          claimedProfiles.push(state.profile);
          const ctx = {
            on: () => {},
            newPage: async () => mockPage('about:blank', '') as unknown as Page,
            close: async () => {},
          } as unknown as BrowserContext;
          return { context: ctx, page: agentTab as unknown as Page, existingPages: [userTab as unknown as Page] };
        },
      }),
    });

    const cfg = testConfig({
      persistentProfile: true,
      allowPrivateNetwork: true,
      availableProfiles: ['dedicated', 'personal'],
      defaultProfile: 'dedicated',
      requirePersonalApproval: true,
    });

    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _meta: unknown, fn: Handler) => { handlers.set(name, fn); },
    } as unknown as McpServer;
    registerBrowserOpen(server, cfg, pool);
    registerBrowserTabs(server, cfg, pool);

    // Unapproved personal profile request fails closed.
    const denied = await handlers.get('browser_tabs')!({ action: 'list', profile: 'personal', _conversation_id: 'c1' });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text!, /explicit user approval/);

    // Approved list claims personal profile and lists pre-existing user tab [1] + agent tab [2].
    const listed = await handlers.get('browser_tabs')!({
      action: 'list',
      profile: 'personal',
      _conversation_id: 'c1',
      _personal_profile_approved: true,
      _policy: { domainGrant: [] },
    });
    assert.equal(listed.isError, undefined);
    assert.deepEqual(claimedProfiles, ['personal']);
    assert.match(listed.content[0]!.text!, /\[1\] \(user\) https:\/\/github\.com\/prod-explore\/everything-app/);
    assert.match(listed.content[0]!.text!, /\[2\] \(active\) about:blank/);

    // Switching straight to user tab [1] before domain approval is blocked (prevents DOM exfiltration).
    const blockedSwitch = await handlers.get('browser_tabs')!({ action: 'switch', tab: 1, _conversation_id: 'c1' });
    assert.equal(blockedSwitch.isError, true);
    assert.match(blockedSwitch.content[0]!.text!, /call browser_open with url .*github\.com.* and tab: 1/);

    // Attaching with browser_open({ url, tab: 1, _approved_host: 'github.com' }) observes without reloading.
    const attached = await handlers.get('browser_open')!({
      url: 'https://github.com/prod-explore/everything-app',
      tab: 1,
      profile: 'personal',
      _conversation_id: 'c1',
      _personal_profile_approved: true,
      _approved_host: 'github.com',
      _policy: { domainGrant: [] },
    });
    assert.equal(attached.isError, undefined);
    assert.equal(userTab.gotos.length, 0, 'attaching to matching existing user tab must not reload it');
    assert.match(attached.content[0]!.text!, /attached to tab \[1\] without reloading/);
    pool.stopWatchdog();
  });
});
