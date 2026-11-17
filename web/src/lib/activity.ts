import type { LivePart } from '../hooks/useSSE';

/** After this long without a single token or event, the chat says the model has gone quiet. */
export const SILENCE_AFTER_MS = 15_000;

/** "12 s", "1 min 5 s" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

/**
 * What to say about a running turn that has nothing to show yet: "Thinking… 12 s" before the first token, "No response for
 * 20 s" when it was producing and went quiet. null when there is nothing to say — text is flowing, a tool is running (the
 * card shows that), the model's reasoning is on screen, or the turn waits for the person's approval.
 */
export function activityLabel(o: {
  running: boolean;
  parts: LivePart[];
  startedAt: number | null;
  lastEventAt: number | null;
  now: number;
  awaitingApproval: boolean;
}): string | null {
  if (!o.running || o.awaitingApproval || o.startedAt === null) return null;
  const last = o.parts[o.parts.length - 1];
  if (!last) return `Thinking… ${formatElapsed(o.now - o.startedAt)}`;
  if (last.type === 'tool' && !last.call.result) return null;
  const quiet = o.now - (o.lastEventAt ?? o.startedAt);
  return quiet >= SILENCE_AFTER_MS ? `No response for ${formatElapsed(quiet)}` : null;
}

/** "Thought for 8 s", or the plain label when the length is not known. */
export function thoughtLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Thought process';
  return ms < 1000 ? 'Thought for <1 s' : `Thought for ${formatElapsed(ms)}`;
}
