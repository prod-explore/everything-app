import type { BrowserContext, Page } from 'playwright';
import type { UrlGuard } from './urlSafety.js';
import { launchHardenedContext, newSessionState, pushEvent, type SessionState } from './browserContext.js';
import { TabLimitError, TabSet, type Tab } from './tabs.js';
import type { EffectivePolicy, PolicyOverride } from './policy.js';

/**
 * Browser-agent equivalent of sandbox-supervisor/src/pool.ts's sticky lease +
 * idle watchdog — same shape, deliberately, since it's the same problem: a
 * conversation gets the same live resource back across multiple tool calls
 * (§6b's "works with app closed, reconnect" requirement), and idle resources
 * get reclaimed so one forgotten tab doesn't sit open forever.
 *
 * Unlike the sandbox pool, sessions aren't pre-warmed — a Chromium process
 * per idle slot isn't worth the RAM on a Pi-sized box, so sessions are
 * created lazily on first use and capped at maxSessions concurrent.
 */

export interface SessionHandle {
  readonly id: string; // = conversationId — one session per conversation, sticky
  readonly context: BrowserContext;
  /** The page the agent and the person are looking at: the active tab. */
  readonly page: Page;
  /** Every open page of this session; the active one is `page`. */
  readonly tabs: TabSet;
  /** The live-view panel's size, applied to every page (also those opened later). */
  viewport: { width: number; height: number } | null;
  readonly createdAt: Date;
  lastActivityAt: Date;
  currentUrl: string | null;
  /** Domain/JS policy + download permission + pending security events; read by the route handlers. */
  readonly state: SessionState;
}

/** Seam for tests — real launch requires a Chromium binary this container may not have. */
export interface ContextLauncher {
  launch(state: SessionState): Promise<{ context: BrowserContext; page: Page }>;
}

export interface ClaimOptions {
  /** Effective policy for a NEW session (an existing session keeps its own; tools update it). */
  policy?: EffectivePolicy;
  override?: PolicyOverride;
}

/**
 * One Chromium process per session, with an EPHEMERAL profile: nothing (cookies, localStorage,
 * credentials, history) survives the session. There are deliberately no persistent logins — an
 * agent driving a logged-in browser turns any prompt injection into account takeover. Logging in
 * or paying is done by the human via takeover, inside the live session, and ends with it.
 *
 * Hardened defaults (see browserContext.ts): downloads/uploads blocked unless the orchestrator passes
 * `_allow_downloads`, no service workers, no granted permissions (camera, mic, geolocation,
 * notifications, clipboard…), no extensions, WebRTC removed, domain + JS policy enforced on every
 * request, and the SSRF request guard applies to every request the context makes.
 */
export class ChromiumLauncher implements ContextLauncher {
  constructor(
    /** Applied to every request the browser makes (SSRF guard). */
    private readonly guard?: UrlGuard,
  ) {}

  async launch(state: SessionState): Promise<{ context: BrowserContext; page: Page }> {
    const { context, page } = await launchHardenedContext(state, this.guard);
    return { context, page };
  }
}

export interface SessionPoolOptions {
  maxSessions: number;
  idleTimeoutMs: number;
  watchdogIntervalMs: number;
  /** Most tabs one session may hold (default 6). */
  maxTabs?: number;
  /** Overridable in tests so no real browser is ever launched there. */
  makeLauncher: (sessionId: string) => ContextLauncher;
}

export class SessionLimitError extends Error {
  constructor(max: number) {
    super(
      `Browser session limit reached (${max} concurrent tabs). ` +
        `Close an existing session (browser_close) or wait for an idle one to time out.`,
    );
    this.name = 'SessionLimitError';
  }
}

export class BrowserSessionPool {
  private readonly sessions = new Map<string, SessionHandle>();
  private watchdogHandle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionPoolOptions) {}

  /** Sticky: the same conversationId always gets the same live session back. */
  async claim(conversationId: string, opts: ClaimOptions = {}): Promise<{ session: SessionHandle; isNew: boolean }> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.lastActivityAt = new Date();
      return { session: existing, isNew: false };
    }

    if (this.sessions.size >= this.opts.maxSessions) {
      throw new SessionLimitError(this.opts.maxSessions);
    }

    const launcher = this.opts.makeLauncher(conversationId);
    const state = newSessionState(opts.policy, opts.override);
    const { context, page } = await launcher.launch(state);
    const tabs = new TabSet({
      max: this.opts.maxTabs ?? 6,
      notify: message => pushEvent(state, message),
      openBlank: () => context.newPage(),
    });
    const handle: SessionHandle = {
      state,
      id: conversationId,
      context,
      get page() {
        return tabs.active().page;
      },
      tabs,
      viewport: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      currentUrl: null,
    };
    tabs.add(page);
    // Pages the session opens later (window.open, target=_blank, a tab the person or the agent opens) join the set.
    context.on('page', p => {
      if (tabs.add(p) && handle.viewport) void p.setViewportSize(handle.viewport).catch(() => {});
    });
    this.sessions.set(conversationId, handle);
    this.ensureWatchdog();
    console.log(`[sessionPool] opened session ${conversationId.slice(0, 8)} (${this.sessions.size}/${this.opts.maxSessions})`);
    return { session: handle, isNew: true };
  }

  get(conversationId: string): SessionHandle | undefined {
    return this.sessions.get(conversationId);
  }

  touch(conversationId: string): void {
    const s = this.sessions.get(conversationId);
    if (s) s.lastActivityAt = new Date();
  }

  setCurrentUrl(conversationId: string, url: string): void {
    const s = this.sessions.get(conversationId);
    if (s) s.currentUrl = url;
  }

  async close(conversationId: string, reason: string): Promise<boolean> {
    const s = this.sessions.get(conversationId);
    if (!s) return false;
    this.sessions.delete(conversationId);
    s.tabs.markClosing();
    console.log(`[sessionPool] closing session ${conversationId.slice(0, 8)} — ${reason}`);
    try {
      await s.context.close();
    } catch (err) {
      console.error(`[sessionPool] error closing session ${conversationId.slice(0, 8)}:`, err);
    }
    return true;
  }

  status(): {
    total: number;
    max: number;
    sessions: Array<{ id: string; url: string | null; tabs: number; idleSinceMs: number }>;
  } {
    const now = Date.now();
    return {
      total: this.sessions.size,
      max: this.opts.maxSessions,
      sessions: [...this.sessions.values()].map(s => ({
        id: s.id,
        url: s.currentUrl,
        tabs: s.tabs.size,
        idleSinceMs: now - s.lastActivityAt.getTime(),
      })),
    };
  }

  private ensureWatchdog(): void {
    if (this.watchdogHandle) return;
    this.watchdogHandle = setInterval(() => this.sweepIdle(), this.opts.watchdogIntervalMs);
    this.watchdogHandle.unref?.();
  }

  /** Closes every session idle past idleTimeoutMs. Called by the watchdog interval;
   * exposed publicly so tests can trigger a sweep deterministically instead of
   * waiting on a real timer. */
  sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const idleMs = now - s.lastActivityAt.getTime();
      if (idleMs > this.opts.idleTimeoutMs) {
        const idleMin = Math.round(idleMs / 60_000);
        this.close(id, `idle timeout, idle ${idleMin}m`).catch(err =>
          console.error('[sessionPool] watchdog close error:', err),
        );
      }
    }
  }

  /** Stops the watchdog without closing sessions — for tests and graceful shutdown. */
  stopWatchdog(): void {
    if (this.watchdogHandle) clearInterval(this.watchdogHandle);
    this.watchdogHandle = null;
  }
}

/**
 * Opens a blank page in the session, makes it the active tab and returns it. Refuses beyond the tab limit with a
 * message the agent (or the person) can act on, instead of letting the browser pile up pages on a small machine.
 */
export async function openTab(session: SessionHandle): Promise<Tab> {
  if (!session.tabs.hasRoom()) throw new TabLimitError(session.tabs.max);
  const page = await session.context.newPage();
  // The context announces the page too; add() is idempotent, so whichever comes first registers it.
  const tab = session.tabs.add(page);
  if (!tab) throw new TabLimitError(session.tabs.max);
  if (session.viewport) await page.setViewportSize(session.viewport).catch(() => {});
  session.tabs.activate(tab.id);
  return tab;
}
