// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLine } from './ActivityLine';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => vi.useRealTimers());

const live = (over = {}) => ({ running: true, parts: [], startedAt: 100_000, lastEventAt: 100_000, ...over });

describe('ActivityLine', () => {
  it('counts up while the model has not answered, by itself', () => {
    render(<ActivityLine live={live()} awaitingApproval={false} />);
    expect(screen.getByRole('status').textContent).toBe('Thinking… 0 s');
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByRole('status').textContent).toBe('Thinking… 5 s');
  });

  it('turns into "No response" when text stops coming', () => {
    render(<ActivityLine live={live({ parts: [{ type: 'text', text: 'x' }] })} awaitingApproval={false} />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => void vi.advanceTimersByTime(16_000));
    expect(screen.getByRole('status').textContent).toBe('No response for 16 s');
  });

  it('is absent when the turn is not running or waits for approval', () => {
    const { container, rerender } = render(<ActivityLine live={live({ running: false })} awaitingApproval={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ActivityLine live={live()} awaitingApproval />);
    expect(container).toBeEmptyDOMElement();
  });
});
