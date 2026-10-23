import type { SessionHandle } from '../sessionPool.js';

/** One line for observations when the session has more than one tab, so the agent knows which page it is looking at. */
export function tabNote(session: Pick<SessionHandle, 'tabs'>): string | null {
  const { tabs } = session;
  if (tabs.size < 2) return null;
  return `(tab [${tabs.active().id}] of ${tabs.size} is active — browser_tabs lists them; refs below belong to this tab)`;
}

/** The tab list as text: id, active marker, address and the page-supplied title. */
export function formatTabs(session: Pick<SessionHandle, 'tabs'>): string {
  const { tabs } = session;
  const activeId = tabs.active().id;
  const rows = tabs.all().map(t => {
    const url = t.page.url().slice(0, 200) || 'about:blank';
    const title = t.title ? ` — title (page-supplied): ${JSON.stringify(t.title.slice(0, 80))}` : '';
    return `[${t.id}]${t.id === activeId ? ' (active)' : ''} ${url}${title}`;
  });
  return `Tabs (${tabs.size} of at most ${tabs.max}; the active one is what browser_observe and browser_act work on):\n${rows.join('\n')}`;
}
