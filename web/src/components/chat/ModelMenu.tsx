import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ModelOption } from '../../types';
import { otherModels } from '../../lib/modelChoices';

/**
 * A button that opens a short list of models and hands back the one picked — for answering once with another model
 * ("Try another model", "Regenerate with…"); the chat's own model is not changed.
 */
export function ModelMenu({ models, current, onlyLocal, onPick, children, className, title, disabled }: {
  models: ModelOption[];
  current: string | null;
  onlyLocal: boolean;
  onPick: (model: string) => void;
  children: ReactNode;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const choices = otherModels(models, current, onlyLocal);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (choices.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={className}
      >
        {children}
        <ChevronDown size={11} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 max-h-64 w-60 max-w-[80vw] overflow-y-auto rounded-container border border-border bg-bg-secondary py-1 shadow-lg">
          {choices.map(m => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onPick(m.id); }}
              className="block w-full truncate px-3 py-2 text-left text-xs text-fg-secondary hover:bg-bg-tertiary hover:text-fg"
              title={m.description || m.id}
            >
              {m.label}
              <span className="text-fg-tertiary"> · {m.providerLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
