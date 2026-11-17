import { activityLabel } from '../../lib/activity';
import { useNow } from '../../hooks/useNow';
import type { LiveTurnState } from '../../hooks/useSSE';

/**
 * The inline placeholder of a running turn that has nothing to show yet — "Thinking… 12 s" until the first token, and
 * "No response for 20 s" when the model goes quiet in the middle of an answer. It disappears with the next token.
 */
export function ActivityLine({ live, awaitingApproval }: { live: Pick<LiveTurnState, 'running' | 'parts' | 'startedAt' | 'lastEventAt'>; awaitingApproval: boolean }) {
  const now = useNow(live.running);
  const label = activityLabel({ ...live, now, awaitingApproval });
  if (!label) return null;
  return (
    <div role="status" className="flex items-center gap-2 py-1 text-xs text-fg-tertiary">
      <span className="size-1.5 animate-pulse rounded-full bg-fg-tertiary" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}
