/**
 * Messages typed while the assistant is still working. They wait here, per conversation, and go out one at a time
 * when the running turn ends — or immediately, when the person asks to interrupt. The server accepts one turn per
 * conversation, so the queue lives in the browser and feeds it in order.
 */
export interface QueuedMessage {
  id: string;
  text: string;
}

export type MessageQueues = Readonly<Record<string, readonly QueuedMessage[]>>;

const EMPTY: readonly QueuedMessage[] = [];

export function queueOf(queues: MessageQueues, conversationId: string | null): readonly QueuedMessage[] {
  return (conversationId && queues[conversationId]) || EMPTY;
}

function withQueue(queues: MessageQueues, conversationId: string, next: readonly QueuedMessage[]): MessageQueues {
  const { [conversationId]: _old, ...rest } = queues;
  return next.length > 0 ? { ...rest, [conversationId]: next } : rest;
}

/** Appends to the end of the line. Blank text is not worth queueing. */
export function enqueue(queues: MessageQueues, conversationId: string, message: QueuedMessage): MessageQueues {
  if (!message.text.trim()) return queues;
  return withQueue(queues, conversationId, [...queueOf(queues, conversationId), message]);
}

/** Changes the text of a waiting message; emptying it removes it. */
export function editQueued(queues: MessageQueues, conversationId: string, id: string, text: string): MessageQueues {
  const current = queueOf(queues, conversationId);
  if (!current.some(m => m.id === id)) return queues;
  return withQueue(queues, conversationId, text.trim() ? current.map(m => (m.id === id ? { ...m, text } : m)) : current.filter(m => m.id !== id));
}

export function removeQueued(queues: MessageQueues, conversationId: string, id: string): MessageQueues {
  return withQueue(queues, conversationId, queueOf(queues, conversationId).filter(m => m.id !== id));
}

/** Moves one message to the front, so it is the next to go out. */
export function promoteQueued(queues: MessageQueues, conversationId: string, id: string): MessageQueues {
  const current = queueOf(queues, conversationId);
  const hit = current.find(m => m.id === id);
  if (!hit) return queues;
  return withQueue(queues, conversationId, [hit, ...current.filter(m => m.id !== id)]);
}

/** Puts a message back at the front, e.g. when the server refused it and it must not lose its turn. */
export function requeueFirst(queues: MessageQueues, conversationId: string, message: QueuedMessage): MessageQueues {
  return withQueue(queues, conversationId, [message, ...queueOf(queues, conversationId).filter(m => m.id !== message.id)]);
}

/** Takes the next message off the line. */
export function dequeue(queues: MessageQueues, conversationId: string): { next: QueuedMessage | null; queues: MessageQueues } {
  const [next, ...rest] = queueOf(queues, conversationId);
  return next ? { next, queues: withQueue(queues, conversationId, rest) } : { next: null, queues };
}
