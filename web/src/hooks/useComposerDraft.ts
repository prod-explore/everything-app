import { useEffect, useRef } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';

const KEY_PREFIX = 'ea.draft.';
const SAVE_AFTER_MS = 250;

/** The unsent text of a chat, or '' (also when storage is not available: private mode, a full disk, a blocked profile). */
export function loadDraft(conversationId: string): string {
  try { return localStorage.getItem(KEY_PREFIX + conversationId) ?? ''; } catch { return ''; }
}

/** Keeps `text` as the chat's draft; an empty text removes it (a sent message leaves no draft behind). */
export function saveDraft(conversationId: string, text: string): void {
  try {
    if (text) localStorage.setItem(KEY_PREFIX + conversationId, text);
    else localStorage.removeItem(KEY_PREFIX + conversationId);
  } catch { /* the draft is a convenience; losing it must never break typing */ }
}

/**
 * One draft per chat: what is typed is kept (a moment after the last keystroke, and when the chat is left) and comes back
 * when the chat is opened again, even after a reload. Sending empties the box, which removes the draft. Mount it where the
 * composer is, and key that by chat so each chat has its own box.
 */
export function useComposerDraft(conversationId: string): void {
  const aui = useAui();
  const text = useAuiState(s => s.composer.text);
  const latest = useRef(text);
  useEffect(() => { latest.current = text; }, [text]);
  const restored = useRef(false);

  useEffect(() => {
    restored.current = false;
    const saved = loadDraft(conversationId);
    if (saved && !aui.thread.composer().getState().text) aui.thread.composer().setText(saved);
    restored.current = true;
    return () => {
      // Leaving the chat: what is in the box now is its draft.
      if (restored.current) saveDraft(conversationId, latest.current);
    };
  }, [conversationId, aui]);

  useEffect(() => {
    if (!restored.current) return;
    const id = setTimeout(() => saveDraft(conversationId, text), SAVE_AFTER_MS);
    return () => clearTimeout(id);
  }, [conversationId, text]);
}
