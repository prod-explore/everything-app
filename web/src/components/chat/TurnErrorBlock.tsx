import { AlertTriangle, Minimize2, Play, RotateCw, Square } from 'lucide-react';
import { useChatActions } from '../../lib/chatActions';
import type { TurnErrorKind } from '../../types';
import { ModelMenu } from './ModelMenu';

/** Failures where asking again with the same model cannot help (a key, a quota): another model can. */
const NO_PLAIN_RETRY: ReadonlySet<TurnErrorKind | undefined> = new Set(['auth', 'not_configured', 'budget_exhausted']);

const button = 'flex items-center gap-1 rounded border border-border px-2 py-1 text-fg-secondary transition-colors hover:bg-bg-tertiary hover:text-fg disabled:opacity-40';

/**
 * Where a turn stopped, said under the message it belongs to: "Stopped" after the stop button, "Interrupted" with the reason when
 * the provider failed, the plain sentence when nothing was answered at all — and what can be done next: Continue (when there is
 * partial text to carry on), Retry, Regenerate, or the same question to another model. `actions: false` leaves just the label,
 * for an older message that has been followed by others.
 */
export function TurnErrorBlock({ variant, message, detail, kind, hasReply, canContinue, actions = true }: {
  /** `stopped`: the person stopped it. `error`: the provider (or the loop) failed. */
  variant: 'stopped' | 'error';
  message?: string;
  detail?: string;
  kind?: TurnErrorKind;
  /** There is a (partial) reply above to continue or regenerate. */
  hasReply: boolean;
  canContinue: boolean;
  actions?: boolean;
}) {
  const chat = useChatActions();
  const stopped = variant === 'stopped';
  const label = stopped ? 'Stopped' : hasReply ? 'Interrupted' : null;
  const sentence = stopped ? null : message;
  const busy = chat.busy;
  return (
    <div role={stopped ? 'status' : 'alert'} data-testid="turn-error" className="not-prose mt-1 rounded-button border border-border bg-bg-secondary px-3 py-2 text-xs text-fg-secondary">
      <div className="flex items-start gap-2">
        {stopped ? <Square size={12} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden /> : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />}
        <span className="min-w-0 flex-1 break-words" title={detail ?? message}>
          {label && <span className="font-medium text-fg">{label}</span>}
          {label && sentence ? ' — ' : ''}
          {sentence}
        </span>
      </div>
      {actions && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {canContinue && (
            <button type="button" disabled={busy} onClick={() => void chat.continueReply()} className={button}>
              <Play size={12} /> Continue
            </button>
          )}
          {kind === 'context_too_long' && chat.compactAndRetry && (
            <button type="button" disabled={busy} onClick={chat.compactAndRetry} className={button}>
              <Minimize2 size={12} /> Compact &amp; retry
            </button>
          )}
          {!NO_PLAIN_RETRY.has(kind) && (
            <button type="button" disabled={busy} onClick={() => void chat.retry()} className={button}>
              <RotateCw size={12} /> Retry
            </button>
          )}
          {hasReply && !stopped && !NO_PLAIN_RETRY.has(kind) && (
            <button type="button" disabled={busy} onClick={() => void chat.regenerate()} className={button}>
              <RotateCw size={12} /> Regenerate
            </button>
          )}
          <ModelMenu models={chat.models} current={chat.currentModel} onlyLocal={chat.onlyLocal} disabled={busy} onPick={m => void chat.retry(m)} className={button}>
            Try another model
          </ModelMenu>
        </div>
      )}
    </div>
  );
}
