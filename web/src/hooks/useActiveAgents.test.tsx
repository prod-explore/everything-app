import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveAgentCount } from './useActiveAgents';

const listConversationRuns = vi.fn();
vi.mock('../api', () => ({ listConversationRuns: (id: string) => listConversationRuns(id) }));

const run = (status: string, depth = 1) => ({ id: `${status}-${depth}-${Math.random()}`, status, depth });

beforeEach(() => listConversationRuns.mockReset());

describe('useActiveAgentCount', () => {
  it('counts active workers only — not the root run and not finished ones', async () => {
    listConversationRuns.mockResolvedValue({ runs: [run('running', 0), run('running'), run('waiting_input'), run('waiting_children'), run('done'), run('error'), run('aborted')] });
    const { result } = renderHook(() => useActiveAgentCount('c1', 0));
    await waitFor(() => expect(result.current).toBe(3));
  });

  it('reloads when the refresh key changes', async () => {
    listConversationRuns.mockResolvedValueOnce({ runs: [run('running')] }).mockResolvedValueOnce({ runs: [run('done')] });
    const { result, rerender } = renderHook(({ k }) => useActiveAgentCount('c1', k), { initialProps: { k: 0 } });
    await waitFor(() => expect(result.current).toBe(1));
    rerender({ k: 1 });
    await waitFor(() => expect(result.current).toBe(0));
  });

  it("doesn't show the previous chat's number while the next chat loads", async () => {
    listConversationRuns.mockResolvedValueOnce({ runs: [run('running'), run('running')] }).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ id }) => useActiveAgentCount(id, 0), { initialProps: { id: 'c1' } });
    await waitFor(() => expect(result.current).toBe(2));
    rerender({ id: 'c2' });
    expect(result.current).toBe(0);
  });

  it('is 0 without a chat, and keeps the last number when a request fails', async () => {
    const { result: none } = renderHook(() => useActiveAgentCount(null, 0));
    expect(none.current).toBe(0);
    expect(listConversationRuns).not.toHaveBeenCalled();
    listConversationRuns.mockResolvedValueOnce({ runs: [run('running')] }).mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(({ k }) => useActiveAgentCount('c1', k), { initialProps: { k: 0 } });
    await waitFor(() => expect(result.current).toBe(1));
    rerender({ k: 1 });
    await waitFor(() => expect(listConversationRuns).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(1);
  });
});
