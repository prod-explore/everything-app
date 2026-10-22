import { CornerDownRight } from 'lucide-react';
import type { GazetaItem } from '../../types';

function formatResponse(response: unknown): string {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    // { answer } / { choice } style single-value answers read better without the key.
    const entries = Object.entries(obj);
    if (entries.length === 1) return String(entries[0]![1]);
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
  }
  return String(response);
}

/** One answered question, shown quietly in the transcript right under the reply of the turn that asked it. */
export function AnsweredLine({ item }: { item: GazetaItem }) {
  return (
    <div className="flex items-start gap-2 text-xs text-fg-tertiary" aria-label="Twoja odpowiedź">
      <CornerDownRight size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="text-fg-secondary">{item.title}</span>
        <br />
        You answered: <span className="text-fg-secondary">{formatResponse(item.response) || '—'}</span>
      </span>
    </div>
  );
}
