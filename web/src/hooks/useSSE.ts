import { useCallback, useEffect, useReducer, useRef } from 'react';
import { getMessageQueue, getTurnStatus, type MessageQueueInfo } from '../api';
import type { ConversationStateInfo, ProviderRetry, TurnErrorKind } from '../types';

/**
 * One entry per tool call made during the currently-running turn, in the
 * order the backend emitted them. Correlated to their result by POSITION,
 * not by id: server.ts's tool loop emits onToolStart → (approval) →
 * onToolResult strictly one call at a time before moving to the next
 * (see llm-loop.ts's `for (const use of toolUses)`), and neither SSE
 * event carries a tool_use_id — onToolStart gets the human label
 * (`tools.describe(use.name)`), onToolResult gets the raw registry name
 * (`use.name`), which are different strings for the same call. The oldest
 * unresolved entry is always the right one to attach a result to.
 */
export interface LiveToolCall {
  label: string;
  toolName?: string;
  result?: { truncatedOutput: string; isError: boolean; wasTruncated: boolean };
}

/** `streaming` text is a partial block still being generated; the backend's turn:text with the full block replaces it. */
export type LivePart =
  | { type: 'text'; text: string; block?: number; streaming?: boolean }
  /** `startedAt` / `endedAt`: when the model began and stopped reasoning (ms, this browser's clock); no `endedAt` = still thinking. */
  | { type: 'reasoning'; text: string; startedAt?: number; endedAt?: number }
  | { type: 'tool'; call: LiveToolCall };

/** What GET .../stream sends first to a client that connects while a turn runs (cli/src/live-turn.ts). */
export interface TurnSnapshot {
  turnId: number;
  userMessageId: number;
  continuing: boolean;
  parts: LivePart[];
  elapsedMs: number;
  idleMs: number;
  at: number;
}

export interface LiveTurnState {
  /** True from turn:start until turn:done/error/aborted. */
  running: boolean;
  parts: LivePart[];
  /**
   * What the turn showed when it ended, kept (not rendered as live) until the stored copy has been fetched, so a stopped or
   * finished answer does not blink out for the moment in between. Emptied by `release`.
   */
  held: LivePart[];
  /** When the running turn began / last produced anything, on this browser's clock — for "Thinking… 12 s" and "No response for 20 s". */
  startedAt: number | null;
  lastEventAt: number | null;
  /** The turn carries on a reply that was cut short: its text goes at the end of that message. */
  continuing: boolean;
  /** Bumped when a turn starts (or is picked up mid-way): the message that started it may be new to this tab. */
  startedCount: number;
  error?: string;
  /** Why it failed — drives which recovery the banner offers. */
  errorKind?: TurnErrorKind;
  /** The provider's own words, for a tooltip. */
  errorDetail?: string;
  /** The provider is busy and the server is waiting to try again (see RetryStatus). Cleared by the first sign of the answer or the end of the turn. */
  retry?: RetryNotice;
  /** Prompt size the provider measured on the latest request (live; the state endpoint has the stored one). */
  context?: { used: number; limit: number | null };
  /** Pushed by the server when the effort / the todo list change. */
  convState?: ConversationStateInfo;
  /** Messages waiting for the assistant to be free (kept on the server, pushed as they change). */
  queue: MessageQueueInfo;
  /** Bumped when the server summarised older messages — consumers refetch the message list. */
  compactedCount: number;
  /** Bumped on every turn:done/error/aborted — lets consumers notice "a turn just finished" even if `running` briefly reads false in both the old and new state. */
  finishedCount: number;
}

/** A provider:retry event with the moment it arrived, which is what the countdown counts from. */
export type RetryNotice = ProviderRetry & { receivedAt: number };

const EMPTY_QUEUE: MessageQueueInfo = { items: [], paused: false };
export const INITIAL_STATE: LiveTurnState = { running: false, parts: [], held: [], startedAt: null, lastEventAt: null, continuing: false, startedCount: 0, finishedCount: 0, compactedCount: 0, queue: EMPTY_QUEUE };

export type LiveTurnAction =
  | { type: 'clear' }
  | { type: 'start'; continuing?: boolean }
  /** The server's account of the turn in progress, sent when this stream connected. */
  | { type: 'snapshot'; snapshot: TurnSnapshot }
  /** The stored copy of the finished turn has been fetched: the held parts can go. */
  | { type: 'release' }
  /** The last turn failed and this page was not there to see it (reload): show why. */
  | { type: 'restore_error'; error: string; kind?: TurnErrorKind }
  /** The server says a turn is running that we never saw start (reload, switched back to the chat, dropped stream). */
  | { type: 'resume' }
  | { type: 'text_delta'; block: number; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; label: string }
  | { type: 'tool_result'; toolName: string; truncatedOutput: string; isError: boolean; wasTruncated: boolean }
  | { type: 'finish'; error?: string; kind?: TurnErrorKind; detail?: string }
  | { type: 'context'; used: number; limit: number | null }
  | { type: 'conv_state'; state: ConversationStateInfo }
  | { type: 'queue'; queue: MessageQueueInfo }
  | { type: 'compacted' }
  | { type: 'retry'; retry: RetryNotice };

/** Closes the reasoning part that is still open (whatever comes next means the model has stopped thinking). */
function endReasoning(parts: LivePart[], at: number): LivePart[] {
  const last = parts[parts.length - 1];
  if (last?.type !== 'reasoning' || last.endedAt !== undefined) return parts;
  return [...parts.slice(0, -1), { ...last, endedAt: at }];
}

export function liveTurnReducer(state: LiveTurnState, action: LiveTurnAction): LiveTurnState {
  const now = Date.now();
  // Every event of a running turn counts as "the model is alive"; the state of the turn is `parts`, this only stamps it.
  const alive = (next: LiveTurnState): LiveTurnState => ({ ...next, retry: undefined, lastEventAt: now });
  switch (action.type) {
    case 'clear':
      return { ...INITIAL_STATE, finishedCount: state.finishedCount, compactedCount: state.compactedCount, startedCount: state.startedCount };
    case 'start':
      return {
        ...INITIAL_STATE,
        running: true,
        startedAt: now,
        lastEventAt: now,
        continuing: action.continuing === true,
        startedCount: state.startedCount + 1,
        finishedCount: state.finishedCount,
        compactedCount: state.compactedCount,
        queue: state.queue,
        context: state.context,
        convState: state.convState,
      };
    case 'resume':
      return state.running ? state : liveTurnReducer(state, { type: 'start' });
    case 'retry':
      return { ...state, retry: action.retry };
    case 'snapshot': {
      const snap = action.snapshot;
      // The server stamped reasoning with its own clock; what matters is how long ago, so move them onto ours.
      const shift = (t: number | undefined) => (t === undefined ? undefined : now - (snap.at - t));
      const parts = snap.parts.map((p): LivePart => (p.type === 'reasoning' ? { ...p, startedAt: shift(p.startedAt), endedAt: shift(p.endedAt) } : p));
      return {
        ...state,
        running: true,
        parts,
        held: [],
        error: undefined,
        errorKind: undefined,
        errorDetail: undefined,
        continuing: snap.continuing,
        startedAt: now - snap.elapsedMs,
        lastEventAt: now - snap.idleMs,
        startedCount: state.startedCount + 1,
      };
    }
    case 'release':
      return state.held.length === 0 ? state : { ...state, held: [] };
    case 'restore_error':
      return state.running || state.error ? state : { ...state, error: action.error, errorKind: action.kind };
    case 'context':
      return { ...state, retry: undefined, context: { used: action.used, limit: action.limit } };
    case 'conv_state':
      return { ...state, convState: action.state };
    case 'queue':
      return { ...state, queue: action.queue };
    case 'compacted':
      return { ...state, retry: undefined, compactedCount: state.compactedCount + 1 };
    case 'text_delta': {
      const ended = endReasoning(state.parts, now);
      const last = ended[ended.length - 1];
      if (last?.type === 'text' && last.streaming && last.block === action.block) {
        const parts = [...ended];
        parts[parts.length - 1] = { ...last, text: last.text + action.text };
        return alive({ ...state, parts });
      }
      return alive({ ...state, parts: [...ended, { type: 'text', text: action.text, block: action.block, streaming: true }] });
    }
    case 'thinking_delta': {
      const last = state.parts[state.parts.length - 1];
      if (last?.type === 'reasoning' && last.endedAt === undefined) {
        const parts = [...state.parts];
        parts[parts.length - 1] = { ...last, text: last.text + action.text };
        return alive({ ...state, parts });
      }
      return alive({ ...state, parts: [...state.parts, { type: 'reasoning', text: action.text, startedAt: now }] });
    }
    case 'text': {
      // The complete block replaces the oldest partial one (blocks finish in order); with no partial
      // (provider without streaming, or deltas missed over a reconnect) it is simply appended.
      const ended = endReasoning(state.parts, now);
      const idx = ended.findIndex(p => p.type === 'text' && p.streaming);
      if (idx === -1) return alive({ ...state, parts: [...ended, { type: 'text', text: action.text }] });
      const parts = [...ended];
      parts[idx] = { type: 'text', text: action.text };
      return alive({ ...state, parts });
    }
    case 'tool_use':
      return alive({ ...state, parts: [...endReasoning(state.parts, now), { type: 'tool', call: { label: action.label } }] });
    case 'tool_result': {
      const idx = state.parts.findIndex(p => p.type === 'tool' && !p.call.result);
      if (idx === -1) return state; // defensive — shouldn't happen given the guaranteed emission order
      const parts = [...state.parts];
      const part = parts[idx] as Extract<LivePart, { type: 'tool' }>;
      parts[idx] = {
        type: 'tool',
        call: {
          ...part.call,
          toolName: action.toolName,
          result: { truncatedOutput: action.truncatedOutput, isError: action.isError, wasTruncated: action.wasTruncated },
        },
      };
      return alive({ ...state, parts });
    }
    case 'finish':
      // `parts` is emptied, not just `running`: liveTurnToMessage() renders whatever is in `parts` regardless of `running`,
      // and the refetch triggered by finishedCount changing (see lib/runtime.ts) brings in the same content as a stored
      // message right after this — leaving them would show every finished turn twice. The turn's last look is kept in
      // `held` so what a stop or a failure kept does not blink out before the stored copy arrives (see `release`).
      return {
        ...state,
        running: false,
        retry: undefined,
        parts: [],
        held: endReasoning(state.parts, now),
        startedAt: null,
        lastEventAt: null,
        error: action.error,
        errorKind: action.kind,
        errorDetail: action.detail,
        finishedCount: state.finishedCount + 1,
      };
  }
}

const SIDE_EVENTS = [
  'gazeta:new',
  'gazeta:responded',
  'gazeta:dismissed',
  'conversation:titled',
  'approval:resolved',
  'pins:changed',
  'agent:spawned',
  'agent:finished',
  'agent:budget_warning',
  'turn:done',
  'schedule:changed',
] as const;

export type SideEvent = (typeof SIDE_EVENTS)[number];

/**
 * Subscribes to a conversation's SSE stream. Reconnects automatically on
 * drop (mobile networks/backgrounded tabs cut EventSource connections
 * often) — a fresh GET /api/conversations/:id/messages after reconnecting
 * is still the source of truth for anything that happened while
 * disconnected; this hook only carries the LIVE view of a turn in progress.
 *
 * `onSideEvent` covers events that aren't part of the turn itself:
 * server.ts's SSEManager.emitAll() broadcasts `gazeta:new`
 * to every currently-open conversation stream (not just the one that
 * triggered them), so whichever conversation happens to be open right now
 * still hears about it — that's what lets useGazeta react immediately
 * instead of relying only on its 30s poll fallback.
 */
export function useSSE(conversationId: string | null, onSideEvent?: (event: SideEvent, data: unknown) => void): LiveTurnState & { release: () => void } {
  const [state, dispatch] = useReducer(liveTurnReducer, INITIAL_STATE);
  const release = useCallback(() => dispatch({ type: 'release' }), []);
  const onSideEventRef = useRef(onSideEvent);
  useEffect(() => { onSideEventRef.current = onSideEvent; });

  useEffect(() => {
    if (!conversationId) return;
    dispatch({ type: 'clear' });
    // ^ reset live state immediately on conversation switch — stale parts
    // from the previous conversation must never bleed into this one, even
    // for the instant before the new EventSource's first message arrives.
    // We use 'clear' instead of 'start' so that 'running' defaults to false,
    // and is only set to true when the server actually emits 'turn:start'.

    // Same-origin EventSource sends the HttpOnly session cookie by itself — no credential in the URL.
    const id = conversationId;
    const url = `/api/conversations/${id}/stream`;
    const life = { closed: false }; // an object, not a reassigned local: flipped by the cleanup, read by callbacks
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (life.closed) return;
      source = new EventSource(url);

      source.addEventListener('turn:start', e => {
        const data = JSON.parse((e as MessageEvent).data ?? '{}') as { continuing?: boolean };
        dispatch({ type: 'start', continuing: data.continuing === true });
      });
      source.addEventListener('turn:snapshot', e => {
        dispatch({ type: 'snapshot', snapshot: JSON.parse((e as MessageEvent).data) as TurnSnapshot });
      });
      source.addEventListener('turn:text_delta', e => {
        const data = JSON.parse((e as MessageEvent).data) as { block: number; text: string };
        dispatch({ type: 'text_delta', block: data.block, text: data.text });
      });
      source.addEventListener('turn:thinking_delta', e => {
        const data = JSON.parse((e as MessageEvent).data) as { text: string };
        dispatch({ type: 'thinking_delta', text: data.text });
      });
      source.addEventListener('turn:text', e => {
        const data = JSON.parse((e as MessageEvent).data) as { text: string };
        dispatch({ type: 'text', text: data.text });
      });
      source.addEventListener('turn:tool_use', e => {
        const data = JSON.parse((e as MessageEvent).data) as { label: string };
        dispatch({ type: 'tool_use', label: data.label });
      });
      source.addEventListener('turn:tool_result', e => {
        const data = JSON.parse((e as MessageEvent).data) as {
          toolName: string;
          truncatedOutput: string;
          isError: boolean;
          wasTruncated: boolean;
        };
        dispatch({ type: 'tool_result', ...data });
      });
      source.addEventListener('provider:retry', e => {
        dispatch({ type: 'retry', retry: { ...(JSON.parse((e as MessageEvent).data) as ProviderRetry), receivedAt: Date.now() } });
      });
      source.addEventListener('turn:done', () => dispatch({ type: 'finish' }));
      source.addEventListener('turn:error', e => {
        const data = JSON.parse((e as MessageEvent).data) as { error: string; kind?: TurnErrorKind; detail?: string };
        dispatch({ type: 'finish', error: data.error, kind: data.kind, detail: data.detail });
      });
      source.addEventListener('turn:context', e => {
        const data = JSON.parse((e as MessageEvent).data) as { used: number; limit: number | null };
        dispatch({ type: 'context', used: data.used, limit: data.limit });
      });
      source.addEventListener('conversation:state', e => {
        dispatch({ type: 'conv_state', state: JSON.parse((e as MessageEvent).data) as ConversationStateInfo });
      });
      source.addEventListener('conversation:compacted', () => dispatch({ type: 'compacted' }));
      source.addEventListener('queue:changed', e => {
        dispatch({ type: 'queue', queue: JSON.parse((e as MessageEvent).data) as MessageQueueInfo });
      });
      source.addEventListener('turn:aborted', e => {
        const data = JSON.parse((e as MessageEvent).data) as { error: string };
        dispatch({ type: 'finish', error: data.error, kind: 'aborted' });
      });

      for (const evt of SIDE_EVENTS) {
        source.addEventListener(evt, e => {
          const data = JSON.parse((e as MessageEvent).data ?? '{}');
          onSideEventRef.current?.(evt, data);
        });
      }

      // Every (re)connect: a reload, a switch back to this chat or a dropped stream can leave a turn running on the
      // server that we never saw start. Without this the composer looked idle and a sent message was refused (409).
      source.onopen = () => {
        void getTurnStatus(id)
          .then(s => {
            if (life.closed) return;
            if (s.status === 'running') dispatch({ type: 'resume' });
            else if (s.status === 'error' && s.error) dispatch({ type: 'restore_error', error: s.error, kind: s.kind });
          })
          .catch(() => { /* the next event or reconnect sorts it out */ });
        // Messages queued before the reload (or from another device) are still waiting on the server.
        void getMessageQueue(id)
          .then(q => { if (!life.closed) dispatch({ type: 'queue', queue: q }); })
          .catch(() => { /* the next queue:changed sets it */ });
      };

      source.onerror = () => {
        source?.close();
        if (life.closed) return;
        // Browsers already retry EventSource automatically, but on a fatal
        // server-side close (e.g. a deploy) that stops — a manual retry
        // loop is the difference between "reconnects in 2s" and "silently
        // dead until the page is reloaded."
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      life.closed = true;
      clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [conversationId]);

  return { ...state, release };
}
