import { useAuiState } from '@assistant-ui/react';
import { useState } from 'react';
import { Check, Clock, Pencil, SendHorizontal, Trash2, X } from 'lucide-react';
import type { QueuedMessage } from '../../lib/messageQueue';

export interface MessageQueueControls {
  items: readonly QueuedMessage[];
  paused: boolean;
  add: (text: string) => string;
  edit: (id: string, text: string) => void;
  remove: (id: string) => void;
  sendNow: (id: string) => void;
}

/** Messages waiting for their turn, above the message box: change them, drop them, or send one right away. */
export function QueuedMessages({ queue }: { queue: MessageQueueControls }) {
  const running = useAuiState(s => s.thread.isRunning);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (queue.items.length === 0) return null;

  const save = () => {
    if (editing) queue.edit(editing.id, editing.text);
    setEditing(null);
  };

  return (
    <ul aria-label="Queued messages" className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-3 pt-3">
      {queue.items.map((m, i) => (
        <li key={m.id} className="flex items-start gap-2 rounded-button border border-dashed border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-fg-secondary">
          <Clock size={13} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
          {editing?.id === m.id ? (
            <>
              <textarea
                autoFocus
                rows={Math.min(6, editing.text.split('\n').length)}
                value={editing.text}
                onChange={e => setEditing({ id: m.id, text: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    save();
                  } else if (e.key === 'Escape') setEditing(null);
                }}
                aria-label="Edit queued message"
                className="min-w-0 flex-1 resize-none rounded border border-border bg-bg px-1.5 py-1 text-fg outline-none focus:border-border-hover"
              />
              <IconButton label="Save" onClick={save}><Check size={13} /></IconButton>
              <IconButton label="Cancel" onClick={() => setEditing(null)}><X size={13} /></IconButton>
            </>
          ) : (
            <>
              <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words" title={m.text}>{m.text}</span>
              <span className="mt-0.5 shrink-0 text-fg-tertiary">{i === 0 ? (queue.paused ? 'paused' : 'next') : `#${i + 1}`}</span>
              <IconButton label="Edit" onClick={() => setEditing({ id: m.id, text: m.text })}><Pencil size={13} /></IconButton>
              <IconButton label={running ? 'Stop the assistant and send now' : 'Send now'} onClick={() => queue.sendNow(m.id)}><SendHorizontal size={13} /></IconButton>
              <IconButton label="Remove from queue" onClick={() => queue.remove(m.id)}><Trash2 size={13} /></IconButton>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="shrink-0 rounded p-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg">
      {children}
    </button>
  );
}
