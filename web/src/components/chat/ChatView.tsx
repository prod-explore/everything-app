import { useEffect, useMemo, useRef } from 'react';
import { AssistantRuntimeProvider, SelectionToolbarPrimitive, ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { Quote } from 'lucide-react';
import { useEverythingAppRuntime } from '../../lib/runtime';
import { Composer } from './Composer';
import { ChatQuestions } from '../gazeta/ChatQuestions';
import { InlineApprovals } from '../approval/InlineApprovals';
import { AssistantBubble, UserBubble } from './MessageBubble';
import { ChatStatus, ContextMeter, EffortSelect } from './ChatStatus';
import { CompactionNotice } from './CompactionNotice';
import { useConversationState } from '../../hooks/useConversationState';
import type { useApprovals } from '../../hooks/useApprovals';
import { AnsweredLine } from '../gazeta/AnsweredLine';
import { useAnsweredQuestions } from '../../hooks/useAnsweredQuestions';
import { AT_END, parseStoredTime, placeAnswers } from '../../lib/answerPlacement';
import { Onboarding } from './Onboarding';

const STICK_PX = 160; // closer than this to the bottom = the reader is "following" the conversation

/** Smoothly follows new content, but only while the reader hasn't scrolled up to read something. */
function useFollowBottom(conversationId: string) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inner = content.current;
    const scroller = inner?.parentElement;
    if (!inner || !scroller) return;
    let following = true;
    const onScroll = () => {
      following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_PX;
    };
    const follow = () => {
      if (following) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const mo = new MutationObserver(follow);
    mo.observe(inner, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    scroller.scrollTo({ top: scroller.scrollHeight });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
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
}: {
  conversationId: string;
  onOpenSettings: () => void;
  approvals: ReturnType<typeof useApprovals>;
}) {
  const { runtime, live, error, errorKind, retry } = useEverythingAppRuntime(conversationId);
  const convState = useConversationState(conversationId, live);
  const content = useFollowBottom(conversationId);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4 pt-6">
          <div ref={content} className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 pb-6">
            <ThreadPrimitive.Empty>
              <Onboarding onOpenSettings={onOpenSettings} />
            </ThreadPrimitive.Empty>
            <Transcript conversationId={conversationId} />
            <InlineApprovals pending={approvals.pending} respond={approvals.respond} />
          </div>
          {/* Inside the scroller (sticky) rather than below it, so the scrollbar runs all the way down to the composer. */}
          <div className="sticky bottom-0 z-10 -mx-4 shrink-0 bg-bg">
            <ChatStatus api={convState} running={live.running} />
          </div>
        </ThreadPrimitive.Viewport>
        {/* Select any passage in a message → floating "Quote" quotes just that passage in the next reply. */}
        <SelectionToolbarPrimitive.Root className="z-50 rounded-button border border-border bg-bg-secondary shadow-lg">
          <SelectionToolbarPrimitive.Quote className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-fg hover:bg-bg-tertiary" aria-label="Quote selection">
            <Quote size={12} /> Quote
          </SelectionToolbarPrimitive.Quote>
        </SelectionToolbarPrimitive.Root>
        <ChatQuestions conversationId={conversationId} />
        <Composer
          leading={<EffortSelect api={convState} running={live.running} />}
          trailing={<ContextMeter api={convState} running={live.running} />}
          error={error}
          errorKind={errorKind}
          errorDetail={live.errorDetail}
          onRetry={retry}
          onCompactAndRetry={async () => { if (await convState.compact()) retry(); }}
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
