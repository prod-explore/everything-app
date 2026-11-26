import type * as Llm from './llm-types.js';
import type Database from 'better-sqlite3';
import type { LlmClient } from './llm-loop.js';
import { resolveSlot } from './slots.js';
import type { ProviderRouter } from './providers/router.js';
import { isLocalModel, type ProviderId } from './providers/registry.js';

/**
 * Housekeeping LLM calls (chat titles, the daily digest) never touch the chat model: they run on the `helper` slot
 * (automatically a `free`-tagged model unless the user picked one) and, if there is no usable model, quietly don't
 * run — callers keep their plain fallback.
 *
 * Housekeeping is the first thing to drop when its model is down (a local model that is switched off is the usual case): a
 * call gets two quick retries, not the provider's retry window, and one failure parks the model for a few minutes so the
 * next chats don't each wait for it again.
 */
export interface BackgroundModel {
  model: string;
  provider: ProviderId;
  client: LlmClient;
  contextLength?: number;
}

/**
 * `localOnly` is for work on the content of a ghost chat: only a local model may be the helper (the explicit slot if it
 * is local, else the first free local one). When none is, the caller falls back to the chat's own model or skips the job.
 */
/** How long a helper model that just failed is left alone. */
export const HELPER_COOLDOWN_MS = 5 * 60_000;
const parkedUntil = new Map<string, number>();

/** Remember that housekeeping on `model` just failed; it is skipped (callers use their plain fallback) until the cooldown ends. */
export function noteHelperFailure(model: string, now: number = Date.now()): void {
  parkedUntil.set(model, now + HELPER_COOLDOWN_MS);
}

export function helperParked(model: string, now: number = Date.now()): boolean {
  const until = parkedUntil.get(model);
  if (until === undefined) return false;
  if (until > now) return true;
  parkedUntil.delete(model);
  return false;
}

export function backgroundModel(db: Database.Database, router: ProviderRouter, opts: { localOnly?: boolean } = {}): BackgroundModel | null {
  const candidates = opts.localOnly ? router.chatCandidates().filter(isLocalModel) : router.chatCandidates();
  const localOk = (id: string) => !opts.localOnly || candidates.some(c => c.id === id);
  const model = resolveSlot(db, 'helper', candidates, id => localOk(id) && router.isAvailable(id));
  if (!model || helperParked(model)) return null;
  const { provider, info, client } = router.clientFor(model, { quickRetries: true });
  return { model, provider, client: client as LlmClient, ...(info.contextLength ? { contextLength: info.contextLength } : {}) };
}

const textOf = (m: Llm.Message): string =>
  m.content.filter((b): b is Llm.TextBlock => b.type === 'text').map(b => b.text).join(' ').trim();

/**
 * A title made from the first message alone, for when no helper model answers: its first 8 words (at most 60 characters),
 * without markdown marks or trailing punctuation.
 */
export function fallbackTitle(userText: string): string {
  const words = userText.replace(/[`*_#>]+/g, ' ').split(/\s+/).filter(Boolean);
  let title = '';
  for (const w of words.slice(0, 8)) {
    const next = title ? `${title} ${w}` : w;
    if (next.length > 60) break;
    title = next;
  }
  title = title.replace(/[\s.,;:!?…-]+$/, '');
  return title || userText.trim().slice(0, 60) || 'New conversation';
}

/**
 * "Fix the login redirect bug" → a ≤6-word title; null when the model gave nothing usable or could not be reached (in
 * which case the model is left alone for a while, see noteHelperFailure).
 */
export async function generateTitle(
  bg: BackgroundModel,
  userText: string,
  assistantText: string,
  onUsage?: (u: Llm.Usage) => void,
): Promise<string | null> {
  let res: Llm.Message;
  try {
    res = await bg.client.messages.create({
      model: bg.model,
      max_tokens: 40,
      system: 'Write a title of at most 6 words for this chat. Reply with the title only — no quotes, no trailing punctuation.',
      messages: [{ role: 'user', content: `User: ${userText.slice(0, 600)}\n\nAssistant: ${assistantText.slice(0, 600)}` }],
    });
  } catch {
    noteHelperFailure(bg.model);
    return null;
  }
  onUsage?.(res.usage);
  const t = textOf(res).split('\n')[0]!.replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, '').slice(0, 60);
  return t.length >= 2 ? t : null;
}
