// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueuedMessages, type MessageQueueControls } from './QueuedMessages';

let running = true;
vi.mock('@assistant-ui/react', () => ({ useAuiState: (select: (s: unknown) => unknown) => select({ thread: { isRunning: running } }) }));

function controls(over: Partial<MessageQueueControls> = {}): MessageQueueControls {
  return {
    items: [{ id: 1, text: 'first', images: 0 }, { id: 2, text: 'second', images: 2 }],
    paused: false,
    interruptNext: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(),
    sendNow: vi.fn(),
    ...over,
  };
}

describe('QueuedMessages', () => {
  it('renders nothing for an empty queue', () => {
    const { container } = render(<QueuedMessages queue={controls({ items: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the next message and numbers the rest', () => {
    render(<QueuedMessages queue={controls()} />);
    expect(screen.getByText('next')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
  });

  it('shows that a waiting message carries images', () => {
    render(<QueuedMessages queue={controls()} />);
    expect(screen.getByLabelText('2 images')).toBeTruthy();
  });

  it('says "paused" when the line is stuck behind a failed turn', () => {
    render(<QueuedMessages queue={controls({ paused: true })} />);
    expect(screen.getByText('paused')).toBeTruthy();
  });

  it('sends a message now, or removes it', async () => {
    const q = controls();
    render(<QueuedMessages queue={q} />);
    await userEvent.click(screen.getAllByLabelText('Stop the assistant and send now')[1]);
    expect(q.sendNow).toHaveBeenCalledWith(2);
    await userEvent.click(screen.getAllByLabelText('Remove from queue')[0]);
    expect(q.remove).toHaveBeenCalledWith(1);
  });

  it('edits a message in place and saves with Enter', async () => {
    const q = controls();
    render(<QueuedMessages queue={q} />);
    await userEvent.click(screen.getAllByLabelText('Edit')[0]);
    const box = screen.getByLabelText('Edit queued message');
    await userEvent.clear(box);
    await userEvent.type(box, 'changed{Enter}');
    expect(q.edit).toHaveBeenCalledWith(1, 'changed');
  });

  it('does not save an edit that was cancelled with Escape', async () => {
    const q = controls();
    render(<QueuedMessages queue={q} />);
    await userEvent.click(screen.getAllByLabelText('Edit')[0]);
    await userEvent.type(screen.getByLabelText('Edit queued message'), 'x{Escape}');
    expect(q.edit).not.toHaveBeenCalled();
  });

  it('offers a plain "Send now" when nothing is running', () => {
    running = false;
    render(<QueuedMessages queue={controls()} />);
    expect(screen.getAllByLabelText('Send now')).toHaveLength(2);
    running = true;
  });
});
