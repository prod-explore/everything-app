import type { Page } from 'playwright';

/** One open page of a browser session. */
export interface Tab {
  /** Small number, never reused within a session: "tab 2" is the same page until it closes. */
  readonly id: number;
  readonly page: Page;
  /** Last known document title (page-supplied; may be empty until the page has loaded). */
  title: string;
}

export class TabLimitError extends Error {
  constructor(max: number) {
    super(`Tab limit reached (${max} open tabs). Close one with browser_tabs (action "close") first.`);
    this.name = 'TabLimitError';
  }
}

export interface TabSetOptions {
  /** Most tabs one session may hold. A page opened by a site beyond this is closed again. */
  max: number;
  /** Told about things the agent should know (a page refused because of the limit). */
  notify: (message: string) => void;
  /** Called when the last tab went away while the session lives on, to open a blank one. */
  openBlank: () => Promise<unknown>;
}

const MAX_TITLE = 120;

/**
 * The pages ("tabs") of one browser session and which of them is the active one. Everything that looks at "the page" —
 * the agent's tools, the live view, a person who took control — acts on the active tab, so switching is one place.
 * A session always has at least one tab: when the last one closes (a site closing its own window, say), a blank one
 * is opened, so the live view never ends up with nothing to show.
 */
export class TabSet {
  private readonly tabs: Tab[] = [];
  private nextId = 1;
  private activeId = 0;
  private closing = false;

  constructor(private readonly opts: TabSetOptions) {}

  get size(): number {
    return this.tabs.length;
  }

  get max(): number {
    return this.opts.max;
  }

  all(): readonly Tab[] {
    return this.tabs;
  }

  get(id: number): Tab | undefined {
    return this.tabs.find(t => t.id === id);
  }

  /** The active tab. Only absent for the instant between the last tab closing and its replacement opening. */
  active(): Tab {
    const tab = this.get(this.activeId) ?? this.tabs[this.tabs.length - 1];
    if (!tab) throw new Error('The browser has no open tab right now (a new one is being opened) — try again.');
    return tab;
  }

  hasRoom(): boolean {
    return this.tabs.length < this.opts.max;
  }

  /**
   * Registers a page. Idempotent (the page may be announced by the context and handed over by whoever opened it).
   * Beyond the limit the page is closed and the agent is told, which stops a site from opening tabs without end.
   */
  add(page: Page): Tab | null {
    const known = this.tabs.find(t => t.page === page);
    if (known) return known;
    if (!this.hasRoom()) {
      void page.close().catch(() => {});
      this.opts.notify(`a page tried to open a new tab, but this session already has ${this.opts.max} — it was closed`);
      return null;
    }
    const tab: Tab = { id: this.nextId++, page, title: '' };
    this.tabs.push(tab);
    if (this.tabs.length === 1) this.activeId = tab.id;
    const refreshTitle = () => {
      void page.title().then(t => { tab.title = t.slice(0, MAX_TITLE); }).catch(() => {});
    };
    page.on('domcontentloaded', refreshTitle);
    page.on('load', refreshTitle);
    page.on('close', () => this.remove(tab));
    return tab;
  }

  activate(id: number): Tab | null {
    const tab = this.get(id);
    if (!tab) return null;
    this.activeId = tab.id;
    return tab;
  }

  /** The tab to show after `tab` closes: the one before it, else the first. */
  private remove(tab: Tab): void {
    const index = this.tabs.indexOf(tab);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    if (this.activeId === tab.id && this.tabs.length > 0) this.activeId = this.tabs[Math.max(0, index - 1)]!.id;
    if (this.tabs.length === 0 && !this.closing) void this.opts.openBlank().catch(() => {});
  }

  /** The session is shutting down: closing its pages must not open a replacement. */
  markClosing(): void {
    this.closing = true;
  }
}
