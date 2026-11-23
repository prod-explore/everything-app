// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetryNotice } from '../../hooks/useSSE';
import { RetryStatus } from './RetryStatus';
import { describeRetry, formatWait } from './retryText';

const notice = (over: Partial<RetryNotice> = {}): RetryNotice => ({ provider: 'MindGate', attempt: 1, status: 429, delayMs: 12_000, remainingMs: 108_000, receivedAt: Date.now(), ...over });

describe('describeRetry', () => {
  it('counts down from the moment the event arrived and names the attempt that is coming', () => {
    const r = notice({ receivedAt: 1000 });
    expect(describeRetry(r, 1000).text).toBe('MindGate is rate-limiting requests — retrying in 12 s (attempt 2)');
    expect(describeRetry(r, 8000).text).toContain('retrying in 5 s');
    const late = describeRetry(r, 13_000);
    expect(late.text).toContain('retrying now');
    expect(late.waiting).toBe(false);
  });

  it('words a dropped connection and a 5xx differently, and reports the time left in the window', () => {
    expect(describeRetry(notice({ status: 'network' }), 0).text).toMatch(/^can't reach MindGate/);
    expect(describeRetry(notice({ status: 503, receivedAt: 0 }), 0).text).toMatch(/^MindGate is busy \(HTTP 503\)/);
    expect(describeRetry(notice({ receivedAt: 0 }), 60_000).giveUpIn).toBe(48_000);
    expect(describeRetry(notice({ remainingMs: 0 }), 0).giveUpIn).toBeNull();
  });

  it('words a model that went silent or answered with nothing, and retries at once', () => {
    const silent = describeRetry(notice({ status: 'timeout', delayMs: 0, remainingMs: 0, receivedAt: 0 }), 0);
    expect(silent.text).toBe('MindGate went silent before answering — retrying now (attempt 2)');
    expect(silent.waiting).toBe(false);
    expect(silent.giveUpIn).toBeNull();
    expect(describeRetry(notice({ status: 'empty', delayMs: 0, remainingMs: 0, receivedAt: 0 }), 0).text).toBe('MindGate returned an empty answer — retrying now (attempt 2)');
  });

  it('formats waits', () => {
    expect([formatWait(400), formatWait(12_000), formatWait(120_000), formatWait(7_200_000)]).toEqual(['1 s', '12 s', '2 min', '2 h 0 min']);
  });
});

describe('RetryStatus', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => vi.useRealTimers());

  it('renders nothing without a notice', () => {
    const { container } = render(<RetryStatus running />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ticks down live while the turn runs', () => {
    render(<RetryStatus retry={notice({ receivedAt: 0 })} running />);
    expect(screen.getByText(/retrying in 12 s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText(/retrying in 7 s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByText(/retrying now/)).toBeTruthy();
  });

  it('on an idle chat the notice expires after its wait plus a grace period', () => {
    render(<RetryStatus retry={notice({ receivedAt: 0 })} running={false} />);
    expect(screen.getByText(/retrying in/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(12_000 + 31_000); });
    expect(screen.queryByText(/retrying/)).toBeNull();
  });

  it('keeps one stable sentence for screen readers', () => {
    render(<RetryStatus retry={notice({ attempt: 2 })} running />);
    expect(screen.getByRole('status').textContent).toBe('MindGate is rate-limiting requests — retrying (attempt 3)');
  });
});
