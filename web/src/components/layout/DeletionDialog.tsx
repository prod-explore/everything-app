import { useEffect, useState, type ReactNode } from 'react';
import { deleteConversation, deleteProject, getDeletionPreview } from '../../api';
import { formatSize } from '../../lib/format';
import type { DeletionPreview, DeletionTarget } from '../../types';
import { Button } from '../shared/Button';
import { Modal } from '../shared/Modal';

/** Most entries a list shows; the rest are summed up in one line. */
const LIST_LIMIT = 50;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-sm font-medium text-fg">{title}</h3>
      {children}
    </section>
  );
}

const listClass = 'max-h-48 divide-y divide-border overflow-y-auto rounded-button border border-border text-xs';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function sandboxTitle(preview: DeletionPreview, s: DeletionPreview['sandboxes'][number]): string {
  if (s.conversationTitle) return `Sandbox of the chat “${s.conversationTitle}”`;
  return preview.target.kind === 'project' ? 'Project sandbox' : 'Sandbox of this chat';
}

/**
 * Confirmation for deleting a project or a chat. It shows the server's dry run — the chats, the work that is stopped,
 * scheduled tasks, Gazeta items, every sandbox with its workspace files (with sizes) and running processes — and deletes
 * only after that loaded, so the user confirms exactly what goes. Nothing is kept. `remove` replaces the plain API call
 * (e.g. a hook that also refreshes a list).
 */
export function DeletionDialog({ target, onCancel, onDeleted, remove }: {
  target: DeletionTarget;
  onCancel: () => void;
  onDeleted: () => void;
  remove?: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { kind, id } = target;
  const noun = kind === 'project' ? 'project' : 'chat';

  useEffect(() => {
    let cancelled = false;
    getDeletionPreview({ kind, id }).then(
      p => { if (!cancelled) setPreview(p); },
      (e: Error) => { if (!cancelled) setLoadError(e.message); },
    );
    return () => { cancelled = true; };
  }, [kind, id]);

  async function confirm() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await (remove ? remove() : kind === 'project' ? deleteProject(id) : deleteConversation(id));
      onDeleted();
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  }

  const files = preview?.sandboxes.reduce((n, s) => n + (s.workspace?.totalBytes ?? 0), 0) ?? 0;
  const processes = preview?.sandboxes.reduce((n, s) => n + s.processes.length, 0) ?? 0;
  const title = preview ? `Delete “${preview.target.name || 'Untitled'}”?` : `Delete ${noun}?`;

  return (
    <Modal title={title} onClose={deleting ? () => undefined : onCancel} wide>
      {!preview && !loadError && <p className="text-sm text-fg-tertiary">Checking what the {noun} contains…</p>}
      {loadError && (
        <p className="text-sm text-danger" role="alert">
          Couldn't find out what would be removed, so the {noun} can't be deleted right now: {loadError}
        </p>
      )}
      {preview && (
        <div className="space-y-4">
          <p className="text-sm text-fg-secondary">
            This removes everything below for good. {files > 0 && <>Workspace files: <strong>{formatSize(files)}</strong>. </>}
            {processes > 0 && <>{plural(processes, 'running process', 'running processes')} will be killed.</>}
          </p>

          <Section title={`Chats (${preview.conversations.length})`}>
            {preview.conversations.length === 0 ? (
              <p className="text-xs text-fg-tertiary">None.</p>
            ) : (
              <ul className={listClass}>
                {preview.conversations.slice(0, LIST_LIMIT).map(c => (
                  <li key={c.id} className="flex gap-2 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-fg">{c.title || 'Untitled'}</span>
                    <span className="shrink-0 text-fg-tertiary">{plural(c.messageCount, 'message', 'messages')}</span>
                  </li>
                ))}
                {preview.conversations.length > LIST_LIMIT && <li className="px-3 py-1.5 text-fg-tertiary">and {preview.conversations.length - LIST_LIMIT} more</li>}
              </ul>
            )}
            {(preview.agentTranscripts > 0 || preview.snapshots > 0) && (
              <p className="mt-1 text-xs text-fg-tertiary">
                {[
                  preview.agentTranscripts > 0 && plural(preview.agentTranscripts, 'agent transcript', 'agent transcripts'),
                  preview.snapshots > 0 && plural(preview.snapshots, 'report snapshot', 'report snapshots'),
                ].filter(Boolean).join(', ')} go with them.
              </p>
            )}
          </Section>

          {preview.running.length > 0 && (
            <Section title={`Stopped now (${preview.running.length})`}>
              <ul className={listClass}>
                {preview.running.map(r => (
                  <li key={r.runId} className="flex gap-2 px-3 py-1.5">
                    <span className="shrink-0 text-fg-tertiary">{r.kind === 'chat' ? 'Chat turn' : 'Agent'}</span>
                    <span className="min-w-0 flex-1 truncate text-fg">{r.label}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {preview.schedules.length > 0 && (
            <Section title={`Scheduled tasks (${preview.schedules.length})`}>
              <ul className={listClass}>
                {preview.schedules.map(s => <li key={s.id} className="truncate px-3 py-1.5 text-fg">{s.name}</li>)}
              </ul>
            </Section>
          )}

          {preview.gazetaItems.length > 0 && (
            <Section title={`Gazeta items (${preview.gazetaItems.length})`}>
              <ul className={listClass}>
                {preview.gazetaItems.slice(0, LIST_LIMIT).map(g => (
                  <li key={g.id} className="flex gap-2 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-fg">{g.title}</span>
                    <span className="shrink-0 text-fg-tertiary">{g.status}</span>
                  </li>
                ))}
                {preview.gazetaItems.length > LIST_LIMIT && <li className="px-3 py-1.5 text-fg-tertiary">and {preview.gazetaItems.length - LIST_LIMIT} more</li>}
              </ul>
            </Section>
          )}

          {preview.sandboxes.length === 0 ? (
            <Section title="Sandbox">
              <p className="text-xs text-fg-tertiary">The {noun} has no sandbox.</p>
            </Section>
          ) : (
            preview.sandboxes.map(s => (
              <Section key={s.owner} title={sandboxTitle(preview, s)}>
                <p className="mb-1 text-xs text-fg-tertiary">
                  {plural(s.containers, 'container', 'containers')} ({s.running ? 'running' : 'stopped'})
                  {s.workspace ? `, workspace ${formatSize(s.workspace.totalBytes)}` : ', no workspace'}
                </p>
                {s.workspace && s.workspace.entries.length > 0 && (
                  <ul className={listClass} aria-label="Workspace files">
                    {s.workspace.entries.slice(0, LIST_LIMIT).map(e => (
                      <li key={e.name} className="flex gap-2 px-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-fg">{e.name}{e.type === 'directory' ? '/' : ''}</span>
                        <span className="shrink-0 text-fg-tertiary">{formatSize(e.bytes)}</span>
                      </li>
                    ))}
                    {s.workspace.entries.length > LIST_LIMIT && (
                      <li className="px-3 py-1.5 text-fg-tertiary">
                        and {s.workspace.entries.length - LIST_LIMIT} more ({formatSize(s.workspace.entries.slice(LIST_LIMIT).reduce((n, e) => n + e.bytes, 0))})
                      </li>
                    )}
                  </ul>
                )}
                {s.processes.length > 0 && (
                  <ul className={`${listClass} mt-2`} aria-label="Running processes">
                    {s.processes.map(p => (
                      <li key={p.pid} className="flex gap-2 px-3 py-1.5 font-mono">
                        <span className="shrink-0 text-fg-tertiary">{p.pid}</span>
                        <span className="min-w-0 flex-1 truncate text-fg">{p.command}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            ))
          )}
        </div>
      )}
      {deleteError && <p className="mt-3 text-xs text-danger" role="alert">{deleteError}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={deleting}>Cancel</Button>
        <Button variant="danger" onClick={() => void confirm()} disabled={!preview || deleting}>
          {deleting ? 'Deleting…' : `Delete ${noun}`}
        </Button>
      </div>
    </Modal>
  );
}
