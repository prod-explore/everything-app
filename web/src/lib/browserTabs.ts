export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

/** What a tab shows: its title, else the site it is on, else "New tab" (a blank page). */
export function tabLabel(tab: Pick<TabInfo, 'title' | 'url'>): string {
  if (tab.title.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || 'New tab';
  } catch {
    return 'New tab';
  }
}
