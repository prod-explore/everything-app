export interface ToolTextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(text: string, structured?: Record<string, unknown>): ToolTextResult {
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

export function fail(text: string, structured?: Record<string, unknown>): ToolTextResult {
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured, isError: true }
    : { content: [{ type: 'text', text }], isError: true };
}

/** A result that carries a picture next to its text (browser_screenshot). */
export interface ToolImageResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
