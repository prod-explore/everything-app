import type { RetryNotice } from '../../hooks/useSSE';

/** "12 s", "3 min", "1 h 5 min". */
export function formatWait(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** What is wrong, in a few words: a 429 is a rate limit, a dropped connection says so, anything else is "busy". */
export function trouble(r: RetryNotice): string {
  if (r.status === 'network') return `can't reach ${r.provider}`;
  if (r.status === 'timeout') return `${r.provider} went silent before answering`;
  if (r.status === 'empty') return `${r.provider} returned an empty answer`;
  if (r.status === 429) return `${r.provider} is rate-limiting requests`;
  return `${r.provider} is busy (HTTP ${r.status})`;
}

/** The notice's text at `now`: the countdown runs from the moment the event arrived. */
export function describeRetry(r: RetryNotice, now: number): { text: string; waiting: boolean; giveUpIn: number | null } {
  const left = r.receivedAt + r.delayMs - now;
  const giveUpIn = r.remainingMs > 0 ? Math.max(r.receivedAt + r.remainingMs - now, 0) : null;
  const wait = left > 500 ? `retrying in ${formatWait(left)}` : 'retrying now';
  return { text: `${trouble(r)} — ${wait} (attempt ${r.attempt + 1})`, waiting: left > 500, giveUpIn };
}
