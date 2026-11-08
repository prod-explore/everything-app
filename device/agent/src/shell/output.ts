/**
 * Output bookkeeping for shell sessions.
 *
 * Two layers. `OutputBuffer` holds what a session has produced but nobody has read yet, bounded so a runaway command
 * (`yes`, a verbose build in the background) cannot eat the agent's memory: the first KEEP characters and the last KEEP
 * are retained, the middle is dropped and counted. `capOutput` is the second, smaller cap applied to what one tool call
 * returns (30 000 characters), again head and tail — the start shows what ran, the end shows how it ended.
 */

export const MAX_RESULT_CHARS = 30_000;
const KEEP = 100_000;

export class OutputBuffer {
  private head = '';
  private headFrozen = false;
  private text = '';
  private dropped = 0;

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > KEEP * 2) this.compact();
  }

  private compact(): void {
    if (!this.headFrozen) {
      this.head = this.text.slice(0, KEEP);
      this.text = this.text.slice(KEEP);
      this.headFrozen = true;
    }
    if (this.text.length > KEEP * 2) {
      this.dropped += this.text.length - KEEP;
      this.text = this.text.slice(-KEEP);
    }
  }

  get length(): number {
    return this.head.length + this.text.length;
  }

  isEmpty(): boolean {
    return this.length === 0 && this.dropped === 0;
  }

  /**
   * Finds `pattern` in the part of the stream that is still held in full (the tail, where a command's end marker always
   * is), cuts it out together with everything after it, and returns the match and that remainder.
   */
  cutAt(pattern: RegExp): { match: RegExpExecArray; after: string } | null {
    const match = pattern.exec(this.text);
    if (!match) return null;
    const after = this.text.slice(match.index + match[0].length);
    this.text = this.text.slice(0, match.index);
    return { match, after };
  }

  /** Everything held, as one string (with a marker where the middle was dropped), and empties the buffer. */
  take(): string {
    const marker = this.dropped > 0 ? `\n[… ${this.dropped} characters dropped …]\n` : '';
    const out = this.head + marker + this.text;
    this.head = '';
    this.headFrozen = false;
    this.text = '';
    this.dropped = 0;
    return out;
  }
}

/** Keeps the first `head` and last `tail` characters of an over-long result and says how much was left out. */
export function capOutput(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters omitted …]\n${text.slice(text.length - tail)}`;
}
