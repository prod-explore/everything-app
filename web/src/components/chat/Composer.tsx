import { AttachmentPrimitive, ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { AlertTriangle, Paperclip, Send, X } from 'lucide-react';
import { useComposerDraft } from '../../hooks/useComposerDraft';
import { useTouchPrimary } from '../../hooks/useMedia';
import { StopButton } from './StopButton';
import { SlashMenu } from './SlashMenu';
import { QueuedMessages, type MessageQueueControls } from './QueuedMessages';

export function Composer({
  conversationId,
  error,
  leading,
  trailing,
  queue,
}: {
  /** The chat this box belongs to: its unsent text is kept per chat. */
  conversationId: string;
  /** Why the last message could not be sent (it never reached the server). How a turn failed is shown under the message instead. */
  error?: string;
  /** First control of the row, before the attach button (reasoning effort). */
  leading?: ReactNode;
  /** Controls between the message box and the send button (context meter). */
  trailing?: ReactNode;
  /** Messages waiting for their turn; without it the box is locked while the assistant works. */
  queue?: MessageQueueControls;
}) {
  useComposerDraft(conversationId);
  // On a touch screen Enter is a line break and the Send button sends (there is no Shift key to hold, and Escape is not a key).
  const touch = useTouchPrimary();
  return (
    <div className="border-t border-border bg-bg">
      {error && (
        <div role="alert" className="flex items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2 text-xs text-fg-secondary">
          <AlertTriangle size={13} className="shrink-0 text-fg-tertiary" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {queue && <QueuedMessages queue={queue} />}

      <SlashMenu onCommand={name => window.dispatchEvent(new CustomEvent('app:command', { detail: { name } }))} />

      <ComposerPrimitive.Quote className="mx-3 mt-2 flex items-start gap-2 rounded-button border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-fg-tertiary">
        <span className="line-clamp-2 flex-1">
          <ComposerPrimitive.QuoteText />
        </span>
        <ComposerPrimitive.QuoteDismiss className="shrink-0 rounded p-0.5 hover:bg-bg-tertiary hover:text-fg-secondary">
          <X size={12} />
        </ComposerPrimitive.QuoteDismiss>
      </ComposerPrimitive.Quote>

      <ComposerPrimitive.Attachments>
        {({ attachment }) => (
          <AttachmentPrimitive.Root
            key={attachment.id}
            className="mx-3 mt-2 flex items-center gap-2 rounded-button border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-fg-secondary"
          >
            <Paperclip size={12} className="shrink-0 text-fg-tertiary" />
            <span className="flex-1 truncate">
              <AttachmentPrimitive.Name />
            </span>
            <AttachmentPrimitive.Remove className="shrink-0 rounded p-0.5 hover:bg-bg-tertiary hover:text-fg">
              <X size={12} />
            </AttachmentPrimitive.Remove>
          </AttachmentPrimitive.Root>
        )}
      </ComposerPrimitive.Attachments>

      {/* One row, on a phone too: attach · message box (grows with what is typed) · send. The effort picker, when the model has
          one, takes a thin row of its own above on a phone; the context ring sits next to send. */}
      <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl flex-wrap items-end gap-2 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:flex-nowrap sm:p-3">
        <div className="empty:hidden max-sm:order-first max-sm:flex max-sm:basis-full max-sm:justify-end">{leading}</div>

        <ComposerPrimitive.AddAttachment aria-label="Attach image" title="Attach image" className="flex size-[42px] shrink-0 items-center justify-center rounded-button border border-border text-fg-tertiary transition-colors hover:text-fg-secondary disabled:opacity-30">
          <Paperclip size={16} />
        </ComposerPrimitive.AddAttachment>

        <ComposerPrimitive.Input
          id="composer-input"
          rows={1}
          placeholder="Message…"
          enterKeyHint="enter"
          // Touch: Enter inserts a line break, only the Send button sends; Escape must not stop the running turn while typing.
          unstable_insertNewlineOnTouchEnter
          cancelOnEscape={!touch}
          // Enter queues the message while the assistant works; Ctrl/Cmd+Enter makes it go out now (see lib/runtime.ts).
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) queue?.interruptNext();
          }}
          // 16px on a touch screen: iOS zooms into any field below that when it gets focus.
          className="max-h-32 min-h-[42px] min-w-0 flex-1 resize-none rounded-button border border-border bg-bg-secondary px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-tertiary focus:border-border-hover [@media(pointer:coarse)]:max-h-40 [@media(pointer:coarse)]:text-base"
        />

        {trailing}

        <ComposerPrimitive.Send
          aria-label="Send message"
          title={queue ? 'Send (while the assistant works: add to the queue — Ctrl+Enter sends right away)' : 'Send'}
          className="flex size-[42px] shrink-0 items-center justify-center rounded-button bg-fg text-bg transition-opacity disabled:opacity-30"
        >
          <Send size={16} />
        </ComposerPrimitive.Send>
        <ThreadPrimitive.If running>
          <StopButton />
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </div>
  );
}
