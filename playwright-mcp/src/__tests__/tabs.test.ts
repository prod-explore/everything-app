import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { TabLimitError, TabSet } from '../tabs.js';
import { BrowserSessionPool, openTab, type ContextLauncher } from '../sessionPool.js';
import { formatTabs, tabNote } from '../tools/tabNote.js';
import { tabsOf } from '../liveview.js';

type Handler = () => void;

/** A page that only knows what the tab bookkeeping asks of it. */
function fakePage(url = 'about:blank', title = '') {
  const handlers = new Map<string, Handler[]>();
  const page = {
    closed: false,
    viewport: null as { width: number; height: number } | null,
    url: () => url,
    navigate(next: string, nextTitle: string) { url = next; title = nextTitle; },
    title: async () => title,
    on(event: string, fn: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return page; },
    emit(event: string) { for (const fn of handlers.get(event) ?? []) fn(); },
    close: async () => { page.closed = true; page.emit('close'); },
    setViewportSize: async (v: { width: number; height: number }) => { page.viewport = v; },
    bringToFront: async () => {},
  };
  return page;
}
type FakePage = ReturnType<typeof fakePage>;
const asPage = (p: FakePage) => p as unknown as Page;

function newSet(max = 3) {
  const notices: string[] = [];
  let blanks = 0;
  const set = new TabSet({ max, notify: m => notices.push(m), openBlank: async () => { blanks++; } });
  return { set, notices, blanks: () => blanks };
}

describe('TabSet', () => {
  it('the first page becomes the active tab and ids count up without being reused', async () => {
    const { set } = newSet(5);
    const a = fakePage(); const b = fakePage(); const c = fakePage();
    const ta = set.add(asPage(a))!; const tb = set.add(asPage(b))!;
    assert.deepEqual([ta.id, tb.id], [1, 2]);
    assert.equal(set.active().id, 1);
    await b.close();
    const tc = set.add(asPage(c))!;
    assert.equal(tc.id, 3);
  });

  it('adding the same page twice gives the same tab', () => {
    const { set } = newSet();
    const p = fakePage();
    assert.equal(set.add(asPage(p)), set.add(asPage(p)));
    assert.equal(set.size, 1);
  });

  it('activate() switches the active tab, and refuses a tab that is not there', () => {
    const { set } = newSet();
    set.add(asPage(fakePage())); set.add(asPage(fakePage()));
    assert.equal(set.activate(2)?.id, 2);
    assert.equal(set.active().id, 2);
    assert.equal(set.activate(9), null);
    assert.equal(set.active().id, 2);
  });

  it('closing the active tab shows the one before it; closing another leaves the active one alone', async () => {
    const { set } = newSet(5);
    const pages = [fakePage(), fakePage(), fakePage()];
    pages.forEach(p => set.add(asPage(p)));
    set.activate(3);
    await pages[2]!.close();
    assert.equal(set.active().id, 2);
    await pages[0]!.close();
    assert.equal(set.active().id, 2);
    assert.equal(set.size, 1);
  });

  it('a page beyond the limit is closed again and the agent is told', () => {
    const { set, notices } = newSet(2);
    set.add(asPage(fakePage())); set.add(asPage(fakePage()));
    const extra = fakePage();
    assert.equal(set.add(asPage(extra)), null);
    assert.equal(extra.closed, true);
    assert.equal(set.size, 2);
    assert.match(notices[0]!, /already has 2/);
  });

  it('opens a blank tab when the last one closes, but not while the session is shutting down', async () => {
    const live = newSet();
    const p = fakePage();
    live.set.add(asPage(p));
    await p.close();
    assert.equal(live.blanks(), 1);

    const closing = newSet();
    const q = fakePage();
    closing.set.add(asPage(q));
    closing.set.markClosing();
    await q.close();
    assert.equal(closing.blanks(), 0);
  });

  it('follows the page title after it loads', async () => {
    const { set } = newSet();
    const p = fakePage('https://a.example/', 'First');
    const tab = set.add(asPage(p))!;
    p.navigate('https://a.example/next', 'Second');
    p.emit('load');
    await new Promise(r => setImmediate(r));
    assert.equal(tab.title, 'Second');
  });

  it('active() says so when there is no tab at all, rather than returning nothing', () => {
    assert.throws(() => newSet().set.active(), /no open tab/);
  });
});

describe('a session with tabs', () => {
  /** A launcher whose context announces new pages the way Playwright does. */
  function launcher(pages: FakePage[]): ContextLauncher {
    return {
      async launch() {
        const listeners: Array<(p: Page) => void> = [];
        const first = fakePage('https://one.example/');
        pages.push(first);
        const context = {
          on: (event: string, fn: (p: Page) => void) => { if (event === 'page') listeners.push(fn); },
          newPage: async () => {
            const p = fakePage();
            pages.push(p);
            for (const fn of listeners) fn(asPage(p));
            return asPage(p);
          },
          close: async () => { for (const p of pages) await p.close(); },
        } as unknown as BrowserContext;
        return { context, page: asPage(first) };
      },
    };
  }
  const makePool = (pages: FakePage[], maxTabs = 3) =>
    new BrowserSessionPool({ maxSessions: 2, idleTimeoutMs: 1_800_000, watchdogIntervalMs: 120_000, maxTabs, makeLauncher: () => launcher(pages) });

  it('starts with one tab, and `page` is the active tab', async () => {
    const pages: FakePage[] = [];
    const pool = makePool(pages);
    const { session } = await pool.claim('c');
    assert.equal(session.tabs.size, 1);
    assert.equal(session.page, asPage(pages[0]!));
    pool.stopWatchdog();
  });

  it('a page the site opens joins the session; switching moves `page` with it', async () => {
    const pages: FakePage[] = [];
    const pool = makePool(pages);
    const { session } = await pool.claim('c');
    const popup = fakePage('https://popup.example/');
    await (session.context.newPage as () => Promise<Page>)(); // a page announced by the context
    assert.equal(session.tabs.size, 2);
    session.tabs.activate(2);
    assert.equal(session.page, asPage(pages[1]!));
    void popup;
    pool.stopWatchdog();
  });

  it('openTab() opens, registers once and activates; refuses beyond the limit with a clear message', async () => {
    const pages: FakePage[] = [];
    const pool = makePool(pages, 2);
    const { session } = await pool.claim('c');
    session.viewport = { width: 800, height: 600 };
    const tab = await openTab(session);
    assert.equal(session.tabs.size, 2);
    assert.equal(session.tabs.active().id, tab.id);
    assert.deepEqual(pages[1]!.viewport, { width: 800, height: 600 });
    await assert.rejects(() => openTab(session), TabLimitError);
    assert.equal(session.tabs.size, 2);
    pool.stopWatchdog();
  });

  it('closing the session does not leave a replacement tab behind', async () => {
    const pages: FakePage[] = [];
    const pool = makePool(pages);
    const { session } = await pool.claim('c');
    await pool.close('c', 'test');
    await new Promise(r => setImmediate(r));
    assert.equal(pages.length, 1);
    assert.equal(session.tabs.size, 0);
  });

  it('status() counts the tabs', async () => {
    const pages: FakePage[] = [];
    const pool = makePool(pages);
    const { session } = await pool.claim('c');
    await openTab(session);
    assert.equal(pool.status().sessions[0]!.tabs, 2);
    pool.stopWatchdog();
  });

  it('describes tabs for the agent and for the panel', async () => {
    const pages: FakePage[] = [];
    const pool = makePool(pages);
    const { session } = await pool.claim('c');
    assert.equal(tabNote(session), null, 'a single tab needs no note');
    const tab = await openTab(session);
    pages[1]!.navigate('https://two.example/x', 'Second page');
    pages[1]!.emit('load');
    await new Promise(r => setImmediate(r));
    assert.match(tabNote(session)!, /tab \[2\] of 2 is active/);
    const text = formatTabs(session);
    assert.match(text, /\[1\] https:\/\/one\.example\//);
    assert.match(text, /\[2\] \(active\) https:\/\/two\.example\/x — title \(page-supplied\): "Second page"/);
    assert.deepEqual(tabsOf(session).map(t => [t.id, t.active]), [[1, false], [tab.id, true]]);
    pool.stopWatchdog();
  });
});
