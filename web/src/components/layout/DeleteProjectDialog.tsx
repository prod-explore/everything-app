import { useEffect, useState, type ReactNode } from 'react';
import { deleteProject, getProjectDeletionPreview } from '../../api';
import { formatSize } from '../../lib/format';
import type { ProjectDeletionPreview } from '../../types';
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

/**
 * Confirmation for deleting a project. It shows the server's dry run — the chats, the work that is stopped, every
 * sandbox with its workspace files (with sizes) and running processes — and deletes only after that loaded, so the
 * user confirms exactly what goes. Nothing is kept.
 */
export function DeleteProjectDialog({ projectId, onCancel, onDeleted }: { projectId: string; onCancel: () => void; onDeleted: () => void }) {
  const [preview, setPreview] = useState<ProjectDeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProjectDeletionPreview(projectId).then(
      p => { if (!cancelled) setPreview(p); },
      (e: Error) => { if (!cancelled) setLoadError(e.message); },
    );
    return () => { cancelled = true; };
  }, [projectId]);

  async function confirm() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(projectId);
      onDeleted();
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  }

  const files = preview?.sandboxes.flatMap(s => (s.workspace ? [s.workspace.totalBytes] : [])).reduce((a, b) => a + b, 0) ?? 0;
  const processes = preview?.sandboxes.reduce((n, s) => n + s.processes.length, 0) ?? 0;

  return (
    <Modal title={preview ? `Delete “${preview.project.name}”?` : 'Delete project?'} onClose={deleting ? () => undefined : onCancel} wide>
      {!preview && !loadError && <p className="text-sm text-fg-tertiary">Checking what the project contains…</p>}
      {loadError && (
        <p className="text-sm text-danger" role="alert">
          Couldn't find out what would be removed, so the project can't be deleted right now: {loadError}
        </p>
      )}
      {preview && (
        <div className="space-y-4">
          <p className="text-sm text-fg-secondary">
            This removes everything below for good. {files > 0 && <>Workspace files: <strong>{formatSize(files)}</strong>. </>}
            {processes > 0 && <>{processes} running {processes === 1 ? 'process' : 'processes'} will be killed.</>}
          </p>

          <Section title={`Chats (${preview.conversations.length})`}>
            {preview.conversations.length === 0 ? (
              <p className="text-xs text-fg-tertiary">None.</p>
            ) : (
              <ul className={listClass}>
                {preview.conversations.slice(0, LIST_LIMIT).map(c => (
                  <li key={c.id} className="flex gap-2 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-fg">{c.title || 'Untitled'}</span>
                    <span className="shrink-0 text-fg-tertiary">{c.messageCount} {c.messageCount === 1 ? 'message' : 'messages'}</span>
                  </li>
                ))}
                {preview.conversations.length > LIST_LIMIT && <li className="px-3 py-1.5 text-fg-tertiary">and {preview.conversations.length - LIST_LIMIT} more</li>}
              </ul>
            )}
            {(preview.agentTranscripts > 0 || preview.snapshots > 0) && (
              <p className="mt-1 text-xs text-fg-tertiary">
                {[
                  preview.agentTranscripts > 0 && `${preview.agentTranscripts} agent ${preview.agentTranscripts === 1 ? 'transcript' : 'transcripts'}`,
                  preview.snapshots > 0 && `${preview.snapshots} report ${preview.snapshots === 1 ? 'snapshot' : 'snapshots'}`,
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

          {preview.sandboxes.length === 0 ? (
            <Section title="Sandbox">
              <p className="text-xs text-fg-tertiary">The project has no sandbox yet.</p>
            </Section>
          ) : (
            preview.sandboxes.map(s => (
              <Section key={s.owner} title={s.conversationTitle ? `Sandbox of the chat “${s.conversationTitle}”` : 'Project sandbox'}>
                <p className="mb-1 text-xs text-fg-tertiary">
                  {s.containers} {s.containers === 1 ? 'container' : 'containers'} ({s.running ? 'running' : 'stopped'})
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
          {deleting ? 'Deleting…' : 'Delete project'}
        </Button>
      </div>
    </Modal>
  );
}
