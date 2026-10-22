/** Key for answers that belong under the last message (their turn is still running, or no matching turn was found). */
export const AT_END = '__end__';

export interface PlacedMessage {
  id: string;
  role: string;
  /** When the row was stored (ms). null for messages that aren't stored yet (optimistic / streaming). */
  at: number | null;
}

export interface PlacedAnswer {
  id: string;
  /** When the agent asked (ms). */
  askedAt: number | null;
  /** When the user answered (ms); only used to keep several answers of one turn in order. */
  answeredAt: number | null;
}

/** Parses a stored time: SQLite's UTC "YYYY-MM-DD HH:MM:SS" or an ISO string. null when missing or unparseable. */
export function parseStoredTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Decides where each "You answered" line goes in the transcript. A question belongs to the turn that was running when
 * it was asked — the turn that began with the last user message stored at or before that moment — so its answer goes
 * under that turn's last message (the reply), not at the very bottom of the chat. Message rows are written after each
 * step finishes, so only the user messages that start a turn give a reliable position.
 * Returns message id → answer ids (in answering order); answers that match no turn go under AT_END.
 */
export function placeAnswers(messages: PlacedMessage[], answers: PlacedAnswer[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const put = (key: string, id: string) => out.set(key, [...(out.get(key) ?? []), id]);
  const ordered = [...answers].sort((a, b) => (a.answeredAt ?? Infinity) - (b.answeredAt ?? Infinity) || a.id.localeCompare(b.id));

  for (const a of ordered) {
    if (a.askedAt === null) { put(AT_END, a.id); continue; }
    let start = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === 'user' && m.at !== null && m.at <= a.askedAt) start = i;
    }
    if (start < 0) { put(AT_END, a.id); continue; }
    let next = messages.findIndex((m, i) => i > start && m.role === 'user');
    if (next < 0) next = messages.length;
    let last = start;
    for (let i = start; i < next; i++) if (messages[i]!.role !== 'system') last = i;
    // The newest turn: leave the line at the very end (below anything still streaming).
    put(next === messages.length ? AT_END : messages[last]!.id, a.id);
  }
  return out;
}
