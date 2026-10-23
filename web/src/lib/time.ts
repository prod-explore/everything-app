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
