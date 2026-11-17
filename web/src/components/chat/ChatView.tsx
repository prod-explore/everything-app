import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AssistantRuntimeProvider, SelectionToolbarPrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { ArrowDown, Quote } from 'lucide-react';
import { useEverythingAppRuntime } from '../../lib/runtime';
import { ChatActionsContext, type ChatActions } from '../../lib/chatActions';
import type { MessageMeta } from '../../lib/messages';
import type { ModelOption } from '../../types';
import { ActivityLine } from './ActivityLine';
import { TurnErrorBlock } from './TurnErrorBlock';
import { Composer } from './Composer';
import { ChatQuestions } from '../gazeta/ChatQuestions';
import { InlineApprovals } from '../approval/InlineApprovals';
import { AssistantBubble, UserBubble } from './MessageBubble';
import { ChatStatus, ContextMeter, EffortSelect } from './ChatStatus';
import { RetryStatus } from './RetryStatus';
import { CompactionNotice } from './CompactionNotice';
import { useConversationState } from '../../hooks/useConversationState';
import type { useApprovals } from '../../hooks/useApprovals';
import { AnsweredLine } from '../gazeta/AnsweredLine';
import { useAnsweredQuestions } from '../../hooks/useAnsweredQuestions';
import { AT_END, parseStoredTime, placeAnswers } from '../../lib/answerPlacement';
import { Onboarding } from './Onboarding';

const STICK_PX = 160; // closer than this to the bottom = the reader is "following" the conversation

/**
 * Keeps the newest content in view while the reader is "following" the conversation, but not once they have scrolled up to
 * read something. Scrolls at most once per animation frame: a long answer changes the page many times a second.
 */
function useFollowBottom(conversationId: string) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inner = content.current;
    const scroller = inner?.parentElement;
    if (!inner || !scroller) return;
    // Per-subscription state lives in an object, not a reassigned local: it changes from event handlers only.
    const view = { following: true, frame: 0 };
    const onScroll = () => {
      view.following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    };
    const follow = () => {
      if (!view.following || view.frame) return;
      view.frame = requestAnimationFrame(() => {
        view.frame = 0;
        if (view.following) scroller.scrollTop = scroller.scrollHeight;
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const mo = new MutationObserver(follow);
    mo.observe(inner, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    scroller.scrollTo({ top: scroller.scrollHeight });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(view.frame);
      mo.disconnect();
      ro.disconnect();
    };
  }, [conversationId]);
  return content;
}

/** The message list; each answered agent question is shown under the reply of the turn that asked it. */
function Transcript({ conversationId }: { conversationId: string }) {
  const answered = useAnsweredQuestions(conversationId);
  const messages = useAuiState(s => s.thread.messages);
  const placed = useMemo(
    () =>
      placeAnswers(
        messages.map(m => ({ id: m.id, role: m.role, at: m.createdAt ? m.createdAt.getTime() : null })),
        answered.map(a => ({ id: a.id, askedAt: parseStoredTime(a.createdAt), answeredAt: parseStoredTime(a.respondedAt) })),
      ),
    [messages, answered],
  );
  const byId = useMemo(() => new Map(answered.map(a => [a.id, a])), [answered]);
  const lines = (key: string) => {
    const items = (placed.get(key) ?? []).flatMap(id => byId.get(id) ?? []);
    return items.length === 0 ? null : (
      <div className="space-y-1.5" aria-label="Twoje odpowiedzi">
        {items.map(i => <AnsweredLine key={i.id} item={i} />)}
      </div>
    );
  };
  return (
    <>
      <ThreadPrimitive.Messages>
        {({ message }) => (
          <>
            {message.role === 'user' ? <UserBubble /> : message.role === 'system' ? <CompactionNotice /> : <AssistantBubble />}
            {lines(message.id)}
          </>
        )}
      </ThreadPrimitive.Messages>
      {lines(AT_END)}
    </>
  );
}

export function ChatView({
  conversationId,
  onOpenSettings,
  approvals,
  models = [],
  model = null,
  ghost = false,
}: {
  conversationId: string;
  onOpenSettings: () => void;
  approvals: ReturnType<typeof useApprovals>;
  /** For answering once with another model ("Try another model", "Regenerate with…"). */
  models?: ModelOption[];
  /** The model the chat uses now. */
  model?: string | null;
  /** A ghost chat only takes local models. */
  ghost?: boolean;
}) {
  const { runtime, live, error, errorKind, retry, queue, actions, persisted } = useEverythingAppRuntime(conversationId);
  const convState = useConversationState(conversationId, live);
  const content = useFollowBottom(conversationId);

  const { compact } = convState;
  const compactAndRetry = useCallback(() => { void compact().then(compacted => { if (compacted) void retry(); }); }, [compact, retry]);
  const chatActions = useMemo<ChatActions>(
    () => ({
      ...actions,
      models,
      currentModel: model,
      onlyLocal: ghost,
      turnError: live.error ? { kind: live.errorKind, detail: live.errorDetail } : null,
      compactAndRetry,
      busy: live.running,
    }),
    [actions, models, model, ghost, live.error, live.errorKind, live.errorDetail, live.running, compactAndRetry],
  );

  // A turn that failed or was stopped says so under the message it belongs to. When the reply it kept is on screen (as the last
  // message) that message carries the notice itself; otherwise — nothing was answered — it stands on its own after the chat.
  const tail = persisted[persisted.length - 1];
  const tailKept = tail?.role === 'assistant' && Boolean((tail.metadata?.custom as MessageMeta | undefined)?.incomplete);
  const standalone = error && errorKind !== 'send_failed' && !live.running && !tailKept;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatActionsContext.Provider value={chatActions}>
        <ThreadPrimitive.Root className="flex h-full flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4 pt-6">
              <div ref={content} className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 pb-6">
                <ThreadPrimitive.Empty>
                  <Onboarding onOpenSettings={onOpenSettings} />
                </ThreadPrimitive.Empty>
                <Transcript conversationId={conversationId} />
                <ActivityLine live={live} awaitingApproval={approvals.pending.length > 0} />
                {standalone && (
                  <TurnErrorBlock
                    variant={errorKind === 'aborted' ? 'stopped' : 'error'}
                    message={error}
                    detail={live.errorDetail}
                    kind={errorKind}
                    hasReply={tail?.role === 'assistant'}
                    canContinue={false}
                  />
                )}
                <InlineApprovals pending={approvals.pending} respond={approvals.respond} />
              </div>
              {/* Inside the scroller (sticky) rather than below it, so the scrollbar runs all the way down to the composer. */}
              <div className="sticky bottom-0 z-10 -mx-4 shrink-0 bg-bg">
                <ChatStatus api={convState} running={live.running} />
                <RetryStatus retry={live.retry} running={live.running} />
              </div>
            </ThreadPrimitive.Viewport>
            {/* Scrolled up to read: one tap back to the newest message. Disabled (hidden) while already at the bottom. */}
            <ThreadPrimitive.ScrollToBottom
              aria-label="Scroll to the newest message"
              title="Scroll to the newest message"
              className="absolute bottom-3 left-1/2 z-20 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border-hover bg-bg-secondary text-fg-secondary shadow-lg transition-opacity hover:text-fg disabled:pointer-events-none disabled:opacity-0"
            >
              <ArrowDown size={16} />
            </ThreadPrimitive.ScrollToBottom>
          </div>
          {/* Select any passage in a message → floating "Quote" quotes just that passage in the next reply. */}
          <SelectionToolbarPrimitive.Root className="z-50 rounded-button border border-border bg-bg-secondary shadow-lg">
            <SelectionToolbarPrimitive.Quote className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg hover:bg-bg-tertiary" aria-label="Quote selection">
              <Quote size={12} /> Quote
            </SelectionToolbarPrimitive.Quote>
          </SelectionToolbarPrimitive.Root>
          <ChatQuestions conversationId={conversationId} />
          <Composer
            conversationId={conversationId}
            leading={<EffortSelect api={convState} running={live.running} />}
            trailing={<ContextMeter api={convState} running={live.running} />}
            error={errorKind === 'send_failed' ? error : undefined}
            queue={queue}
          />
        </ThreadPrimitive.Root>
      </ChatActionsContext.Provider>
    </AssistantRuntimeProvider>
  );
}
