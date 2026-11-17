import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useChatActions } from '../../lib/chatActions';

/** "‹ 2 / 3 ›": switches between the versions of an edited or regenerated message (and the chat that followed each). */
export function VersionPicker({ versions, current }: { versions: number[]; current: number | undefined }) {
  const { selectVersion, busy } = useChatActions();
  const at = current === undefined ? -1 : versions.indexOf(current);
  if (versions.length < 2 || at < 0) return null;
  const go = (to: number) => void selectVersion(versions[to]!);
  const arrow = 'rounded p-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg-secondary disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="flex items-center text-xs text-fg-tertiary" role="group" aria-label="Versions of this message">
      <button type="button" aria-label="Previous version" disabled={busy || at === 0} onClick={() => go(at - 1)} className={arrow}>
        <ChevronLeft size={13} />
      </button>
      <span className="min-w-[2.25rem] text-center tabular-nums" aria-live="polite">{at + 1} / {versions.length}</span>
      <button type="button" aria-label="Next version" disabled={busy || at === versions.length - 1} onClick={() => go(at + 1)} className={arrow}>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}
