import { useCallback, useEffect, useState } from 'react';
import { listConversationRuns } from '../api';
import { ACTIVE_RUN_STATUSES } from '../lib/agents';

const POLL_MS = 5000;

/**
 * How many worker agents of this chat are active right now (for the badge on the Agents button).
 * Reloads when `refreshKey` changes (agent:spawned / agent:finished events) and polls while any is active,
 * like the Agents panel does, so the number also falls when an agent finishes without an event reaching us.
 */
export function useActiveAgentCount(conversationId: string | null, refreshKey: number): number {
  // Keyed by chat, so switching chats never shows the previous chat's number.
  const [state, setState] = useState<{ id: string; n: number } | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const { runs } = await listConversationRuns(conversationId);
      const n = runs.filter(r => r.depth > 0 && ACTIVE_RUN_STATUSES.has(r.status)).length;
      setState(s => (s && s.id === conversationId && s.n === n ? s : { id: conversationId, n }));
    } catch {
      /* the badge is a convenience: keep the last number */
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const n = state && state.id === conversationId ? state.n : 0;
  useEffect(() => {
    if (n === 0) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [n, load]);

  return n;
}
