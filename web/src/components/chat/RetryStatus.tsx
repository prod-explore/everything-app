import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { RetryNotice } from '../../hooks/useSSE';
import { describeRetry, formatWait, trouble } from './retryText';

/** Longest a notice outlives its own wait when the chat is idle (a retry that succeeds sends no event of its own). */
const IDLE_GRACE_MS = 30_000;

/**
 * "Provider busy — retrying in 12 s (attempt 2)" for the conversation that is waiting, with a live countdown. It goes
 * away with the first sign of the answer or the end of the turn (see the reducer in useSSE); stop cancels the wait.
 */
export function RetryStatus({ retry, running }: { retry?: RetryNotice; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retry) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [retry]);
  if (!retry) return null;
  if (!running && now > retry.receivedAt + retry.delayMs + IDLE_GRACE_MS) return null;
  const { text, giveUpIn } = describeRetry(retry, now);
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-2">
      <div className="flex items-start gap-2 rounded-button border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-fg-secondary">
        <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" aria-hidden />
        {/* The countdown ticks twice a second: screen readers get one stable sentence per attempt instead. */}
        <span role="status" className="sr-only">{`${trouble(retry)} — retrying (attempt ${retry.attempt + 1})`}</span>
        <span aria-hidden className="min-w-0 flex-1 break-words">
          {text}
          {giveUpIn !== null && <span className="text-fg-tertiary"> · gives up in {formatWait(giveUpIn)}</span>}
          <span className="text-fg-tertiary"> · Stop cancels</span>
        </span>
      </div>
    </div>
  );
}
