import type Database from 'better-sqlite3';
import type * as Llm from './llm-types.js';

/**
 * Messages typed while a turn is running. They are stored (so a reload, a second device or a restart keeps them),
 * edited in place, and sent one at a time by the server when the conversation is free.
 */
export const MAX_QUEUED_MESSAGES = 20;

export type QueueContent = Llm.MessageParam['content'];

export interface QueuedMessage {
  id: number;
  conversationId: string;
  content: QueueContent;
}

/** What the browser sees: the text, and how many images ride along (the images themselves stay on the server). */
export interface PublicQueuedMessage {
  id: number;
  text: string;
  images: number;
}

export function migrateMessageQueue(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content         TEXT NOT NULL,
      position        REAL NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_queued_messages_conv ON queued_messages(conversation_id, position);
  `);
}

interface Row { id: number; conversation_id: string; content: string }

const toMessage = (r: Row): QueuedMessage => ({ id: r.id, conversationId: r.conversation_id, content: JSON.parse(r.content) as QueueContent });

export function textOf(content: QueueContent): string {
  if (typeof content === 'string') return content;
  return content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
}

export function imageCount(content: QueueContent): number {
  return typeof content === 'string' ? 0 : content.filter(b => b.type === 'image').length;
}

export function toPublic(m: QueuedMessage): PublicQueuedMessage {
  return { id: m.id, text: textOf(m.content), images: imageCount(m.content) };
}

export function listQueue(db: Database.Database, conversationId: string): QueuedMessage[] {
  const rows = db.prepare(`SELECT id, conversation_id, content FROM queued_messages WHERE conversation_id = ? ORDER BY position, id`).all(conversationId) as Row[];
  return rows.map(toMessage);
}

/** Appends to the end of the line. Returns null when the line is full. */
export function enqueueMessage(db: Database.Database, conversationId: string, content: QueueContent): QueuedMessage | null {
  const { n, last } = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM queued_messages WHERE conversation_id = ?`).get(conversationId) as { n: number; last: number };
  if (n >= MAX_QUEUED_MESSAGES) return null;
  const info = db.prepare(`INSERT INTO queued_messages (conversation_id, content, position) VALUES (?, ?, ?)`).run(conversationId, JSON.stringify(content), last + 1);
  return { id: Number(info.lastInsertRowid), conversationId, content };
}

/**
 * Replaces the text of a waiting message and keeps its images. Empty text with no images removes it (returns 'removed').
 */
export function editQueuedMessage(db: Database.Database, conversationId: string, id: number, text: string): 'edited' | 'removed' | 'missing' {
  const row = db.prepare(`SELECT id, conversation_id, content FROM queued_messages WHERE id = ? AND conversation_id = ?`).get(id, conversationId) as Row | undefined;
  if (!row) return 'missing';
  const current = toMessage(row).content;
  const images = typeof current === 'string' ? [] : current.filter(b => b.type === 'image');
  if (!text.trim() && images.length === 0) {
    removeQueuedMessage(db, conversationId, id);
    return 'removed';
  }
  const next: QueueContent = images.length === 0 ? text : [...images, ...(text.trim() ? [{ type: 'text' as const, text }] : [])];
  db.prepare(`UPDATE queued_messages SET content = ? WHERE id = ?`).run(JSON.stringify(next), id);
  return 'edited';
}

export function removeQueuedMessage(db: Database.Database, conversationId: string, id: number): boolean {
  return db.prepare(`DELETE FROM queued_messages WHERE id = ? AND conversation_id = ?`).run(id, conversationId).changes > 0;
}

/** Makes one message the next to go out. */
export function promoteQueuedMessage(db: Database.Database, conversationId: string, id: number): boolean {
  const first = db.prepare(`SELECT COALESCE(MIN(position), 1) AS p FROM queued_messages WHERE conversation_id = ?`).get(conversationId) as { p: number };
  return db.prepare(`UPDATE queued_messages SET position = ? WHERE id = ? AND conversation_id = ?`).run(first.p - 1, id, conversationId).changes > 0;
}

/** Takes the next message off the line (removing it from the table). */
export function takeNextQueued(db: Database.Database, conversationId: string): QueuedMessage | null {
  const next = listQueue(db, conversationId)[0];
  if (!next) return null;
  removeQueuedMessage(db, conversationId, next.id);
  return next;
}
