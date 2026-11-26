/** Characters of tool output the model gets back (about 6k tokens — fits default web_fetch 20k markdown + envelope without middle truncation) when TOOL_OUTPUT_MAX_CHARS is not set. */
export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 24_000;

/** Effective tool output cap from TOOL_OUTPUT_MAX_CHARS, falling back to DEFAULT_TOOL_OUTPUT_MAX_CHARS. */
export function defaultToolOutputMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['TOOL_OUTPUT_MAX_CHARS']);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_TOOL_OUTPUT_MAX_CHARS;
}

export interface TruncationResult {
  truncated: string;
  wasTruncated: boolean;
}

/**
 * Truncates tool output for the model context. Keeps the first and last
 * portions so the model sees both the beginning (command, headers) and the
 * end (result, summary line) of long outputs. Only this truncated text is
 * kept: it is what the model sees, what the database stores and what the UI shows.
 */
export function truncateToolOutput(
  text: string,
  maxLength: number = defaultToolOutputMaxChars(),
): TruncationResult {
  if (text.length <= maxLength) {
    return { truncated: text, wasTruncated: false };
  }
  const keepEach = Math.floor((maxLength - 120) / 2);
  const head = text.slice(0, keepEach);
  const tail = text.slice(-keepEach);
  const removed = text.length - keepEach * 2;
  return {
    truncated: `${head}\n\n[…${removed.toLocaleString('en-US')} characters truncated from the middle…]\n\n${tail}`,
    wasTruncated: true,
  };
}
