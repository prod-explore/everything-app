import type { ThreadAssistantMessagePart, ThreadMessageLike } from '@assistant-ui/react';
import type { LivePart } from '../hooks/useSSE';
import type { ContentBlock, RawMessage, ToolResultPart } from '../types';
import { parseStoredTime } from './answerPlacement';

/**
 * What the chat view knows about a message beyond its parts, carried on `metadata.custom` (assistant-ui hands it to every
 * component of the message).
 */
export interface MessageMeta {
  /** Every version of this message (ids of the typed user message), oldest first; on a reply, those of the message it answers. */
  versions?: number[];
  /** Which of `versions` is the one shown. */
  currentVersion?: number;
  /** A reply that was cut short, and the sentence saying why when it was a failure. */
  incomplete?: 'stopped' | 'error';
  errorText?: string;
  /** How long each reasoning part ran, in the order of the reasoning parts (null = unknown). */
  thoughtMs?: Array<number | null>;
  /** Where an edit of the reply's text goes: the stored row and the index of the text block in it. */
  textEdit?: { rowId: number; index: number };
  /** The id of the stored row this message starts with / ends with. */
  firstRowId?: number;
  lastRowId?: number;
}

const thoughtsOf = (m: MessageMeta): Array<number | null> => m.thoughtMs ?? [];

const metaOf = (custom: MessageMeta): { metadata: { custom: Record<string, unknown> } } => ({ metadata: { custom: custom as Record<string, unknown> } });

/** `{ createdAt }` for a stored row, or nothing when the API sent no (valid) time — so existing shapes stay unchanged. */
function storedAt(msg: RawMessage): { createdAt?: Date } {
  const t = parseStoredTime(msg.createdAt);
  return t === null ? {} : { createdAt: new Date(t) };
}

/** A stored tool result as the text the card shows and the pictures it carries (as `data:` URLs / URLs). */
export function splitToolResult(content: string | ToolResultPart[] | undefined): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image') images.push(part.source.type === 'base64' ? `data:${part.source.media_type};base64,${part.source.data}` : part.source.url);
  }
  return { text: texts.join('\n'), images };
}

/**
 * db.ts stores messages as content blocks: a tool call and its result are
 * two separate messages (`assistant` with a `tool_use` block, then `user`
 * with the matching `tool_result` block). assistant-ui instead wants the result attached
 * directly to the `tool-call` part inside the assistant message that made
 * the call. This fold does that merge, and drops the now-redundant
 * tool-result-only user messages (they carry no content a person typed).
 */
export function foldRawMessages(raw: RawMessage[]): ThreadMessageLike[] {
  const result: ThreadMessageLike[] = [];
  // The versions of the user message the reply being folded answers (a reply has no versions of its own: a new version of
  // the question brings a new reply).
  let versions: number[] | undefined;
  let currentVersion: number | undefined;

  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i];

    // A compaction marker: the model now sees a summary instead of everything before this point. Shown as a notice,
    // placed before the message that triggered it so the answer to that message stays directly under it.
    if (msg.role === 'summary') {
      const c = msg.content as { text?: string };
      const notice: ThreadMessageLike = { id: String(msg.id), role: 'system', content: [{ type: 'text', text: typeof c?.text === 'string' ? c.text : '' }] };
      const prev = result[result.length - 1];
      if (prev && prev.role === 'user') result.splice(result.length - 1, 0, notice);
      else result.push(notice);
      continue;
    }

    const blocks: ContentBlock[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content as ContentBlock[]);
    // A user message that is PURELY tool_result blocks isn't a real user
    // turn — it's plumbing already folded onto the preceding assistant
    // message's tool-call parts in the loop below. Skip it here.
    if (msg.role === 'user' && blocks.length > 0 && blocks.every(b => b.type === 'tool_result')) {
      continue;
    }

    if (msg.role === 'user') {
      // Real DB row id (not array index) — edit/regenerate need this to
      // tell server.ts which message to branch from. See lib/runtime.ts.
      const id = String(msg.id);
      const parts: ThreadMessageLike['content'] = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' } | { type: 'image' }> => b.type === 'text' || b.type === 'image')
        .map(b =>
          b.type === 'text'
            ? { type: 'text' as const, text: b.text }
            : { type: 'image' as const, image: `data:${b.source.media_type};base64,${b.source.data}` },
        );
      versions = msg.versions && msg.versions.length > 1 ? msg.versions : undefined;
      currentVersion = msg.id;
      result.push({
        id, role: 'user', content: parts.length > 0 ? parts : [{ type: 'text', text: '' }], ...storedAt(msg),
        ...(versions ? metaOf({ versions, currentVersion: msg.id }) : {}),
      });
      continue;
    }

    // Assistant message: text/tool_use parts as-is, then look ahead to the
    // immediately following message for this call's tool_result (that's
    // always where db.ts/llm-loop.ts put it — one user message per
    // round of tool results, right after the assistant message that
    // requested them).
    const resultsByCallId = new Map<string, { content: string; images: string[]; isError: boolean }>();
    const next = raw[i + 1];
    if (next && next.role === 'user') {
      const nextBlocks: ContentBlock[] = typeof next.content === 'string' || !Array.isArray(next.content) ? [] : next.content;
      for (const b of nextBlocks) {
        if (b.type === 'tool_result') {
          const { text, images } = splitToolResult(b.content);
          resultsByCallId.set(b.tool_use_id, { content: text, images, isError: Boolean(b.is_error) });
        }
      }
    }

    const parts: ThreadAssistantMessagePart[] = [];
    const thoughtMs: Array<number | null> = [];
    let textBlocks = 0;
    let textEdit: MessageMeta['textEdit'];
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
        textEdit = { rowId: msg.id, index: textBlocks++ };
      } else if (block.type === 'thinking') {
        if (block.thinking) {
          parts.push({ type: 'reasoning', text: block.thinking });
          thoughtMs.push(block.durationMs ?? null);
        }
      } else if (block.type === 'tool_use') {
        const res = resultsByCallId.get(block.id);
        parts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          // Tool args are arbitrary JSON from the model — genuinely JSON-safe
          // at runtime (a model only ever sends JSON), but our own
          // ContentBlock type declares `input` as Record<string, unknown>,
          // which is looser than the ReadonlyJSONObject this field wants.
          args: block.input as unknown as Extract<ThreadAssistantMessagePart, { type: 'tool-call' }>['args'],
          argsText: JSON.stringify(block.input),
          result: res?.content,
          isError: res?.isError,
          // Pictures the tool returned (a screenshot); the card shows them as thumbnails.
          ...(res && res.images.length > 0 ? { artifact: { images: res.images } } : {}),
        });
      }
    }
    // One turn = one assistant message: a turn with several tool rounds is stored as
    // assistant → tool_result → assistant …, but reads as a single response (like Claude/ChatGPT).
    // The tool_result-only user messages were skipped above, so the previous entry is the same turn.
    const prev = result[result.length - 1];
    const prevMeta = ((prev?.metadata?.custom ?? {}) as MessageMeta);
    if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
      const joined = [...thoughtsOf(prevMeta), ...thoughtMs];
      result[result.length - 1] = {
        ...prev,
        content: [...(prev.content as ThreadAssistantMessagePart[]), ...parts],
        ...metaOf({
          ...prevMeta,
          thoughtMs: joined,
          textEdit: textEdit ?? prevMeta.textEdit,
          lastRowId: msg.id,
          // A later row of the same reply decides how it ended.
          incomplete: msg.incomplete,
          errorText: msg.errorText,
        }),
      };
    } else {
      result.push({
        id: String(msg.id), role: 'assistant', content: parts, ...storedAt(msg),
        ...metaOf({ versions, currentVersion, incomplete: msg.incomplete, errorText: msg.errorText, thoughtMs, textEdit, firstRowId: msg.id, lastRowId: msg.id }),
      });
    }
  }

  return result;
}

/**
 * Renders the turn currently in progress (from useSSE's live state) as one
 * more ThreadMessageLike, appended after the persisted history — so the
 * user sees text/tool calls appear as the backend emits them instead of
 * only once the whole turn lands in the database.
 *
 * Tool calls without a real toolCallId yet (the backend doesn't emit one —
 * see useSSE.ts) get a positional placeholder; it never has to be stable
 * across renders because this message is discarded the moment the turn
 * finishes and the authoritative persisted version (with real ids) takes
 * over on the next messages refetch.
 */
export function liveTurnToMessage(parts: LivePart[], running = true): ThreadMessageLike | null {
  if (parts.length === 0) return null;
  const thoughtMs: Array<number | null> = [];
  const content: ThreadMessageLike['content'] = parts.map((part, index) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'reasoning') {
      thoughtMs.push(part.startedAt !== undefined && part.endedAt !== undefined ? part.endedAt - part.startedAt : null);
      return { type: 'reasoning', text: part.text };
    }
    return {
      type: 'tool-call',
      toolCallId: `live-${index}`,
      toolName: part.call.toolName ?? part.call.label,
      args: {},
      argsText: '',
      result: part.call.result?.truncatedOutput,
      isError: part.call.result?.isError,
    };
  });
  return {
    id: 'live-turn',
    role: 'assistant',
    content,
    status: running ? { type: 'running' } : { type: 'complete', reason: 'unknown' },
    ...metaOf({ thoughtMs }),
  };
}

/**
 * The turn that carries on a reply that was cut short, shown as the end of that same message: the live message's parts follow
 * the stored ones, and its first text runs on from the stored text.
 */
export function appendToLastReply(persisted: ThreadMessageLike[], live: ThreadMessageLike): ThreadMessageLike[] {
  const last = persisted[persisted.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content) || !Array.isArray(live.content)) return [...persisted, live];
  const before = last.content as ThreadAssistantMessagePart[];
  const after = [...(live.content as ThreadAssistantMessagePart[])];
  const tail = before[before.length - 1];
  const head = after[0];
  const content = tail?.type === 'text' && head?.type === 'text' ? [...before.slice(0, -1), { type: 'text' as const, text: tail.text + head.text }, ...after.slice(1)] : [...before, ...after];
  const meta = (last.metadata?.custom ?? {}) as MessageMeta;
  const liveMeta = (live.metadata?.custom ?? {}) as MessageMeta;
  return [
    ...persisted.slice(0, -1),
    // The stored mark ("Stopped" / "Interrupted") goes while the turn runs: it is carried on again, not over.
    { ...last, content, status: live.status, ...metaOf({ ...meta, incomplete: undefined, errorText: undefined, thoughtMs: [...thoughtsOf(meta), ...thoughtsOf(liveMeta)] }) },
  ];
}
