import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GazetaContext, type GazetaStore } from '../../hooks/useGazeta';
import type { GazetaItem, PendingApproval } from '../../types';

const api = vi.hoisted(() => ({ getGazetaItems: vi.fn(), artifactFileUrl: vi.fn(() => '#') }));
vi.mock('../../api', () => api);

import { GazetaView } from './GazetaView';

const report = (over: Partial<GazetaItem> = {}): GazetaItem => ({
  id: 'g1',
  type: 'report',
  conversationId: null,
  projectId: null,
  runId: null,
  agent: 'schedule',
  urgent: false,
  attachments: null,
  title: 'Morning news',
  description: 'All quiet.',
  inputSchema: null,
  response: null,
  status: 'pending',
  createdAt: '2026-10-23 08:00:00',
  respondedAt: null,
  ...over,
});

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'a1',
  conversationId: 'c1',
  toolLabel: 'obsidian/write_note',
  args: { path: 'a.md' },
  dangerous: false,
  createdAt: '2026-10-23T07:00:00.000Z',
  ...over,
});

const store = (items: GazetaItem[]): GazetaStore =>
  ({
    byId: Object.fromEntries(items.map(i => [i.id, i])),
    pending: items,
    urgentCount: 0,
    arrivals: [],
    delivered: {},
    loading: false,
    muted: true,
    setMuted: vi.fn(),
    refresh: vi.fn(async () => {}),
    upsert: vi.fn(),
    respond: vi.fn(),
    dismiss: vi.fn(),
    bulkDismiss: vi.fn(),
    handleEvent: vi.fn(),
  }) as unknown as GazetaStore;

function open(approvals: PendingApproval[], over: Partial<React.ComponentProps<typeof GazetaView>> = {}, items: GazetaItem[] = [report()]) {
  // Like the server: the type filter is applied there.
  api.getGazetaItems.mockImplementation(async (q: { type?: string }) => ({ items: items.filter(i => !q.type || i.type === q.type) }));
  const respond = vi.fn(async () => {});
  const utils = render(
    <GazetaContext.Provider value={store(items)}>
      <GazetaView onClose={vi.fn()} projects={[]} approvals={approvals} onApproval={respond} {...over} />
    </GazetaContext.Provider>,
  );
  return { respond, ...utils };
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});

describe('Gazeta lists the calls waiting in the approval gate', () => {
  it('shows a pending call as an entry, with the same card as in a chat, and answers it through the same gate', async () => {
    const { respond } = open([approval()]);
    const card = await screen.findByRole('group', { name: 'Tool call requires approval' });
    expect(within(card).getByText('obsidian/write_note')).toBeInTheDocument();
    for (const name of ['Deny', 'Approve once', 'For this chat', 'Always']) expect(within(card).getByRole('button', { name })).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'For this chat' }));
    expect(respond).toHaveBeenCalledWith('a1', true, 'chat');
  });

  it('puts a waiting call above the other entries, like an urgent item', async () => {
    open([approval()], {}, [report({ createdAt: '2026-10-23 12:00:00' })]);
    await screen.findByText('Morning news');
    const card = screen.getByRole('group', { name: 'Tool call requires approval' });
    const article = screen.getByRole('article', { name: /Morning news/ });
    expect(card.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says who is waiting when a scheduled run is paused on the call', async () => {
    open([approval({ note: 'Scheduled task "Morning news" is paused on this call. If nobody answers within 30 min, it goes on without it.' })]);
    expect(await screen.findByText(/Morning news" is paused on this call/)).toBeInTheDocument();
  });

  it('a request of a run that did not wait offers only Dismiss and "Always allow"', async () => {
    const { respond } = open([approval({ late: true, note: 'Scheduled task "Morning news" did not wait for this and went on without it.' })]);
    const card = await screen.findByRole('group', { name: 'Tool call requires approval' });
    expect(within(card).queryByRole('button', { name: 'Approve once' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'For this chat' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Always allow' }));
    expect(respond).toHaveBeenCalledWith('a1', true, 'always');
  });

  it('follows the type and project filters, and is not offered a bulk dismiss', async () => {
    open([approval({ projectId: 'p1' })], { projects: [{ id: 'p1', name: 'Work', conversationCount: 0 } as never] });
    await screen.findByRole('group', { name: 'Tool call requires approval' });

    await userEvent.selectOptions(screen.getByLabelText('Type'), 'report');
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Tool call requires approval' })).toBeNull());
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'approval');
    expect(await screen.findByRole('group', { name: 'Tool call requires approval' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Select all open')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Type'), '');
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'p1');
    expect(await screen.findByRole('group', { name: 'Tool call requires approval' })).toBeInTheDocument();
  });

  it('opens the chat the call came from', async () => {
    const onOpenConversation = vi.fn();
    const onClose = vi.fn();
    open([approval({ conversationId: 'run-chat' })], { onOpenConversation, onClose });
    await userEvent.click(await screen.findByRole('button', { name: /Open originating chat/ }));
    expect(onOpenConversation).toHaveBeenCalledWith('run-chat');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows nothing about approvals when there are none, and the empty state when there is nothing at all', async () => {
    open([], {}, []);
    expect(await screen.findByText('Nothing waiting for you.')).toBeInTheDocument();
  });
});
