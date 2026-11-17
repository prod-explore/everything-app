import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_STATE, liveTurnReducer, useSSE, type LiveTurnAction, type LiveTurnState } from './useSSE';

const { getTurnStatus, getMessageQueue } = vi.hoisted(() => ({ getTurnStatus: vi.fn(), getMessageQueue: vi.fn() }));
vi.mock('../api', () => ({ getTurnStatus, getMessageQueue }));

const run = (actions: LiveTurnAction[], from: LiveTurnState = INITIAL_STATE) => actions.reduce(liveTurnReducer, from);

describe('liveTurnReducer', () => {
  it('streams text into one part and replaces it with the complete block', () => {
    const s = run([
      { type: 'start' },
      { type: 'text_delta', block: 0, text: 'Hel' },
      { type: 'text_delta', block: 0, text: 'lo' },
    ]);
    expect(s.running).toBe(true);
    expect(s.parts).toEqual([{ type: 'text', text: 'Hello', block: 0, streaming: true }]);
    const done = liveTurnReducer(s, { type: 'text', text: 'Hello!' });
    expect(done.parts).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  it('appends a complete block when no partial one exists (provider without streaming, or a reconnect)', () => {
    const s = run([{ type: 'start' }, { type: 'text', text: 'whole' }]);
    expect(s.parts).toEqual([{ type: 'text', text: 'whole' }]);
  });

  it('starts a new text part for a new block', () => {
    const s = run([{ type: 'start' }, { type: 'text_delta', block: 0, text: 'a' }, { type: 'tool_use', label: 'x' }, { type: 'text_delta', block: 1, text: 'b' }]);
    expect(s.parts.map(p => p.type)).toEqual(['text', 'tool', 'text']);
  });

  it('merges consecutive thinking deltas', () => {
    const s = run([{ type: 'start' }, { type: 'thinking_delta', text: 'a' }, { type: 'thinking_delta', text: 'b' }]);
    expect(s.parts).toMatchObject([{ type: 'reasoning', text: 'ab' }]);
  });

  it('attaches each tool result to the oldest call still waiting for one', () => {
    const s = run([
      { type: 'start' },
      { type: 'tool_use', label: 'first' },
      { type: 'tool_use', label: 'second' },
      { type: 'tool_result', toolName: 'run_bash', truncatedOutput: 'one', isError: false, wasTruncated: false },
      { type: 'tool_result', toolName: 'read_file', truncatedOutput: 'two', isError: true, wasTruncated: true },
    ]);
    expect(s.parts).toMatchObject([
      { type: 'tool', call: { label: 'first', toolName: 'run_bash', result: { truncatedOutput: 'one', isError: false } } },
      { type: 'tool', call: { label: 'second', toolName: 'read_file', result: { truncatedOutput: 'two', isError: true, wasTruncated: true } } },
    ]);
  });

  it('ignores a tool result with no call waiting', () => {
    const before = run([{ type: 'start' }]);
    expect(liveTurnReducer(before, { type: 'tool_result', toolName: 'x', truncatedOutput: '', isError: false, wasTruncated: false })).toBe(before);
  });

  it('clears the live parts when a turn finishes, so the persisted copy is not shown twice', () => {
    const s = run([{ type: 'start' }, { type: 'text', text: 'answer' }, { type: 'finish' }]);
    expect(s).toMatchObject({ running: false, parts: [], finishedCount: 1, error: undefined });
  });

  it('keeps the error and its kind after a failed turn', () => {
    const s = run([{ type: 'start' }, { type: 'finish', error: 'rate limited', kind: 'rate_limited', detail: '429' }]);
    expect(s).toMatchObject({ running: false, error: 'rate limited', errorKind: 'rate_limited', errorDetail: '429' });
  });

  it('keeps the context size and conversation state across turns, and counts compactions', () => {
    const s = run([{ type: 'context', used: 100, limit: 1000 }, { type: 'compacted' }, { type: 'start' }]);
    expect(s.context).toEqual({ used: 100, limit: 1000 });
    expect(s.compactedCount).toBe(1);
  });

  it('stamps when the turn started and when it last showed life', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let s = run([{ type: 'start' }]);
    expect(s).toMatchObject({ startedAt: 1000, lastEventAt: 1000, continuing: false, startedCount: 1 });
    vi.setSystemTime(6000);
    s = run([{ type: 'text_delta', block: 0, text: 'a' }], s);
    expect(s).toMatchObject({ startedAt: 1000, lastEventAt: 6000 });
    vi.useRealTimers();
  });

  it('times the model reasoning: it ends when anything else arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let s = run([{ type: 'start' }, { type: 'thinking_delta', text: 'hm' }]);
    expect(s.parts[0]).toMatchObject({ type: 'reasoning', startedAt: 1000 });
    expect((s.parts[0] as { endedAt?: number }).endedAt).toBeUndefined();
    vi.setSystemTime(4000);
    s = run([{ type: 'text_delta', block: 0, text: 'x' }], s);
    expect(s.parts[0]).toMatchObject({ type: 'reasoning', startedAt: 1000, endedAt: 4000 });
    vi.useRealTimers();
  });

  it('a start can mark the turn as carrying on a cut-short reply', () => {
    expect(run([{ type: 'start', continuing: true }]).continuing).toBe(true);
  });

  it('keeps what the turn showed in `held` after it ends, until released', () => {
    let s = run([{ type: 'start' }, { type: 'text', text: 'partial' }, { type: 'finish', error: 'cut', kind: 'aborted' }]);
    expect(s).toMatchObject({ running: false, parts: [], held: [{ type: 'text', text: 'partial' }], startedAt: null, lastEventAt: null });
    s = run([{ type: 'release' }], s);
    expect(s.held).toEqual([]);
    expect(run([{ type: 'start' }], s).held).toEqual([]);
  });

  it('a snapshot joins a running turn with its text and puts the clocks back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const s = run([{
      type: 'snapshot',
      snapshot: {
        turnId: 3, userMessageId: 9, continuing: true, elapsedMs: 12_000, idleMs: 4000, at: 555,
        parts: [{ type: 'reasoning', text: 'r', startedAt: 500, endedAt: 540 }, { type: 'text', text: 'so far' }],
      },
    }]);
    expect(s).toMatchObject({ running: true, continuing: true, startedAt: 88_000, lastEventAt: 96_000, startedCount: 1 });
    expect(s.parts[0]).toMatchObject({ startedAt: 100_000 - 55, endedAt: 100_000 - 15 });
    expect(s.parts[1]).toEqual({ type: 'text', text: 'so far' });
    vi.useRealTimers();
  });

  it('restores the error of a turn this page never saw, but never over a running turn or a known error', () => {
    expect(run([{ type: 'restore_error', error: 'gone', kind: 'unknown' }])).toMatchObject({ error: 'gone', errorKind: 'unknown' });
    expect(run([{ type: 'start' }, { type: 'restore_error', error: 'gone' }]).error).toBeUndefined();
    const known = run([{ type: 'finish', error: 'first' }, { type: 'restore_error', error: 'second' }]);
    expect(known.error).toBe('first');
  });

  it('resume starts a turn we never saw start, and leaves a turn we already follow untouched', () => {
    expect(liveTurnReducer(INITIAL_STATE, { type: 'resume' }).running).toBe(true);
    const following = run([{ type: 'start' }, { type: 'text', text: 'partial' }]);
    expect(liveTurnReducer(following, { type: 'resume' })).toBe(following);
  });

  it('a retry notice lives until the first sign of the answer or the end of the turn', () => {
    const notice = { provider: 'P', attempt: 1, status: 429 as const, delayMs: 5000, remainingMs: 100_000, receivedAt: 1 };
    const waiting = run([{ type: 'start' }, { type: 'retry', retry: notice }]);
    expect(waiting.retry).toEqual(notice);
    for (const action of [
      { type: 'text_delta', block: 0, text: 'x' },
      { type: 'thinking_delta', text: 'x' },
      { type: 'text', text: 'x' },
      { type: 'tool_use', label: 'x' },
      { type: 'context', used: 1, limit: null },
      { type: 'finish' },
      { type: 'finish', error: 'boom' },
      { type: 'compacted' },
      { type: 'clear' },
      { type: 'start' },
    ] as LiveTurnAction[]) {
      expect(liveTurnReducer(waiting, action).retry, action.type).toBeUndefined();
    }
    expect(liveTurnReducer(waiting, { type: 'retry', retry: { ...notice, attempt: 2 } }).retry?.attempt).toBe(2);
  });

  it('a clear forgets the turn but not the counters consumers watch', () => {
    const s = run([{ type: 'start' }, { type: 'finish' }, { type: 'compacted' }, { type: 'clear' }]);
    expect(s).toMatchObject({ running: false, parts: [], finishedCount: 1, compactedCount: 1 });
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
    getTurnStatus.mockReset();
    getTurnStatus.mockResolvedValue({ id: 0, status: 'idle', usage: '' });
    getMessageQueue.mockReset();
    getMessageQueue.mockResolvedValue({ items: [], paused: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a provider:retry event in the conversation it was sent to, stamped on arrival', () => {
    vi.setSystemTime(10_000);
    const { result } = renderHook(() => useSSE('c1'));
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.emit('turn:start');
      es.emit('provider:retry', { provider: 'P', attempt: 1, status: 503, delayMs: 2000, remainingMs: 90_000, conversationId: 'c1' });
    });
    expect(result.current.retry).toMatchObject({ provider: 'P', attempt: 1, status: 503, receivedAt: 10_000 });
    act(() => es.emit('turn:text_delta', { block: 0, text: 'Hi' }));
    expect(result.current.retry).toBeUndefined();
  });

  it('does not connect without a conversation', () => {
    renderHook(() => useSSE(null));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('connects to the conversation stream without any credential in the URL', () => {
    renderHook(() => useSSE('c1'));
    expect(FakeEventSource.instances[0]!.url).toBe('/api/conversations/c1/stream');
  });

  it('turns server events into live state', () => {
    const { result } = renderHook(() => useSSE('c1'));
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.emit('turn:start');
      es.emit('turn:text_delta', { block: 0, text: 'Hi' });
    });
    expect(result.current.running).toBe(true);
    expect(result.current.parts).toMatchObject([{ type: 'text', text: 'Hi' }]);
    act(() => es.emit('turn:error', { error: 'boom', kind: 'other' }));
    expect(result.current).toMatchObject({ running: false, error: 'boom', finishedCount: 1 });
  });

  it('follows the server snapshot sent when the stream connects mid-turn', () => {
    const { result } = renderHook(() => useSSE('c1'));
    act(() => FakeEventSource.instances[0]!.emit('turn:snapshot', {
      turnId: 1, userMessageId: 2, continuing: false, elapsedMs: 3000, idleMs: 0, at: 10, parts: [{ type: 'text', text: 'abc' }],
    }));
    expect(result.current).toMatchObject({ running: true, parts: [{ type: 'text', text: 'abc' }], startedCount: 1 });
  });

  it('passes `continuing` from turn:start, and counts starts', () => {
    const { result } = renderHook(() => useSSE('c1'));
    act(() => FakeEventSource.instances[0]!.emit('turn:start', { turnId: 1, userMessageId: 2, continuing: true }));
    expect(result.current).toMatchObject({ running: true, continuing: true, startedCount: 1 });
  });

  it('shows why the last turn failed when the page was reloaded after it', async () => {
    getTurnStatus.mockResolvedValue({ id: 4, status: 'error', error: 'provider down', kind: 'busy', usage: '' });
    const { result } = renderHook(() => useSSE('c1'));
    await act(async () => { FakeEventSource.instances[0]!.onopen?.(); });
    expect(result.current).toMatchObject({ running: false, error: 'provider down', errorKind: 'busy' });
  });

  it('an aborted turn finishes with the aborted kind, and release empties what it held', () => {
    const { result } = renderHook(() => useSSE('c1'));
    const es = FakeEventSource.instances[0]!;
    act(() => { es.emit('turn:start'); es.emit('turn:text', { text: 'kept' }); es.emit('turn:aborted', { error: 'Stopped' }); });
    expect(result.current).toMatchObject({ running: false, errorKind: 'aborted', held: [{ type: 'text', text: 'kept' }] });
    act(() => result.current.release());
    expect(result.current.held).toEqual([]);
  });

  it('shows messages waiting on the server, from the stream and after a reconnect', async () => {
    const waiting = { items: [{ id: 7, text: 'later', images: 1 }], paused: false };
    getMessageQueue.mockResolvedValue(waiting);
    const { result } = renderHook(() => useSSE('c1'));
    const es = FakeEventSource.instances[0]!;
    await act(async () => { es.onopen?.(); });
    expect(getMessageQueue).toHaveBeenCalledWith('c1');
    expect(result.current.queue).toEqual(waiting);
    act(() => es.emit('queue:changed', { items: [], paused: false }));
    expect(result.current.queue.items).toEqual([]);
  });

  it('keeps the queue across turns', () => {
    const queue = { items: [{ id: 1, text: 'x', images: 0 }], paused: true };
    const s = run([{ type: 'queue', queue }, { type: 'start' }, { type: 'finish' }]);
    expect(s.queue).toEqual(queue);
  });

  it('picks up a turn that is already running when the stream connects (reload, switching back, reconnect)', async () => {
    getTurnStatus.mockResolvedValue({ id: 4, status: 'running', usage: '' });
    const { result } = renderHook(() => useSSE('c1'));
    expect(result.current.running).toBe(false);
    await act(async () => { FakeEventSource.instances[0]!.onopen?.(); });
    expect(getTurnStatus).toHaveBeenCalledWith('c1');
    expect(result.current.running).toBe(true);
  });

  it('stays idle when the server is idle, and ignores a late answer after unmount', async () => {
    const { result, unmount } = renderHook(() => useSSE('c1'));
    await act(async () => { FakeEventSource.instances[0]!.onopen?.(); });
    expect(result.current.running).toBe(false);
    getTurnStatus.mockResolvedValue({ id: 5, status: 'running', usage: '' });
    const open = FakeEventSource.instances[0]!.onopen;
    unmount();
    await act(async () => { open?.(); });
    expect(result.current.running).toBe(false);
  });

  it('hands side events to the callback', () => {
    const seen: Array<[string, unknown]> = [];
    renderHook(() => useSSE('c1', (e, d) => seen.push([e, d])));
    act(() => FakeEventSource.instances[0]!.emit('gazeta:new', { id: 7 }));
    expect(seen).toEqual([['gazeta:new', { id: 7 }]]);
  });

  it('reconnects 2 s after the connection drops, and stops after unmount', () => {
    const { unmount } = renderHook(() => useSSE('c1'));
    FakeEventSource.instances[0]!.onerror?.();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(FakeEventSource.instances).toHaveLength(2);
    unmount();
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
    FakeEventSource.instances[1]!.onerror?.();
    act(() => void vi.advanceTimersByTime(5000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('forgets the previous conversation when it switches', () => {
    const { result, rerender } = renderHook(({ id }) => useSSE(id), { initialProps: { id: 'a' } });
    act(() => {
      FakeEventSource.instances[0]!.emit('turn:start');
      FakeEventSource.instances[0]!.emit('turn:text', { text: 'from a' });
    });
    expect(result.current.parts).toHaveLength(1);
    rerender({ id: 'b' });
    expect(result.current).toMatchObject({ running: false, parts: [] });
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.url).toBe('/api/conversations/b/stream');
  });
});
