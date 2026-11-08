import { z } from 'zod';

/** Shared bits of the tool definitions. */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const ok = (text: string, structured?: Record<string, unknown>): ToolResult =>
  structured ? { content: [{ type: 'text', text }], structuredContent: structured } : { content: [{ type: 'text', text }] };

export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Injected by the orchestrator into every shell_* and browser_* call so each chat has its own sessions on the device;
 * never offered to the model (the server strips it from the schema it shows).
 */
export const conversationIdArg = {
  _conversation_id: z.string().optional().describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
};

export const conversationOf = (id: string | undefined): string => id || 'default';

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the tray shows next to a tool call: the first argument that says what the call is about. */
export function summarizeCall(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const pick = (k: string): string | null => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : null);
  let text: string | null;
  switch (tool) {
    case 'browser_act':
      text = [pick('action'), pick('ref') ? `[${String(a['ref'])}]` : null, pick('value')].filter(Boolean).join(' ') || null;
      break;
    case 'shell_send':
      text = pick('input');
      break;
    default:
      text = pick('command') ?? pick('url') ?? pick('path') ?? pick('session');
  }
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}
