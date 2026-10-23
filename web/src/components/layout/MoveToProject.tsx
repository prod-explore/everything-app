import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, FolderPlus, MessageSquare } from 'lucide-react';
import type { ConversationSummary, ProjectListItem } from '../../types';

/**
 * "Move to project…" on a chat row: the chat joins one of the existing projects, leaves its project (back to the quick chats),
 * or starts a project of its own named after it. A ghost chat is not offered this — it stays where it was born.
 */
export function MoveToProject({
  conversation,
  projects,
  size = 13,
  className = '',
  onMove,
  onNewProject,
}: {
  conversation: ConversationSummary;
  projects: ProjectListItem[];
  size?: number;
  className?: string;
  onMove: (conversationId: string, projectId: string | null) => void;
  onNewProject: (conversationId: string) => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  if (conversation.ghost) return null;

  const targets = projects.filter(p => !p.ghost && p.id !== conversation.projectId);
  const pick = (fn: () => void) => () => { setPos(null); fn(); };
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg-secondary hover:bg-bg-tertiary hover:text-fg';

  function toggle() {
    if (pos) { setPos(null); return; }
    const r = button.current!.getBoundingClientRect();
    const width = 224;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) });
  }

  return (
    <>
      <button
        ref={button}
        onClick={toggle}
        className={`shrink-0 rounded p-1 text-fg-tertiary opacity-0 hover:text-fg group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${pos ? '!opacity-100 text-fg' : ''} ${className}`}
        aria-label={`Move ${conversation.title} to a project`}
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        title="Move to project…"
      >
        <FolderInput size={size} />
      </button>
      {pos && createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label="Move to project"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 max-h-72 w-56 overflow-y-auto rounded-button border border-border bg-bg-secondary p-1 shadow-lg"
        >
          {targets.map(p => (
            <button key={p.id} role="menuitem" className={item} onClick={pick(() => onMove(conversation.id, p.id))}>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
            </button>
          ))}
          {conversation.projectId && (
            <button role="menuitem" className={item} onClick={pick(() => onMove(conversation.id, null))}>
              <MessageSquare size={12} className="shrink-0" /> <span className="min-w-0 flex-1 truncate">No project (quick chat)</span>
            </button>
          )}
          <button role="menuitem" className={`${item} ${targets.length > 0 || conversation.projectId ? 'mt-1 border-t border-border pt-2' : ''}`} onClick={pick(() => onNewProject(conversation.id))}>
            <FolderPlus size={12} className="shrink-0" /> <span className="min-w-0 flex-1 truncate">New project from this chat</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
