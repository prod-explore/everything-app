import { SimpleImageAttachmentAdapter, useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, editMessage, getMessages, deleteMessageFrom, killTurn, regenerateMessage, retryLastMessage, sendMessage } from '../api';
import type { OutgoingAttachment, TurnErrorKind } from '../types';
import { useSSE } from '../hooks/useSSE';
import { foldRawMessages, liveTurnToMessage } from './messages';
import { dequeue, editQueued, enqueue, promoteQueued, queueOf, removeQueued, requeueFirst, type MessageQueues } from './messageQueue';

/** What to tell the person when their message could not be sent (the server refuses with 409 while a turn is running). */
export function sendFailureMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    return "The assistant is still working on this chat, so your message wasn't sent. Wait for it to finish (or stop it), then send it again.";
  }
  return `Your message wasn't sent: ${e instanceof Error ? e.message : 'unknown error'}.`;
}

/**
 * The images the person attached, as data URLs. The composer hands them over on `message.attachments` (its `content`
 * carries only the text), so both places are read — an image in neither is how a picture used to vanish silently.
 */
export function imagesOf(message: Pick<AppendMessage, 'content' | 'attachments'>): string[] {
  const pick = (parts: readonly { type: string; image?: string }[]) => parts.flatMap(c => (c.type === 'image' && c.image ? [c.image] : []));
  return [...pick(message.content), ...(message.attachments ?? []).flatMap(a => pick(a.content))];
}

/** data:image/png;base64,AAAA... → { mediaType: 'image/png', data: 'AAAA...' } */
function splitDataUrl(dataUrl: string): OutgoingAttachment | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

/**
 * Given the full persisted list and a parentId from assistant-ui (either the
 * id of a message, or null for "the very start"), finds where a new branch
 * anchors — walking backward to the nearest USER message, mirroring
 * server.ts's findRegenerationAnchor(). Needed because a single logical turn
 * can render as several sequential assistant bubbles (one per tool-loop
 * round trip), so "the previous bubble" isn't always the user turn that
 * started it.
 */
function truncateToAnchor(persisted: ThreadMessageLike[], parentId: string | null): ThreadMessageLike[] {
  let idx = parentId === null ? persisted.length - 1 : persisted.findIndex(m => m.id === parentId);
  while (idx >= 0 && persisted[idx].role !== 'user') idx--;
  return idx < 0 ? [] : persisted.slice(0, idx + 1);
}

export function useEverythingAppRuntime(conversationId: string | null) {
  const [persisted, setPersisted] = useState<ThreadMessageLike[]>([]);
  const live = useSSE(conversationId);
  // A message the server refused: shown in the composer's banner, and the text goes back into the box.
  const [sendError, setSendError] = useState<string | null>(null);
  const composerRef = useRef<{ setText: (text: string) => void } | null>(null);
  // Messages typed while a turn runs wait here (see lib/messageQueue.ts) and go out one by one.
  const [queues, setQueues] = useState<MessageQueues>({});
  const handingOver = useRef(false); // a queued message is on its way to the server and its turn has not shown up yet
  const interrupting = useRef(false); // the person asked to send a queued message right now, so a stopped turn must not hold it back

  const refetch = useCallback(() => {
    if (!conversationId) {
      setPersisted([]);
      return;
    }
    getMessages(conversationId)
      .then(({ messages }) => setPersisted(foldRawMessages(messages)))
      .catch(() => {
        // Transient — the next natural refetch (conversation switch, turn
        // finishing) will pick it up. Nothing actionable to show here.
      });
  }, [conversationId]);

  // Refetch on conversation switch, and again every time a turn finishes —
  // finishedCount (not `running`) is the trigger because it changes exactly
  // once per completed turn even if two turns somehow finish back to back,
  // where a boolean could stay `false` across both and never fire the effect.
  useEffect(() => {
    refetch();
  }, [refetch, live.finishedCount, live.compactedCount]);

  const liveMessage = useMemo(() => liveTurnToMessage(live.parts), [live.parts]);
  const messages = useMemo(
    () => (liveMessage ? [...persisted, liveMessage] : persisted),
    [persisted, liveMessage],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      if (!conversationId) return;
      const typed = message.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('');
      // A pending quote (see MessageBubble.tsx's QuoteButton + Composer.tsx's
      // preview banner) rides along on metadata.custom.quote once sent —
      // fold it into the actual text, since the backend has no separate
      // concept of a quoted reply.
      const quote = message.metadata?.custom?.quote as { text: string } | undefined;
      const text = quote?.text
        ? `${quote.text
            .trim()
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n')}\n\n${typed}`
        : typed;
      const images = imagesOf(message);
      const attachments = images.map(splitDataUrl).filter((a): a is OutgoingAttachment => a !== null);
      if (!text.trim() && attachments.length === 0) return;
      setSendError(null);

      // Optimistic: show the user's own message immediately rather than
      // waiting on the round trip to the backend and the turn:start SSE
      // event — on a slow connection that gap is visible and looks broken.
      const optimisticContent: ThreadMessageLike['content'] = [
        ...images.map(image => ({ type: 'image' as const, image })),
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ];
      setPersisted(prev => [...prev, { id: `opt-${Date.now()}`, role: 'user', content: optimisticContent }]);

      try {
        await sendMessage(conversationId, text, attachments.length > 0 ? attachments : undefined);
      } catch (e) {
        // Roll back the optimistic message, say why, and put the text back so nothing has to be retyped.
        setPersisted(prev => prev.slice(0, -1));
        setSendError(sendFailureMessage(e));
        if (typed) composerRef.current?.setText(typed);
      }
    },
    [conversationId],
  );

  const sendQueued = useCallback(async (convId: string, text: string): Promise<boolean> => {
    setSendError(null);
    setPersisted(prev => [...prev, { id: `opt-${Date.now()}`, role: 'user', content: [{ type: 'text', text }] }]);
    try {
      await sendMessage(convId, text);
      return true;
    } catch (e) {
      setPersisted(prev => prev.slice(0, -1));
      setSendError(sendFailureMessage(e));
      return false;
    }
  }, []);

  // The next turn is under way (or already over), so the next queued message may follow.
  useEffect(() => {
    handingOver.current = false;
  }, [live.running, live.finishedCount]);

  // When the assistant is free, send the oldest queued message. After a failed or stopped turn the queue waits for the
  // person (the banner says why) unless they chose "send now".
  useEffect(() => {
    if (!conversationId || live.running || handingOver.current) return;
    if (live.error && !interrupting.current) return;
    const { next, queues: rest } = dequeue(queues, conversationId);
    if (!next) {
      interrupting.current = false;
      return;
    }
    interrupting.current = false;
    handingOver.current = true;
    setQueues(rest);
    void sendQueued(conversationId, next.text).then(ok => {
      if (ok) return;
      handingOver.current = false;
      setQueues(q => requeueFirst(q, conversationId, next));
    });
  }, [conversationId, live.running, live.error, queues, sendQueued]);

  const queue = useMemo(
    () => ({
      items: queueOf(queues, conversationId),
      /** True when the line is stuck behind a failed or stopped turn. */
      paused: !live.running && !!live.error && queueOf(queues, conversationId).length > 0,
      add: (text: string) => {
        if (conversationId) setQueues(q => enqueue(q, conversationId, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text }));
      },
      edit: (id: string, text: string) => {
        if (conversationId) setQueues(q => editQueued(q, conversationId, id, text));
      },
      remove: (id: string) => {
        if (conversationId) setQueues(q => removeQueued(q, conversationId, id));
      },
      /** Moves a message to the front and stops the running turn so it goes out now. */
      sendNow: (id: string) => {
        if (!conversationId) return;
        interrupting.current = true;
        setQueues(q => promoteQueued(q, conversationId, id));
        if (live.running) killTurn(conversationId).catch(() => { interrupting.current = false; });
      },
    }),
    [queues, conversationId, live.running, live.error],
  );

  const onEdit = useCallback(
    async (message: AppendMessage) => {
      if (!conversationId) return;
      const text = message.content
        .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
        .map(c => c.text)
        .join('');
      if (!text.trim()) return;
      const parentId = message.parentId ?? null;

      // Optimistic: drop everything from the edited message onward, show
      // the new text immediately, let the live turn stream in after it —
      // same reasoning as onNew's optimistic append above.
      const before = truncateToAnchor(persisted, parentId);
      setPersisted([...before, { id: `opt-${Date.now()}`, role: 'user', content: [{ type: 'text', text }] }]);

      try {
        await editMessage(conversationId, parentId === null ? null : Number(parentId), text);
      } catch {
        setPersisted(persisted); // revert to the pre-edit list — the edit never happened server-side
      }
    },
    [conversationId, persisted],
  );

  const onReload = useCallback(
    async (parentId: string | null) => {
      if (!conversationId) return;
      const before = truncateToAnchor(persisted, parentId);
      setPersisted(before);
      try {
        await regenerateMessage(conversationId, parentId === null ? null : Number(parentId));
      } catch {
        setPersisted(persisted);
      }
    },
    [conversationId, persisted],
  );

  const onCancel = useCallback(async () => {
    if (!conversationId) return;
    await killTurn(conversationId);
  }, [conversationId]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!conversationId) return;
      const messageId = Number(id);
      if (!Number.isInteger(messageId)) return; // an optimistic ("opt-...") message never made it to the server
      const idx = persisted.findIndex(m => m.id === id);
      const before = idx < 0 ? persisted : persisted.slice(0, idx);
      setPersisted(before);
      try {
        await deleteMessageFrom(conversationId, messageId);
        refetch(); // the server is the source of truth (it deletes across branches too)
      } catch {
        setPersisted(persisted); // e.g. 409 while a turn is running
      }
    },
    [conversationId, persisted, refetch],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: live.running,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew,
    onEdit,
    onReload,
    onCancel,
    onDelete,
    adapters: {
      // Images only for now (other file types are not supported yet) — this gives
      // the composer its paperclip button, drag-and-drop, and paste-to-attach for free.
      attachments: new SimpleImageAttachmentAdapter(),
    },
  });

  useEffect(() => { composerRef.current = runtime.thread.composer; }, [runtime]);
  // A new turn (or a finished one) makes an old "wasn't sent" notice stale.
  useEffect(() => { setSendError(null); }, [conversationId, live.finishedCount]);

  const retry = useCallback(async () => {
    if (!conversationId) return;
    try {
      await retryLastMessage(conversationId);
    } catch {
      // Nothing new to show — the error banner (driven by live.error) stays as-is until the next attempt.
    }
  }, [conversationId]);

  const error = live.error ?? sendError ?? undefined;
  const errorKind: TurnErrorKind | undefined = live.error ? live.errorKind : sendError ? 'send_failed' : undefined;
  return { runtime, refetch, live, error, errorKind, retry, queue };
}
