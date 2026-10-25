import { useEffect, useMemo } from 'react';
import { getGazetaItems } from '../api';
import type { GazetaItem } from '../types';
import { useGazeta } from './useGazeta';

/** The questions this chat's agents asked and the user answered (oldest first), for the "You answered: …" lines in the transcript. */
export function useAnsweredQuestions(conversationId: string): GazetaItem[] {
  const { byId, upsert } = useGazeta();

  // Answers given in earlier sessions aren't in the live store — load this chat's recent ones once.
  useEffect(() => {
    let cancelled = false;
    getGazetaItems({ status: 'responded', conversationId, type: 'agent_question', limit: 20 })
      .then(r => !cancelled && upsert(r.items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, upsert]);

  return useMemo(
    () =>
      Object.values(byId)
        .filter(i => i.conversationId === conversationId && i.type === 'agent_question' && i.status === 'responded')
        .sort((a, b) => ((a.respondedAt ?? a.createdAt) < (b.respondedAt ?? b.createdAt) ? -1 : 1)),
    [byId, conversationId],
  );
}
