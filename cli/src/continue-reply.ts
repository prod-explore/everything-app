import type * as Llm from './llm-types.js';

/** What the model is told when a reply that was cut short is to be carried on (it is never stored as a message). */
export const CONTINUE_PROMPT =
  'Your previous reply was cut off. Continue it from exactly where it stopped: do not repeat anything you already wrote, and do not add an introduction or a recap.';

type Blocks = Llm.ContentBlockParam[];
const blocksOf = (content: unknown): Blocks =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Blocks) : [];

/**
 * A reply that was cut short plus what the model wrote when asked to carry on, as one message: the reasoning of both side by
 * side first, then the text — the last text block of the first part and the first of the second run together, as the reply
 * is one stream of words — then whatever else (tool calls) the continuation made.
 */
export function joinReply(before: unknown, after: unknown): Blocks {
  const a = blocksOf(before);
  const b = blocksOf(after);
  const thoughts = [...a, ...b].filter((x): x is Llm.ThinkingBlock => x.type === 'thinking').map(x => x.thinking).join('\n\n');
  const rest = [...a.filter(x => x.type !== 'thinking')];
  const next = b.filter(x => x.type !== 'thinking');
  const last = rest[rest.length - 1];
  const first = next[0];
  if (last?.type === 'text' && first?.type === 'text') {
    rest[rest.length - 1] = { type: 'text', text: last.text + first.text };
    next.shift();
  }
  return [...(thoughts ? [{ type: 'thinking' as const, thinking: thoughts }] : []), ...rest, ...next];
}
