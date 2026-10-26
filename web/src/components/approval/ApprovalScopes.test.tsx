import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../../types';
import { ApprovalCard } from './InlineApprovals';
import { ApprovalModal } from './ApprovalModal';

const shell = (over: Partial<PendingApproval>): PendingApproval => ({
  id: 'a1',
  conversationId: 'c1',
  toolLabel: 'sandbox/run_bash',
  args: { command: 'x' },
  dangerous: false,
  createdAt: '2026-10-26T12:00:00Z',
  ...over,
});

const commit = shell({
  args: { command: 'git commit -m x' },
  commands: [{ command: 'git commit -m x', prefix: 'git commit', decision: 'ask', reason: 'strict mode' }],
  covers: ['git commit'],
});
const reset = shell({
  args: { command: 'git add . && git reset --soft HEAD~1' },
  commands: [
    { command: 'git add .', prefix: 'git add', decision: 'ask', reason: 'strict mode' },
    { command: 'git reset --soft HEAD~1', prefix: 'git reset', decision: 'ask', reason: 'strict mode', destructive: true },
  ],
  covers: ['git add', 'git reset'],
  maxScope: 'chat',
});

describe('ApprovalCard: what a grant covers and how wide it may go', () => {
  it('says which commands a remembered approval covers', () => {
    render(<ApprovalCard approval={commit} respond={vi.fn()} />);
    expect(screen.getByText(/“For this chat” or “Always” covers/)).toHaveTextContent('covers all git commit … commands.');
    expect(screen.getByRole('button', { name: 'Always' })).toBeInTheDocument();
  });

  it('offers a destructive command once or for this chat only', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalCard approval={reset} respond={respond} />);
    expect(screen.queryByRole('button', { name: 'Always' })).not.toBeInTheDocument();
    expect(screen.getByText(/“For this chat” covers/)).toHaveTextContent('all git add … commands and all git reset … commands. This command is destructive');
    expect(screen.getByText(/· destructive/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'For this chat' }));
    expect(respond).toHaveBeenCalledWith('a1', true, 'chat');
  });

  it('a late destructive request cannot be turned into a standing grant', () => {
    render(<ApprovalCard approval={{ ...reset, late: true }} respond={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});

describe('ApprovalModal: scope picker', () => {
  it('hides "this project" and "always" for a destructive command, also from the keyboard', async () => {
    const onRespond = vi.fn();
    render(<ApprovalModal approval={reset} onRespond={onRespond} projectId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: /Approve…/ }));
    expect(screen.getByRole('button', { name: /Approve for this chat/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve for this project/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Always approve/ })).not.toBeInTheDocument();
    await userEvent.keyboard('a');
    await userEvent.keyboard('p');
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('keeps every scope for an ordinary command', async () => {
    render(<ApprovalModal approval={commit} onRespond={vi.fn()} projectId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: /Approve…/ }));
    expect(screen.getByRole('button', { name: /Approve for this project/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Always approve/ })).toBeInTheDocument();
    expect(screen.getByText(/Remembering this covers/)).toHaveTextContent('all git commit … commands');
  });
});
