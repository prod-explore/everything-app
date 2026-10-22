import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, Loader2, Minimize2, X } from 'lucide-react';
import type { ReasoningEffort } from '../../types';
import type { ConversationStateApi } from '../../hooks/useConversationState';

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The model's own task list (todo_write), collapsed to the current item. */
function TodoPanel({ api }: { api: ConversationStateApi }) {
  const [open, setOpen] = useState(false);
  const todos = api.state?.todos ?? [];
  if (todos.length === 0) return null;
  const done = todos.filter(t => t.status === 'completed').length;
  const active = todos.find(t => t.status === 'in_progress');
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-2" aria-label="Task list">
      <div className="rounded-button border border-border bg-bg-secondary text-xs">
        <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-fg-secondary" aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="font-medium text-fg">Tasks {done}/{todos.length}</span>
          {!open && active && <span className="min-w-0 flex-1 truncate text-fg-tertiary">{active.content}</span>}
          <span className="flex-1" />
          {done === todos.length && (
            <span role="button" tabIndex={0} onClick={e => { e.stopPropagation(); void api.clearTodos(); }} onKeyDown={e => e.key === 'Enter' && void api.clearTodos()} className="rounded p-0.5 hover:bg-bg-tertiary" title="Clear the list" aria-label="Clear the task list">
              <X size={12} />
            </span>
          )}
        </button>
        {open && (
          <ul className="space-y-1 border-t border-border px-2.5 py-2">
            {todos.map((t, i) => (
              <li key={i} className={`flex items-start gap-2 ${t.status === 'completed' ? 'text-fg-tertiary line-through' : t.status === 'in_progress' ? 'text-fg' : 'text-fg-secondary'}`}>
                {t.status === 'completed' ? <Check size={13} className="mt-0.5 shrink-0 text-success" /> : t.status === 'in_progress' ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" /> : <Circle size={13} className="mt-0.5 shrink-0 text-fg-tertiary" />}
                <span>{t.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** /compact typed in the composer (App.tsx forwards them as `chat:command`). */
function useChatCommands(api: ConversationStateApi, running: boolean) {
  useEffect(() => {
    const onCommand = (e: Event) => {
      if (running) return;
      const name = (e as CustomEvent<{ name: string }>).detail.name;
      if (name === 'compact') void api.compact();
    };
    window.addEventListener('chat:command', onCommand);
    return () => window.removeEventListener('chat:command', onCommand);
  });
}

/** The chat's task list and the one-line result of the last context action. The controls live in the composer row. */
export function ChatStatus({ api, running }: { api: ConversationStateApi; running: boolean }) {
  useChatCommands(api, running);
  return (
    <>
      <TodoPanel api={api} />
      {api.note && (
        <div className="mx-auto w-full max-w-3xl px-3 pt-1.5 text-xs text-fg-tertiary" role="status">
          {api.note}
        </div>
      )}
    </>
  );
}

/** Reasoning effort — sits left of the message box, next to the attach button. Renders nothing for models without effort levels. */
export function EffortSelect({ api, running }: { api: ConversationStateApi; running: boolean }) {
  const s = api.state;
  if (!s?.effortSupported) return null;
  return (
    <label className="flex h-[42px] shrink-0 items-center gap-1.5 text-xs text-fg-tertiary" title="How hard the model thinks before answering">
      <span className="max-sm:sr-only">Effort</span>
      <select
        value={s.effort}
        onChange={e => void api.setEffort(e.target.value as ReasoningEffort)}
        disabled={running}
        className="rounded-button border border-border bg-bg-secondary px-1.5 py-1.5 text-xs text-fg outline-none focus:border-border-hover disabled:opacity-40"
        aria-label="Reasoning effort"
      >
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
    </label>
  );
}

/** How full the model's context window is, plus Compact — sits right of the message box, next to the send button. */
export function ContextMeter({ api, running }: { api: ConversationStateApi; running: boolean }) {
  const s = api.state;
  if (!s || s.context.used === null) return null;
  const { used, limit } = s.context;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const hot = pct !== null && pct >= 75;
  const title = limit
    ? `${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} tokens in the last request`
    : `${used.toLocaleString('en-US')} tokens in the last request`;

  return (
    <div className="flex h-[42px] shrink-0 items-center gap-2 text-xs text-fg-tertiary">
      <span className="flex items-center gap-2" title={title}>
        {pct !== null && (
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-bg-tertiary max-sm:hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Context used">
            <span className={`block h-full ${hot ? 'bg-danger' : 'bg-fg-tertiary'}`} style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className={`whitespace-nowrap ${hot ? 'text-danger' : ''}`}>{fmt(used)}{limit ? ` / ${fmt(limit)}` : ' tokens'}</span>
      </span>
      {(pct === null || pct >= 40) && (
        <button
          type="button"
          onClick={() => void api.compact()}
          disabled={running || api.busy}
          title="Compact: summarise the older part of this chat to free context. The messages stay visible."
          aria-label="Compact the conversation"
          className="rounded-button border border-border p-1.5 hover:text-fg-secondary disabled:opacity-40"
        >
          {api.busy ? <Loader2 size={13} className="animate-spin" /> : <Minimize2 size={13} />}
        </button>
      )}
    </div>
  );
}
