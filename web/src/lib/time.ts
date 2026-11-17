import { parseStoredTime } from './answerPlacement';

/**
 * A stored time in the viewer's time zone. The server's SQLite writes UTC as "YYYY-MM-DD HH:MM:SS" with no zone; handing
 * that to `new Date()` reads it as local time, which shows it 2 h early in Poland in summer. Returns the raw text when it
 * cannot be read, and '' for nothing.
 */
export function formatStoredTime(s: string | null | undefined, opts: { timeZone?: string; locale?: string } = {}): string {
  const t = parseStoredTime(s);
  if (t === null) return s ?? '';
  return new Date(t).toLocaleString(opts.locale, opts.timeZone ? { timeZone: opts.timeZone } : undefined);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; the date for anything older than a month. '' for nothing, the raw text if unreadable. */
export function relativeTime(s: string | null | undefined, now: number = Date.now()): string {
  const t = parseStoredTime(s);
  if (t === null) return s ?? '';
  const sec = Math.round((now - t) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d <= 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}

/**
 * A message's time, kept short: "14:05" today, "17 Nov, 14:05" this year, with the year before that. In the viewer's time
 * zone and locale unless told otherwise (tests).
 */
export function formatMessageTime(at: Date, now: Date = new Date(), opts: { timeZone?: string; locale?: string } = {}): string {
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {};
  const day = (d: Date) => d.toLocaleDateString('en-CA', tz);
  const clock = at.toLocaleTimeString(opts.locale, { hour: '2-digit', minute: '2-digit', ...tz });
  if (day(at) === day(now)) return clock;
  const sameYear = day(at).slice(0, 4) === day(now).slice(0, 4);
  const date = at.toLocaleDateString(opts.locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), ...tz });
  return `${date}, ${clock}`;
}
