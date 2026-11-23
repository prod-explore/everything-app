import { createHash, randomUUID } from 'node:crypto';
import type * as Llm from '../llm-types.js';
import type { LlmClient, MessageStreamLike, StreamOptions } from '../llm-loop.js';
import type { ModelInfo } from './registry.js';

/**
 * Adapter for any server that speaks OpenAI chat-completions. It never looks at who the
 * provider is; a server with quirks is fixed by a gateway in front of it. The app's
 * canonical message format (llm-types.ts) is what's persisted and what the tool loop
 * consumes, so this file's whole job is translating *out* to chat-completions and *back*
 * to an Llm.Message, per request. Nothing provider-specific ever reaches
 * the database or the loop except through MetaStore.
 */

/**
 * Provider state that has no slot in the message format but that the provider insists on getting back
 * (a tool call's `extra_content` such as Gemini's thought signature, `reasoning_content` during a tool loop).
 * Whatever a response carries is kept as it came and sent back as it was, so no provider needs special handling here.
 * Keyed by tool call id.
 */
export interface MetaStore {
  get(toolCallId: string): Record<string, unknown> | null;
  set(toolCallId: string, meta: Record<string, unknown>): void;
}

export class ProviderHttpError extends Error {
  /** Machine-readable `error.code` the server sent, when it sent one. */
  readonly code?: string;
  /** How long the server asked us to wait before trying again (Retry-After / `retry_after_s`), in ms. */
  retryAfterMs?: number;
  /** The failure came after part of the answer had already arrived — repeating the request would duplicate it, so it is never retried. */
  progressed = false;

  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
    extra: { code?: string; retryAfterMs?: number } = {},
  ) {
    super(`${provider} API error ${status}: ${detail}`);
    this.name = 'ProviderHttpError';
    if (extra.code) this.code = extra.code;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  /** Maps our model id to the upstream one (`@slug/x` → `x`). */
  upstreamModel?: (modelId: string) => string;
  meta: MetaStore;
  modelInfo: (modelId: string) => ModelInfo;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Longest a single request may take. Only a guard against a hung connection. Default 15 min. */
  timeoutMs?: number;
  /** A streamed answer that goes silent (no data, not even keep-alive comments) for this long is cut off. Default 2 min. */
  streamIdleMs?: number;
  /** How the provider is called in messages shown to a person (its label). */
  label?: string;
  /**
   * Quick retry policy: this many retries (1 s, 2 s, …), used when no `retryBudgetMs` is given. For background work
   * that should give up fast (titles, summaries). 0 = never retry.
   */
  maxRetries?: number;
  /**
   * Keep retrying transient failures (429/502/503/504/network) for up to this long, counted from the first failure.
   * Unset = DEFAULT_RETRY_BUDGET_MS (unless `maxRetries` is given); 0 = no automatic retries. A server that asks to wait
   * longer than what is left fails at once, saying when to retry. The kill-switch signal interrupts the wait at any moment.
   */
  retryBudgetMs?: number;
  /** Longest single pause between attempts. Default 5 min. */
  retryMaxDelayMs?: number;
  /** Called before every wait, so the UI/log can say "provider busy, retrying in …". */
  onRetry?: (info: RetryInfo) => void;
}

/** What a failed request gets when nobody chose a window (the provider card's "Retry busy errors for" is empty). */
export const DEFAULT_RETRY_BUDGET_MS = 2 * 60_000;

export interface RetryInfo {
  provider: string;
  /** The conversation whose request is waiting; absent for background work (titles, summaries), which only logs. */
  conversationId?: string;
  attempt: number;
  status: number | 'network';
  delayMs: number;
  /** Time left before giving up. */
  remainingMs: number;
}

/** Exponential backoff (1 s, 2 s, 4 s …) capped at `maxDelayMs`, with ±20 % jitter; a server `Retry-After` wins over the schedule. */
export function retryDelayMs(attempt: number, retryAfterSec: number | undefined, maxDelayMs: number, rand: () => number = Math.random): number {
  const base = retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? retryAfterSec * 1000
    : 1000 * 2 ** Math.min(attempt, 30) * (0.8 + 0.4 * rand());
  return Math.round(Math.min(Math.max(base, 1000), maxDelayMs));
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts (the timer is released at once, not left to run out). */
function abortableSleep(sleep: ((ms: number) => Promise<void>) | undefined, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
    const settle = (fn: () => void) => { signal?.removeEventListener('abort', onAbort); fn(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (sleep) sleep(ms).then(() => settle(resolve), e => settle(() => reject(e)));
    else timer = setTimeout(() => settle(resolve), ms);
  });
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return sec > 0 ? Math.round(sec * 1000) : undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) || at <= now ? undefined : at - now;
}

// ─── Wire types (only the fields we touch) ───────────────────────────────────

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider-specific per-call state, echoed back verbatim (Gemini keeps its thought signature here). */
  extra_content?: Record<string, unknown>;
}

type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string };

interface OaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OaiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: Record<string, unknown>;
      }>;
      reasoning_content?: string | null;
      /** OpenRouter and some gateways call it `reasoning`. */
      reasoning?: string | null;
    };
  }>;
  usage?: OaiUsage;
}

// ─── Tool name safety ────────────────────────────────────────────────────────

/** Chat-completions APIs cap function names at 64 chars of [A-Za-z0-9_.:-]. MCP-derived names ("server__tool") can exceed that. */
export function safeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (cleaned.length <= 64 && cleaned === name) return name;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${cleaned.slice(0, 55)}_${hash}`;
}

class NameMap {
  private readonly toOriginal = new Map<string, string>();
  safe(original: string): string {
    const s = safeToolName(original);
    this.toOriginal.set(s, original);
    return s;
  }
  original(safe: string): string {
    return this.toOriginal.get(safe) ?? safe;
  }
  /** Number of tools offered to the model in this request. */
  get size(): number {
    return this.toOriginal.size;
  }
  /** Maps a name the model produced (sent-safe or original) to the safe name we offered, or undefined if we never offered it. */
  resolve(name: string): string | undefined {
    if (this.toOriginal.has(name)) return name;
    const s = safeToolName(name);
    return this.toOriginal.has(s) ? s : undefined;
  }
}

// ─── Tool calls emitted as plain text ────────────────────────────────────────

/** Most calls a text-encoded batch may carry; anything longer is almost certainly prose. */
const MAX_RECOVERED_CALLS = 8;

/**
 * Small local models behind MindGate sometimes "call" a tool by writing the call as JSON in the message
 * body instead of using the tool_calls channel. When the WHOLE reply is such a payload (optionally in a
 * ```json fence) — `{name, arguments}` or an array of them — and every name is a tool we actually offered,
 * it is treated as a real call. Anything else (prose, unknown tool, broken JSON) returns null and stays text.
 */
export function recoverJsonToolCalls(
  text: string,
  resolveName: (name: string) => string | undefined,
): Array<{ name: string; arguments: Record<string, unknown> }> | null {
  let body = text.trim();
  const fence = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/.exec(body);
  if (fence) body = fence[1]!.trim();
  if (!body || (body[0] !== '{' && body[0] !== '[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || items.length > MAX_RECOVERED_CALLS) return null;
  const out: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const fn = item['function'] && typeof item['function'] === 'object' ? (item['function'] as Record<string, unknown>) : item;
    const name = fn['name'];
    if (typeof name !== 'string') return null;
    const safe = resolveName(name);
    if (!safe) return null;
    let args: unknown = fn['arguments'] ?? fn['parameters'] ?? fn['input'] ?? {};
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        return null;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    out.push({ name: safe, arguments: args as Record<string, unknown> });
  }
  return out;
}

// ─── Schema simplifying ──────────────────────────────────────────────────────

/**
 * 'flat' tool schema mode for small models. Keeps top-level primitive parameters as they are;
 * nested object/array parameters (and anything built from anyOf/oneOf/allOf/$ref) become a string
 * documented as JSON, so the model never has to emit nested JSON inside a tool call. Returns the
 * simplified schema plus the names of the properties that must be JSON-decoded on the way back.
 */
export function flattenToolSchema(schema: unknown): { schema: Record<string, unknown> | undefined; flattened: string[] } {
  if (!schema || typeof schema !== 'object') return { schema: undefined, flattened: [] };
  const root = schema as Record<string, unknown>;
  const props = root['properties'];
  if (root['type'] !== 'object' || !props || typeof props !== 'object' || Object.keys(props).length === 0) {
    return { schema: undefined, flattened: [] };
  }
  const flattened: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const primitive = p['type'] === 'string' || p['type'] === 'number' || p['type'] === 'integer' || p['type'] === 'boolean';
    const composite = 'anyOf' in p || 'oneOf' in p || 'allOf' in p || '$ref' in p;
    if (primitive && !composite) {
      const simple: Record<string, unknown> = { type: p['type'] };
      if (typeof p['description'] === 'string') simple['description'] = p['description'];
      if (Array.isArray(p['enum']) && p['enum'].every(v => typeof v === 'string')) simple['enum'] = p['enum'];
      out[name] = simple;
    } else {
      flattened.push(name);
      const was = p['type'] === 'array' ? 'an array' : p['type'] === 'object' ? 'an object' : 'a JSON value';
      const desc = typeof p['description'] === 'string' ? `${p['description']} ` : '';
      out[name] = { type: 'string', description: `${desc}(Pass ${was} as a JSON-encoded string.)` };
    }
  }
  const required = Array.isArray(root['required']) ? (root['required'] as unknown[]).filter((r): r is string => typeof r === 'string' && r in out) : [];
  return { schema: { type: 'object', properties: out, ...(required.length ? { required } : {}) }, flattened };
}

// ─── internal messages → chat-completions ────────────────────────────────────────────

function systemText(system: Llm.MessageCreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map(b => b.text).join('\n\n');
}

function toolResultText(block: Llm.ToolResultBlockParam, sees: boolean): string {
  let text: string;
  if (typeof block.content === 'string') text = block.content;
  else if (Array.isArray(block.content)) {
    // A tool message can only hold text on chat-completions: pictures from the tool follow in a user message (see toolImageParts).
    text = block.content
      .map(c => (c.type === 'text' ? c.text : sees ? '[image — attached in the next message]' : "[image omitted — this model can't read images]"))
      .join('\n');
  } else text = '';
  if (block.is_error) text = `Error: ${text || 'tool call failed'}`;
  // Several providers reject an empty tool message outright.
  return text || '(no output)';
}

/** The pictures a tool returned, as parts of the user message that follows the tool messages (empty for a model that cannot see). */
function toolImageParts(block: Llm.ToolResultBlockParam): ContentPart[] {
  if (!Array.isArray(block.content)) return [];
  return block.content.flatMap((c): ContentPart[] => {
    if (c.type !== 'image') return [];
    const url = c.source.type === 'base64' ? `data:${c.source.media_type};base64,${c.source.data}` : c.source.url;
    return [{ type: 'image_url', image_url: { url } }];
  });
}

/** Index of the last user message that carries real user input (not just tool results) — where the current tool loop began. */
function currentTurnStart(messages: Llm.MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return i;
    if (m.content.some(b => b.type !== 'tool_result')) return i;
  }
  return 0;
}

function normalizeToolCallId(id: string | undefined | null): string {
  const cleaned = (id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  // Tool-call ids must be [a-zA-Z0-9_-]+ on most providers — some omit them or use other characters.
  return cleaned || `call_${randomUUID().replace(/-/g, '')}`;
}

export interface TranslateContext {
  modelInfo: ModelInfo;
  meta: MetaStore;
  names: NameMap;
  /** Parameters sent as JSON-encoded strings in 'flat' mode: tool name (as sent) → property names. Filled by toChatTools. */
  flattened?: Map<string, Set<string>>;
}

export function toChatMessages(params: Llm.MessageCreateParamsNonStreaming, ctx: TranslateContext): OaiMessage[] {
  const out: OaiMessage[] = [];
  const sys = systemText(params.system);
  if (sys) out.push({ role: 'system', content: sys });

  const turnStart = currentTurnStart(params.messages);

  params.messages.forEach((m, idx) => {
    if (typeof m.content === 'string') {
      if (m.content) out.push({ role: m.role, content: m.content } as OaiMessage);
      return;
    }

    if (m.role === 'user') {
      const toolMessages: OaiMessage[] = [];
      const parts: ContentPart[] = [];
      const fromTools: ContentPart[] = [];
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          toolMessages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block, ctx.modelInfo.supportsImages) });
          if (ctx.modelInfo.supportsImages) fromTools.push(...toolImageParts(block));
        } else if (block.type === 'text') {
          if (block.text) parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          if (!ctx.modelInfo.supportsImages) {
            parts.push({ type: 'text', text: `[image attachment omitted — ${ctx.modelInfo.id} can't read images]` });
          } else if (block.source.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
          } else if (block.source.type === 'url') {
            parts.push({ type: 'image_url', image_url: { url: block.source.url } });
          }
        } else {
          parts.push({ type: 'text', text: `[${block.type} block omitted]` });
        }
      }
      // Tool messages must directly follow the assistant message that made the calls.
      out.push(...toolMessages);
      if (fromTools.length > 0) parts.unshift({ type: 'text', text: 'Image(s) returned by the tool call(s) above:' }, ...fromTools);
      if (parts.length > 0) {
        const onlyText = parts.every(p => p.type === 'text');
        out.push({
          role: 'user',
          content: onlyText ? parts.map(p => (p as { text: string }).text).join('\n') : parts,
        });
      }
      return;
    }

    // assistant (`thinking` blocks are for the UI only — they are skipped below)
    const texts: string[] = [];
    const calls: OaiToolCall[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        if (block.text) texts.push(block.text);
      } else if (block.type === 'tool_use') {
        calls.push({
          id: block.id,
          type: 'function',
          function: { name: ctx.names.safe(block.name), arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    const msg: Extract<OaiMessage, { role: 'assistant' }> = { role: 'assistant', content: texts.length ? texts.join('\n') : null };
    if (calls.length > 0) {
      msg.tool_calls = calls;
      const metas = calls.map(c => ctx.meta.get(c.id));

      calls.forEach((c, i) => {
        const extra = metas[i]?.['extraContent'];
        if (extra && typeof extra === 'object') c.extra_content = extra as Record<string, unknown>;
      });

      if (idx > turnStart) {
        // Thinking models want their reasoning echoed back while a tool loop is still in progress and
        // reject (or ignore) it on earlier turns — so: current loop only.
        const reasoning = metas.map(x => x?.['reasoningContent']).find(r => typeof r === 'string' && r);
        if (typeof reasoning === 'string') msg.reasoning_content = reasoning;
      }
    }
    if (msg.content !== null || msg.tool_calls) out.push(msg);
  });

  return out;
}

export function toChatTools(
  tools: Llm.MessageCreateParams['tools'],
  ctx: TranslateContext,
): Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> {
  const out: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> = [];
  const mode = ctx.modelInfo.toolSchemaMode ?? 'full';
  if (mode === 'none') return out;
  for (const tool of tools ?? []) {
    const safeName = ctx.names.safe(tool.name);
    let parameters: Record<string, unknown> | undefined;
    if (mode === 'flat') {
      const flat = flattenToolSchema(tool.input_schema);
      parameters = flat.schema;
      if (flat.flattened.length > 0) {
        ctx.flattened ??= new Map();
        ctx.flattened.set(safeName, new Set(flat.flattened));
      }
    } else {
      parameters = tool.input_schema as Record<string, unknown>;
    }
    out.push({
      type: 'function',
      function: {
        name: safeName,
        ...(tool.description ? { description: tool.description } : {}),
        ...(parameters ? { parameters } : {}),
      },
    });
  }
  return out;
}

// ─── chat-completions → internal messages ────────────────────────────────────────────

export function fromChatResponse(json: OaiResponse, requestedModel: string, ctx: TranslateContext, providerId: string): Llm.Message {
  const choice = json.choices?.[0];
  if (!choice?.message) throw new Error(`${providerId} returned no completion choices`);
  const msg = choice.message;

  const content: Llm.ContentBlock[] = [];
  let text = Array.isArray(msg.content)
    ? msg.content.map(p => p.text ?? '').join('')
    : (msg.content ?? '');

  let calls = msg.tool_calls ?? [];
  // Local models sometimes write the call as JSON text instead of using tool_calls.
  if (calls.length === 0 && text && ctx.names.size > 0) {
    const recovered = recoverJsonToolCalls(text, n => ctx.names.resolve(n));
    if (recovered) {
      calls = recovered.map((r, i) => ({ id: `call_recovered_${randomUUID().replace(/-/g, '').slice(0, 12)}_${i}`, function: { name: r.name, arguments: JSON.stringify(r.arguments) } }));
      text = '';
    }
  }
  const reasoning = msg.reasoning_content || msg.reasoning || '';
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  if (text) content.push({ type: 'text', text });

  calls.forEach((tc, i) => {
    const id = normalizeToolCallId(tc.id);
    const rawArgs = tc.function?.arguments ?? '';
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      // Surfacing the raw string makes the MCP server reject it with a schema error the model can read and retry.
      input = { __invalid_arguments: rawArgs };
    }
    // 'flat' mode: parameters we asked the model to JSON-encode are decoded back to real objects/arrays.
    const encoded = ctx.flattened?.get(tc.function?.name ?? '');
    if (encoded) {
      for (const key of encoded) {
        const v = input[key];
        if (typeof v !== 'string') continue;
        try {
          input[key] = JSON.parse(v);
        } catch {
          /* leave the string: the tool's schema validation will tell the model what is wrong */
        }
      }
    }
    content.push({
      type: 'tool_use',
      id,
      name: ctx.names.original(tc.function?.name ?? ''),
      input,
    });

    const meta: Record<string, unknown> = {};
    if (tc.extra_content && Object.keys(tc.extra_content).length > 0) meta['extraContent'] = tc.extra_content;
    // One copy of the reasoning per response, hung off the first call — the replay side scans the whole message.
    if (i === 0 && reasoning) meta['reasoningContent'] = reasoning;
    if (Object.keys(meta).length > 0) ctx.meta.set(id, meta);
  });

  const toolUse = content.some(b => b.type === 'tool_use');
  const finish = choice.finish_reason;
  // Some compatibility layers return finish_reason "stop" alongside tool calls; the loop keys off stop_reason.
  const stop_reason: Llm.StopReason = toolUse
    ? 'tool_use'
    : finish === 'length'
      ? 'max_tokens'
      : finish === 'content_filter'
        ? 'refusal'
        : 'end_turn';

  const u = json.usage ?? {};
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;

  return {
    id: json.id ?? `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: json.model ?? requestedModel,
    content,
    stop_reason,
    stop_sequence: null,
    ...(toolUse && finish === 'length' ? { cut_off: true } : {}),
    usage: {
      input_tokens: Math.max(prompt - cached, 0),
      output_tokens: u.completion_tokens ?? 0,
      cache_read_input_tokens: cached || null,
    },
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
/** More likely a bug on the server than a passing condition: worth two quick retries, never the whole window. */
const LIMITED_RETRY = new Set([408, 500]);
const LIMITED_RETRIES = 2;

/**
 * Error codes a gateway or provider puts in `{ error: { code } }` for failures that waiting cannot fix: the
 * budget or subscription quota is spent until its reset. A plain 429 (`rate_limited`) is still retried; these must fail
 * fast with their message.
 */
const NO_RETRY_CODES = new Set(['budget_exhausted', 'upstream_quota_exhausted', 'insufficient_quota']);

/** What an `{ error: {...} }` object (an HTTP error body or an in-stream error event) says about the failure. */
export interface ErrorPayload {
  code?: string;
  /** HTTP status the object itself names (`status`, or a numeric `code`). */
  status?: number;
  message?: string;
  retryAfterMs?: number;
}

const asStatus = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 400 && v <= 599 ? v : undefined);

/**
 * Reads `code`, `type`, `status`, `retry_after_s` and `reset_at` out of an error object (or a whole error body).
 * `retry_after_s` may sit beside `error` instead of inside it, and `reset_at` counts as a wait only for a failure that
 * is not already known to last until then.
 */
export function parseErrorPayload(input: unknown, now: number = Date.now()): ErrorPayload {
  const root = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const err = root['error'] !== undefined ? root['error'] : root;
  const o = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const out: ErrorPayload = {};
  const code = typeof o['code'] === 'string' ? o['code'] : typeof o['type'] === 'string' ? o['type'] : undefined;
  if (code) out.code = code;
  const status = asStatus(o['status']) ?? asStatus(o['http_status']) ?? asStatus(o['code']);
  if (status) out.status = status;
  const message = typeof err === 'string' ? err : typeof o['message'] === 'string' ? o['message'] : undefined;
  if (message) out.message = message;
  for (const src of [o, root]) {
    const s = src['retry_after_s'] ?? src['retry_after'];
    if (typeof s === 'number' && Number.isFinite(s) && s > 0) { out.retryAfterMs = Math.round(s * 1000); break; }
  }
  if (out.retryAfterMs === undefined && typeof o['reset_at'] === 'string' && !NO_RETRY_CODES.has(out.code ?? '')) {
    const at = Date.parse(o['reset_at']);
    if (!Number.isNaN(at) && at > now) out.retryAfterMs = at - now;
  }
  return out;
}

function parseErrorBody(body: string): ErrorPayload {
  try { return parseErrorPayload(JSON.parse(body)); } catch { return {}; }
}

/** The HTTP status an in-stream error event stands for (it arrives inside a 200, so it has none of its own). */
export function statusForErrorEvent(p: ErrorPayload): number {
  if (p.status) return p.status;
  const c = (p.code ?? '').toLowerCase();
  if (NO_RETRY_CODES.has(c) || /rate_?limit/.test(c)) return 429;
  if (/overload|unavailable/.test(c)) return 503;
  if (/timeout|timed_out/.test(c)) return 504;
  if (/invalid_request|context_length/.test(c)) return 400;
  if (/authentication|invalid_api_key/.test(c)) return 401;
  if (/permission/.test(c)) return 403;
  return 502;
}

/** Connection-level failures (refused, reset, DNS) as opposed to our own timeout or the stop button; marked where fetch() is called. */
const networkFailures = new WeakSet<object>();
const tagNetworkFailure = (err: unknown): void => { if (err && typeof err === 'object') networkFailures.add(err); };

/** A failure worth another attempt: a retryable status (unless the server named a code that waiting cannot fix), or a dropped connection. */
interface Failure {
  status: number | 'network';
  retryAfterMs?: number;
  /** Retried only a couple of times even when the window is long. */
  limited: boolean;
}

function transientFailure(err: unknown): Failure | null {
  if (err instanceof ProviderHttpError) {
    if (err.progressed || !RETRYABLE.has(err.status) || NO_RETRY_CODES.has(err.code ?? '')) return null;
    return { status: err.status, ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}), limited: LIMITED_RETRY.has(err.status) };
  }
  return err && typeof err === 'object' && networkFailures.has(err) ? { status: 'network', limited: false } : null;
}

/** Ollama / llama.cpp messages for a generated tool call that is not valid JSON. */
const TOOL_PARSE_ERROR = /looks like object|can'?t find closing|error parsing tool call|invalid tool call|failed to parse.*tool/i;

/** `reasoning_effort` goes out only to models that are known to accept it (an unknown parameter makes strict servers answer 400). */
function effortField(params: Llm.MessageCreateParamsNonStreaming, info: ModelInfo): { reasoning_effort?: string } {
  return params.reasoning_effort && info.supportsEffort ? { reasoning_effort: params.reasoning_effort } : {};
}

/** Statuses a server answers with when it does not do `stream: true`. */
const STREAM_REFUSED = new Set([400, 404, 405, 415, 422, 501]);

const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_STREAM_IDLE_MS = 120_000;

/** reader.read() that gives up when nothing (not even an SSE comment) arrives for `idleMs`. */
async function readWithIdleLimit(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number, provider: string): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderHttpError(provider, 504, `the response stream went silent for ${Math.round(idleMs / 1000)}s`)), idleMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

function linkSignals(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(external?.reason ?? new Error('aborted'));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export class OpenAiCompatClient implements LlmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private get name(): string {
    return this.opts.label ?? 'provider';
  }

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep;
  }

  readonly messages = {
    create: async (
      params: Llm.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Llm.Message> => {
      const info = this.opts.modelInfo(params.model);
      const ctx: TranslateContext = { modelInfo: info, meta: this.opts.meta, names: new NameMap() };

      const tools = toChatTools(params.tools, ctx);
      const body = {
        model: this.opts.upstreamModel?.(params.model) ?? params.model,
        messages: toChatMessages(params, ctx),
        max_tokens: Math.max(params.max_tokens, info.minOutputTokens ?? 0),
        stream: false,
        ...effortField(params, info),
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      };

      try {
        const json = (await this.post('/chat/completions', body, options?.signal)) as OaiResponse;
        return fromChatResponse(json, params.model, ctx, this.name);
      } catch (err) {
        // A local model that cannot produce valid tool-call JSON must not kill the whole chat:
        // answer once without tools and say so, instead of surfacing a raw gateway error.
        if (
          tools.length > 0 &&
          err instanceof ProviderHttpError &&
          err.status === 400 &&
          TOOL_PARSE_ERROR.test(err.message)
        ) {
          const { tools: _t, tool_choice: _c, ...bare } = body as typeof body & { tool_choice?: string };
          const json = (await this.post('/chat/completions', bare, options?.signal)) as OaiResponse;
          const msg = fromChatResponse(json, params.model, ctx, this.name);
          const note = '_(This local model could not produce a valid tool call, so it answered without tools. Pick a larger model for tool use.)_\n\n';
          const first = msg.content.find(b => b.type === 'text') as Llm.TextBlock | undefined;
          if (first) first.text = note + first.text;
          else msg.content.unshift({ type: 'text', text: note.trim(), citations: null } as Llm.TextBlock);
          return msg;
        }
        throw err;
      }
    },
    stream: (params: Llm.MessageCreateParamsNonStreaming, options?: StreamOptions): MessageStreamLike => this.stream(params, options),
  };

  /**
   * Real token streaming for OpenAI-compatible providers. Text deltas are emitted as
   * `content_block_delta` events as they arrive; text, reasoning and `tool_calls` deltas (by index, with
   * arguments split across chunks) are accumulated and the final message goes through the same
   * fromChatResponse() translation as the non-streaming path, so tool calls behave identically.
   * A failure before the first token is retried by the same loop as create() (one request per attempt); only a server
   * that cannot stream at all falls back to create().
   */
  stream(params: Llm.MessageCreateParamsNonStreaming, options?: StreamOptions): MessageStreamLike {
    const listeners: Array<(e: Llm.MessageStreamEvent) => void> = [];
    const emit = (delta: Llm.MessageStreamEvent['delta']) => {
      const event: Llm.MessageStreamEvent = { type: 'content_block_delta', index: 0, delta };
      for (const l of listeners) l(event);
    };
    const emitText = (text: string) => emit({ type: 'text_delta', text });
    const emitThinking = (thinking: string) => emit({ type: 'thinking_delta', thinking });
    const final = (async () => {
      await Promise.resolve(); // let the caller attach listeners first
      return this.streamOnce(params, options?.signal, emitText, emitThinking, options?.onActivity);
    })();
    return {
      on(event: 'streamEvent', listener: (e: Llm.MessageStreamEvent) => void) {
        if (event === 'streamEvent') listeners.push(listener);
        return this;
      },
      finalMessage: () => final,
    };
  }

  private async streamOnce(
    params: Llm.MessageCreateParamsNonStreaming,
    external: AbortSignal | undefined,
    emitText: (text: string) => void,
    emitThinking?: (text: string) => void,
    onActivity?: () => void,
  ): Promise<Llm.Message> {
    const info = this.opts.modelInfo(params.model);
    const ctx: TranslateContext = { modelInfo: info, meta: this.opts.meta, names: new NameMap() };
    const tools = toChatTools(params.tools, ctx);
    const body = {
      model: this.opts.upstreamModel?.(params.model) ?? params.model,
      messages: toChatMessages(params, ctx),
      max_tokens: Math.max(params.max_tokens, info.minOutputTokens ?? 0),
      stream: true,
      ...effortField(params, info),
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    };
    try {
      return await this.withRetries(() => this.streamAttempt(params, body, ctx, external, emitText, emitThinking, onActivity), external);
    } catch (err) {
      if (this.cannotStream(err, tools.length > 0)) return this.messages.create(params, { signal: external });
      throw err;
    }
  }

  /** A 4xx that says "no streaming here" (or the local tool-call parse failure, which create() answers without tools) is worth one plain request. */
  private cannotStream(err: unknown, hasTools: boolean): boolean {
    if (!(err instanceof ProviderHttpError) || err.progressed) return false;
    if (hasTools && err.status === 400 && TOOL_PARSE_ERROR.test(err.message)) return true;
    return STREAM_REFUSED.has(err.status) && /stream/i.test(err.detail);
  }

  /** One streamed request. Whatever fails before the first delta is thrown as it is for the retry loop; after it, the error is marked `progressed`. */
  private async streamAttempt(
    params: Llm.MessageCreateParamsNonStreaming,
    body: Record<string, unknown>,
    ctx: TranslateContext,
    external: AbortSignal | undefined,
    emitText: (text: string) => void,
    emitThinking?: (text: string) => void,
    onActivity?: () => void,
  ): Promise<Llm.Message> {
    const { signal, cleanup } = linkSignals(external, this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Set at the first content, reasoning or tool-call delta: from then on a retry would repeat what the caller already has.
    let progressed = false;
    try {
      const res = await this.fetchAttempt(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify(body),
      }, signal);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) throw await this.httpError(res);
      if (!res.body) throw new ProviderHttpError(this.name, 502, 'the response had no body');
      // Some servers ignore stream:true and answer with plain JSON — accept that too.
      if (!type.includes('event-stream')) return fromChatResponse(this.checkAnswer(await res.json()), params.model, ctx, this.name);

      let text = '';
      // MindGate/custom models may answer with a tool call written as JSON text. A reply that starts with
      // { [ or ``` is held back (not streamed) until we know whether it was a call; otherwise it flows live.
      const mayBeTextCall = ctx.names.size > 0;
      let mode = (mayBeTextCall ? 'undecided' : 'stream') as 'undecided' | 'stream' | 'hold';
      const onText = (delta: string) => {
        text += delta;
        if (mode === 'stream') { emitText(delta); return; }
        if (mode === 'undecided') {
          const lead = text.trimStart();
          if (!lead) return;
          if (/^[{[`]/.test(lead)) { mode = 'hold'; return; }
          mode = 'stream';
          emitText(text);
        }
      };
      let reasoning = '';
      let finish: string | null = null;
      let id = '';
      let model = '';
      let usage: OaiResponse['usage'];
      const calls: OaiToolCall[] = [];
      const decoder = new TextDecoder();
      reader = res.body.getReader();
      let buffer = '';
      let done = false;
      const idleMs = this.opts.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
      while (!done) {
        let chunk: Awaited<ReturnType<typeof readWithIdleLimit>>;
        try {
          chunk = await readWithIdleLimit(reader, idleMs, this.name);
        } catch (err) {
          if (!progressed && !signal.aborted && !(err instanceof ProviderHttpError)) tagNetworkFailure(err);
          throw err;
        }
        if (chunk.done) break;
        // Any bytes at all - an SSE comment such as a gateway's keep-alive included - show the provider is alive; the turn's idle
        // timer is restarted by them, while only text or reasoning ends the wait for the answer.
        onActivity?.();
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; break; }
          let evt: {
            id?: string; model?: string; usage?: OaiResponse['usage'];
            choices?: Array<{ finish_reason?: string | null; delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }> } }>;
            error?: unknown;
          };
          try { evt = JSON.parse(data); } catch { continue; }
          if (evt.error) throw this.eventError(evt.error);
          if (evt.id) id = evt.id;
          if (evt.model) model = evt.model;
          if (evt.usage) usage = evt.usage;
          const choice = evt.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const d = choice.delta ?? {};
          const thought = d.reasoning_content || d.reasoning;
          if (thought) { progressed = true; reasoning += thought; emitThinking?.(thought); }
          if (d.content) { progressed = true; onText(d.content); }
          for (const tc of d.tool_calls ?? []) {
            progressed = true;
            const i = tc.index ?? calls.length;
            calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) calls[i]!.id = tc.id;
            if (tc.function?.name) calls[i]!.function.name += tc.function.name;
            if (tc.function?.arguments) calls[i]!.function.arguments += tc.function.arguments;
            if (tc.extra_content) calls[i]!.extra_content = { ...calls[i]!.extra_content, ...tc.extra_content };
          }
        }
      }
      // A stream that ends with neither [DONE] nor a finish reason was cut off (dropped connection, proxy reset):
      // handing back what arrived as if it were the whole answer would silently truncate it.
      if (!done && finish === null) throw new ProviderHttpError(this.name, 502, 'the response stream ended before the answer was complete');
      const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
      const json = {
        id, model: model || body.model,
        choices: [{
          index: 0,
          finish_reason: finish ?? (toolCalls.length ? 'tool_calls' : 'stop'),
          message: {
            role: 'assistant',
            content: text || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
        }],
        usage,
      } as unknown as OaiResponse;
      const message = fromChatResponse(json, params.model, ctx, this.name);
      // Held text that turned out NOT to be a tool call (a JSON answer, a code block) is released now.
      if (mode === 'hold') {
        const first = message.content.find(b => b.type === 'text') as Llm.TextBlock | undefined;
        if (first) emitText(first.text);
      }
      return message;
    } catch (err) {
      if (progressed && err instanceof ProviderHttpError) err.progressed = true;
      throw err;
    } finally {
      cleanup();
      void reader?.cancel().catch(() => {});
    }
  }

  /** Cheap authenticated call used by "Test key" in Settings. */
  async ping(): Promise<void> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/models`, {
      headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
    });
    if (!res.ok) throw new ProviderHttpError(this.name, res.status, this.redact((await res.text()).slice(0, 300)));
  }

  /** `GET {base}/models` — the raw entries of the provider's model list (OpenAI shape: `{ data: [...] }`). */
  async listModels(): Promise<unknown[]> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/models`, {
      headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
    });
    if (!res.ok) throw new ProviderHttpError(this.name, res.status, this.redact((await res.text()).slice(0, 300)));
    const json = (await res.json()) as { data?: unknown; models?: unknown };
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return list.slice(0, 1000);
  }

  private redact(text: string): string {
    return this.opts.apiKey ? text.split(this.opts.apiKey).join('[redacted]') : text;
  }

  /** fetch() whose connection-level failures are marked as transient (not our own timeout, not the stop button). */
  private async fetchAttempt(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (!signal.aborted) tagNetworkFailure(err);
      throw err;
    }
  }

  /** A non-2xx answer as an error that carries what the server said about it (code, how long to wait). */
  private async httpError(res: Response): Promise<ProviderHttpError> {
    const text = await res.text().catch(() => '');
    const parsed = parseErrorBody(text);
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? parsed.retryAfterMs;
    return new ProviderHttpError(this.name, res.status, this.redact(text.slice(0, 800)), {
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  /** An error event inside an otherwise healthy stream, with the status and classification it would have had as an HTTP answer. */
  private eventError(raw: unknown): ProviderHttpError {
    const parsed = parseErrorPayload(raw);
    const detail = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? 'stream error';
    return new ProviderHttpError(this.name, statusForErrorEvent(parsed), this.redact(detail.slice(0, 800)), {
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.retryAfterMs !== undefined ? { retryAfterMs: parsed.retryAfterMs } : {}),
    });
  }

  /** A 200 whose JSON is an error object instead of a completion is an error, whatever the status line said. */
  private checkAnswer(json: unknown): OaiResponse {
    const o = json as { error?: unknown; choices?: unknown } | null;
    if (o && typeof o === 'object' && o.error && !o.choices) throw this.eventError(o.error);
    return json as OaiResponse;
  }

  /**
   * The one retry loop behind create() and every streamed attempt. `run` makes one request and throws what went wrong;
   * transient failures (429/502/503/504, a dropped connection — see transientFailure) are repeated after a pause:
   * - window mode (the default, 2 min from the first failure, or the provider's own window): exponential backoff, a
   *   server Retry-After honoured up to the window; a wait that would not fit fails now and says when to retry;
   * - quick mode (`maxRetries`): that many retries after 1 s, 2 s, … for background work.
   * The stop button (`external`) interrupts a wait at once.
   */
  private async withRetries<T>(run: () => Promise<T>, external?: AbortSignal): Promise<T> {
    const quick = this.opts.retryBudgetMs === undefined && this.opts.maxRetries !== undefined;
    const budget = this.opts.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    const maxDelay = this.opts.retryMaxDelayMs ?? 5 * 60_000;
    let failingSince: number | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const failure = transientFailure(err);
        if (!failure || external?.aborted) throw err;
        const now = Date.now();
        failingSince ??= now;
        const remaining = budget - (now - failingSince);
        let delay: number | null;
        if (quick) {
          delay = attempt >= this.opts.maxRetries! ? null : failure.retryAfterMs ? Math.min(failure.retryAfterMs, 30_000) : 1000 * 2 ** attempt;
        } else if (failure.limited && attempt >= LIMITED_RETRIES) {
          delay = null;
        } else if (failure.retryAfterMs !== undefined && failure.retryAfterMs > remaining) {
          if (err instanceof ProviderHttpError) err.message += ` (asked to wait ${Math.ceil(failure.retryAfterMs / 1000)} s, which is longer than the retry window)`;
          throw err;
        } else {
          const pause = retryDelayMs(attempt, failure.retryAfterMs !== undefined ? failure.retryAfterMs / 1000 : undefined, maxDelay);
          delay = remaining <= pause ? null : pause;
        }
        if (delay === null) {
          if (attempt > 0 && err instanceof ProviderHttpError) err.message += ` (retried ${attempt}×, then gave up)`;
          throw err;
        }
        this.opts.onRetry?.({ provider: this.name, attempt: attempt + 1, status: failure.status, delayMs: delay, remainingMs: quick ? 0 : remaining });
        await abortableSleep(this.sleep, delay, external);
      }
    }
  }

  private async post(path: string, body: unknown, external?: AbortSignal): Promise<unknown> {
    return this.withRetries(async () => {
      const { signal, cleanup } = linkSignals(external, this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      try {
        const res = await this.fetchAttempt(`${this.opts.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}) },
          body: JSON.stringify(body),
        }, signal);
        if (!res.ok) throw await this.httpError(res);
        return this.checkAnswer(await res.json());
      } finally {
        cleanup();
      }
    }, external);
  }
}
