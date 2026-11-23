/**
 * What the running turn of a conversation has produced so far, in the shape the chat view renders it. The SSE stream only
 * carries deltas, so a client that connects while a turn runs (a reload, a second tab, a stream that dropped and came back)
 * is first sent this snapshot and then the live events that follow it.
 */

export type LivePartSnapshot =
  | { type: 'text'; text: string; block?: number; streaming?: boolean }
  | { type: 'reasoning'; text: string; startedAt?: number; endedAt?: number }
  | { type: 'tool'; call: { label: string; toolName?: string; result?: { truncatedOutput: string; isError: boolean; wasTruncated: boolean } } };

export interface LiveTurnSnapshot {
  turnId: number;
  /** The user message the turn answers; clients that do not have it yet fetch the messages. */
  userMessageId: number;
  /** The turn continues a reply that was cut short instead of starting a new one. */
  continuing: boolean;
  parts: LivePartSnapshot[];
  /** Server-side clocks, so a client's own clock does not matter: how long the turn has run and how long it has been silent. */
  elapsedMs: number;
  idleMs: number;
  /** The server's time when the snapshot was taken: the `startedAt` / `endedAt` of reasoning parts are on that clock. */
  at: number;
}

export class LiveTurn {
  private parts: LivePartSnapshot[] = [];
  private readonly startedAt: number;
  private lastEventAt: number;

  constructor(
    readonly turnId: number,
    readonly userMessageId: number,
    readonly continuing: boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = this.lastEventAt = now();
  }

  private touch(): void { this.lastEventAt = this.now(); }

  /** Closes the reasoning part in progress (the next thing that arrives means the model has stopped thinking). */
  private endReasoning(): void {
    const last = this.parts[this.parts.length - 1];
    if (last?.type === 'reasoning' && last.endedAt === undefined) last.endedAt = this.now();
  }

  /** The request that was producing reasoning is being made again: what comes next is a new reasoning part. */
  restart(): void {
    this.touch();
    this.endReasoning();
  }

  textDelta(block: number, text: string): void {
    this.touch();
    this.endReasoning();
    const last = this.parts[this.parts.length - 1];
    if (last?.type === 'text' && last.streaming && last.block === block) last.text += text;
    else this.parts.push({ type: 'text', text, block, streaming: true });
  }

  thinkingDelta(text: string): void {
    this.touch();
    const last = this.parts[this.parts.length - 1];
    if (last?.type === 'reasoning' && last.endedAt === undefined) last.text += text;
    else this.parts.push({ type: 'reasoning', text, startedAt: this.now() });
  }

  /** The complete block replaces the oldest partial one; with none it is appended. */
  text(text: string): void {
    this.touch();
    this.endReasoning();
    const idx = this.parts.findIndex(p => p.type === 'text' && p.streaming);
    if (idx === -1) this.parts.push({ type: 'text', text });
    else this.parts[idx] = { type: 'text', text };
  }

  toolUse(label: string): void {
    this.touch();
    this.endReasoning();
    this.parts.push({ type: 'tool', call: { label } });
  }

  toolResult(toolName: string, truncatedOutput: string, isError: boolean, wasTruncated: boolean): void {
    this.touch();
    const part = this.parts.find((p): p is Extract<LivePartSnapshot, { type: 'tool' }> => p.type === 'tool' && !p.call.result);
    if (part) part.call = { ...part.call, toolName, result: { truncatedOutput, isError, wasTruncated } };
  }

  snapshot(): LiveTurnSnapshot {
    const now = this.now();
    return {
      turnId: this.turnId,
      userMessageId: this.userMessageId,
      continuing: this.continuing,
      parts: this.parts.map(p => (p.type === 'tool' ? { ...p, call: { ...p.call } } : { ...p })),
      elapsedMs: now - this.startedAt,
      idleMs: now - this.lastEventAt,
      at: now,
    };
  }
}
