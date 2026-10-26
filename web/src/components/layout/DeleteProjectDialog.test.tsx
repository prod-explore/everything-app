import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDeletionPreview } from '../../types';
import { DeleteProjectDialog } from './DeleteProjectDialog';

afterEach(() => vi.unstubAllGlobals());

const PREVIEW: ProjectDeletionPreview = {
  project: { id: 'p1', name: 'Shop' },
  conversations: [{ id: 'c1', title: 'Checkout bug', messageCount: 12 }],
  agentTranscripts: 2,
  running: [{ runId: 'r1', kind: 'agent', label: 'test-runner' }],
  sandboxes: [
    {
      owner: 'p1',
      containers: 1,
      running: true,
      workspace: { entries: [{ name: 'node_modules', type: 'directory', bytes: 3 * 1024 * 1024 }, { name: 'index.ts', type: 'file', bytes: 512 }], totalBytes: 3 * 1024 * 1024 + 512 },
      processes: [{ pid: 40, command: 'node server.js --port 5173' }],
    },
  ],
  snapshots: 1,
  schedules: [{ id: 's1', name: 'Nightly test run' }],
  gazetaItems: [{ id: 'g1', title: 'Which branch should I use?', status: 'pending' }],
};

/** fetch stub: the preview, then whatever DELETE answers. Records the calls. */
function server(preview: { status: number; body: unknown }, del: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const r = method === 'DELETE' ? del : preview;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
  return calls;
}

describe('DeleteProjectDialog', () => {
  it('lists what the server says will be removed: chats, stopped work, schedules, Gazeta items, files with sizes, processes', async () => {
    server({ status: 200, body: PREVIEW });
    render(<DeleteProjectDialog projectId="p1" onCancel={vi.fn()} onDeleted={vi.fn()} />);
    expect(await screen.findByRole('dialog', { name: 'Delete “Shop”?' })).toBeInTheDocument();
    expect(screen.getByText('Checkout bug')).toBeInTheDocument();
    expect(screen.getByText('12 messages')).toBeInTheDocument();
    expect(screen.getByText(/2 agent transcripts, 1 report snapshot go with them/)).toBeInTheDocument();
    expect(screen.getByText('test-runner')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Scheduled tasks (1)' })).getByText('Nightly test run')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Gazeta items (1)' })).getByText('Which branch should I use?')).toBeInTheDocument();
    const files = within(screen.getByRole('list', { name: 'Workspace files' }));
    expect(files.getByText('node_modules/')).toBeInTheDocument();
    expect(files.getByText('3.0 MB')).toBeInTheDocument();
    expect(files.getByText('512 B')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Running processes' })).getByText('node server.js --port 5173')).toBeInTheDocument();
    expect(screen.getByText(/1 running process will be killed/)).toBeInTheDocument();
    // Nothing to keep: one way to delete, everything goes.
    expect(screen.queryByRole('button', { name: /keep/i })).not.toBeInTheDocument();
  });

  it('deletes only on confirmation, without any keep option in the request', async () => {
    const calls = server({ status: 200, body: PREVIEW });
    const onDeleted = vi.fn();
    render(<DeleteProjectDialog projectId="p1" onCancel={vi.fn()} onDeleted={onDeleted} />);
    await screen.findByText('Checkout bug');
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([{ url: '/api/projects/p1', method: 'DELETE' }]);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it('cannot delete when the preview failed', async () => {
    server({ status: 502, body: { error: 'supervisor down' } });
    render(<DeleteProjectDialog projectId="p1" onCancel={vi.fn()} onDeleted={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/can't be deleted right now: supervisor down/);
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeDisabled();
  });

  it('shows why a deletion failed and keeps the dialog open', async () => {
    server({ status: 200, body: PREVIEW }, { status: 502, body: { error: 'The project was not deleted: its sandbox could not be removed' } });
    const onDeleted = vi.fn();
    render(<DeleteProjectDialog projectId="p1" onCancel={vi.fn()} onDeleted={onDeleted} />);
    await screen.findByText('Checkout bug');
    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/sandbox could not be removed/);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeEnabled();
  });
});
