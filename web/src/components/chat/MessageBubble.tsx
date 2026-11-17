import { ActionBarPrimitive, MessagePrimitive, groupPartByType, useAui, useAuiState } from '@assistant-ui/react';
import { ComposerPrimitive } from '@assistant-ui/react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import { Check, Copy, Pencil, Quote, RotateCw, Trash2, X } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { MarkdownText } from './MarkdownText';
import { ToolCallCard } from './ToolCallCard';
import { StepGroup } from './StepGroup';
import { Reasoning } from './Reasoning';
import { TurnErrorBlock } from './TurnErrorBlock';
import { VersionPicker } from './VersionPicker';
import { ModelMenu } from './ModelMenu';
import { useChatActions } from '../../lib/chatActions';
import { useCanHover } from '../../hooks/useMedia';
import { formatMessageTime } from '../../lib/time';
import type { MessageMeta } from '../../lib/messages';

const PlainText: TextMessagePartComponent = ({ text }) => <span>{text}</span>;

/** What the chat knows about this message beyond its parts (versions, "cut short" mark, where an edit goes…). */
const useMeta = (): MessageMeta => useAuiState(s => s.message.metadata.custom) as MessageMeta;

/** Class of a message's action row: with a mouse it waits for the pointer, on a touch screen it is always there. */
function useActionRowClass(): string {
  const canHover = useCanHover();
  return `flex items-center gap-0.5 ${canHover ? 'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100' : ''}`;
}

/** The time a message was stored, small and quiet. */
function MessageTime() {
  const at = useAuiState(s => s.message.createdAt);
  if (!at) return null;
  return (
    <time dateTime={at.toISOString()} title={at.toLocaleString()} className="px-1 text-[11px] tabular-nums text-fg-tertiary">
      {formatMessageTime(at)}
    </time>
  );
}

// Adjacent tool calls collapse into one "N steps" block; text parts stay outside it.
const GROUP_STEPS = groupPartByType({ 'tool-call': ['group-steps'] });

/** Small icon button shared by both bubbles' action bars — kept local since it's only ever used here. */
function ActionButton({ children, ...rest }: ComponentProps<'button'>) {
  return (
    <button
      {...rest}
      className="rounded p-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg-secondary disabled:opacity-30 [@media(hover:none)]:p-1.5"
    >
      {children}
    </button>
  );
}

/** Deletes this message and everything after it — routed through the onDelete adapter wired in lib/runtime.ts. */
function DeleteButton() {
  const aui = useAui();
  return (
    <ActionButton
      aria-label="Delete from here"
      title="Delete this message and everything after it"
      onClick={() => void aui.message.delete()}
    >
      <Trash2 size={13} />
    </ActionButton>
  );
}

/** Sets this message as the composer's pending quote — see Composer.tsx for the preview banner this feeds. */
function QuoteButton() {
  const aui = useAui();
  const id = useAuiState(s => s.message.id);
  const text = useAuiState(s =>
    s.message.content
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map(c => c.text)
      .join(''),
  );
  return (
    <ActionButton
      aria-label="Quote"
      title="Quote in reply"
      disabled={!text.trim()}
      onClick={() => aui.thread.composer().setQuote({ text, messageId: id })}
    >
      <Quote size={13} />
    </ActionButton>
  );
}

/** Replaces the normal bubble while a user message is being edited — the ambient composer scope resolves to this message's own edit composer inside MessagePrimitive.Root. */
function EditComposer() {
  return (
    <ComposerPrimitive.Root className="flex w-full flex-col gap-2 rounded-message border border-border-hover bg-bg-secondary p-2.5">
      <ComposerPrimitive.Input
        rows={1}
        autoFocus
        className="max-h-64 w-full resize-none bg-transparent text-sm text-fg outline-none"
      />
      <div className="flex justify-end gap-1">
        <ComposerPrimitive.Cancel asChild>
          <ActionButton aria-label="Cancel edit">
            <X size={14} />
          </ActionButton>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <ActionButton aria-label="Save edit">
            <Check size={14} />
          </ActionButton>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

export function UserBubble() {
  const isEditing = useAuiState(s => s.composer.isEditing);
  const meta = useMeta();
  const canHover = useCanHover();
  const row = useActionRowClass();
  // While editing, the row takes its full width: a shrink-to-fit row would squeeze the edit box to a sliver.
  return (
    <MessagePrimitive.Root className={`group ml-auto flex max-w-[85%] flex-col items-end gap-1 ${isEditing ? 'w-full' : ''}`}>
      {isEditing ? (
        <EditComposer />
      ) : (
        <>
          <div className="whitespace-pre-wrap break-words rounded-message bg-bg-tertiary px-4 py-2.5 text-sm text-fg">
            <MessagePrimitive.Parts components={{ Text: PlainText }} />
          </div>
          <div className="flex items-center gap-1">
            {meta.versions && <VersionPicker versions={meta.versions} current={meta.currentVersion} />}
            <ActionBarPrimitive.Root hideWhenRunning autohide={canHover ? 'not-last' : 'never'} className={row}>
              <ActionBarPrimitive.Edit asChild>
                <ActionButton aria-label="Edit">
                  <Pencil size={13} />
                </ActionButton>
              </ActionBarPrimitive.Edit>
              <ActionBarPrimitive.Copy asChild>
                <ActionButton aria-label="Copy">
                  <Copy size={13} />
                </ActionButton>
              </ActionBarPrimitive.Copy>
              <DeleteButton />
            </ActionBarPrimitive.Root>
            <MessageTime />
          </div>
        </>
      )}
    </MessagePrimitive.Root>
  );
}

/** Replaces the text of a reply while it is being edited; saving rewrites it in place, without a new answer. */
function ReplyEditor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="not-prose flex w-full flex-col gap-2 rounded-message border border-border-hover bg-bg-secondary p-2.5">
      <textarea
        autoFocus
        aria-label="Edit reply"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
        rows={Math.min(16, Math.max(3, text.split('\n').length))}
        className="max-h-96 w-full resize-y bg-transparent text-sm text-fg outline-none [@media(pointer:coarse)]:text-base"
      />
      <div className="flex justify-end gap-1">
        <ActionButton aria-label="Cancel edit" onClick={onCancel}><X size={14} /></ActionButton>
        <ActionButton aria-label="Save edit" disabled={!text.trim() || text === initial} onClick={() => onSave(text)}><Check size={14} /></ActionButton>
      </div>
    </div>
  );
}

export function AssistantBubble() {
  const meta = useMeta();
  const chat = useChatActions();
  const aui = useAui();
  const canHover = useCanHover();
  const row = useActionRowClass();
  const [editing, setEditing] = useState(false);
  const isLast = useAuiState(s => s.message.isLast);
  const running = useAuiState(s => s.message.status?.type === 'running');
  const content = useAuiState(s => s.message.content);
  const lastText = content.reduce((at, p, i) => (p.type === 'text' ? i : at), -1);
  const hasText = content.some(p => p.type === 'text' && p.text.trim());
  const stored = meta.textEdit !== undefined && !running;
  return (
    <MessagePrimitive.Root className="group flex w-full flex-col gap-1">
      <div className="prose prose-invert prose-sm max-w-none py-1 text-fg [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-bg-secondary [&_pre]:p-3">
        <MessagePrimitive.GroupedParts groupBy={GROUP_STEPS}>
          {({ part, children }) => {
            switch (part.type) {
              case 'group-steps':
                return (
                  <StepGroup indices={part.indices} running={part.status.type === 'running'}>
                    {children}
                  </StepGroup>
                );
              case 'text':
                // A part carries no position, so the text itself says which one is the last (identical blocks edit alike).
                if (editing && meta.textEdit && lastText >= 0 && part.text === (content[lastText] as { text: string }).text) {
                  return (
                    <ReplyEditor
                      initial={part.text}
                      onCancel={() => setEditing(false)}
                      onSave={text => { setEditing(false); void chat.editReply(meta.textEdit!.rowId, text, meta.textEdit!.index); }}
                    />
                  );
                }
                return <MarkdownText {...part} />;
              case 'reasoning': {
                // Which reasoning part of the message this is (by its text), to look up how long it thought.
                const first = content.findIndex(p => p.type === 'reasoning' && p.text === part.text);
                const ordinal = content.slice(0, Math.max(first, 0)).filter(p => p.type === 'reasoning').length;
                return <Reasoning text={part.text} running={part.status.type === 'running'} ms={meta.thoughtMs?.[ordinal]} />;
              }
              case 'tool-call':
                return part.toolUI ?? <ToolCallCard {...part} />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </div>
      {meta.incomplete && !running && (
        <TurnErrorBlock
          variant={meta.incomplete}
          message={meta.errorText}
          detail={isLast ? chat.turnError?.detail : undefined}
          kind={isLast ? chat.turnError?.kind : undefined}
          hasReply
          canContinue={hasText}
          actions={isLast}
        />
      )}
      <div className="flex items-center gap-1">
        <MessageTime />
        {meta.versions && <VersionPicker versions={meta.versions} current={meta.currentVersion} />}
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide={canHover ? 'not-last' : 'never'}
          autohideFloat="single-branch"
          className={row}
        >
          <ActionBarPrimitive.Copy asChild>
            <ActionButton aria-label="Copy">
              <Copy size={13} />
            </ActionButton>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <ActionButton aria-label="Regenerate">
              <RotateCw size={13} />
            </ActionButton>
          </ActionBarPrimitive.Reload>
          <ModelMenu
            models={chat.models}
            current={chat.currentModel}
            onlyLocal={chat.onlyLocal}
            title="Regenerate with…"
            onPick={model => { chat.setReloadModel(model); aui.message.reload(); }}
            className="flex items-center rounded p-1 text-fg-tertiary hover:bg-bg-tertiary hover:text-fg-secondary [@media(hover:none)]:p-1.5"
          >
            <span className="sr-only">Regenerate with…</span>
          </ModelMenu>
          {stored && (
            <ActionButton aria-label="Edit reply" title="Edit this reply (does not ask the model again)" disabled={chat.busy} onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </ActionButton>
          )}
          <QuoteButton />
          <DeleteButton />
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}
