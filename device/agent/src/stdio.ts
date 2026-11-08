import type { Readable, Writable } from 'node:stream';
import { Agent } from './agent.js';
import { encodeAgentMessage, parseTrayMessage, type AgentMessage, type TrayMessage } from './protocol.js';

/**
 * Tray mode: the agent as a child of the tray app, speaking the stdio protocol (docs/devices.md) — one JSON object per
 * line each way. stdout carries protocol lines and NOTHING else (the host redirects console.log away from it); human-readable
 * diagnostics go to stderr or out as `log` messages.
 */

export interface StdioHost {
  input: Readable;
  output: Writable;
  /** Called when the tray asked to shut down or closed our stdin. */
  onExit: (code: number) => void;
  /** Test seam: builds the agent from the `start` message. */
  makeAgent?: (start: Extract<TrayMessage, { type: 'start' }>, emit: (m: AgentMessage) => void) => Agent;
}

/** Splits a byte stream into lines (handles chunks that end mid-line and CRLF). */
export function lineReader(input: Readable, onLine: (line: string) => void, onEnd: () => void): void {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  input.on('end', () => {
    if (buffer.trim()) onLine(buffer.trim());
    onEnd();
  });
}

export function runStdio(host: StdioHost): { agent: () => Agent | null } {
  let agent: Agent | null = null;
  const emit = (m: AgentMessage): void => {
    host.output.write(encodeAgentMessage(m));
  };
  const log = (level: 'info' | 'warn' | 'error', message: string): void => emit({ type: 'log', level, message });

  // Messages are handled strictly in order (a `pause` followed by `resume` must not overlap).
  let queue: Promise<void> = Promise.resolve();
  const handle = async (msg: TrayMessage): Promise<void> => {
    if (msg.type === 'start') {
      if (agent) return log('warn', 'ignoring a second start message');
      agent =
        host.makeAgent?.(msg, emit) ??
        new Agent({ configPath: msg.configPath, dataDir: msg.dataDir, token: msg.token, persistToken: false, emit });
      await agent.start();
      return;
    }
    if (!agent) return log('error', `received ${msg.type} before start`);
    switch (msg.type) {
      case 'config-changed':
        return agent.configChanged();
      case 'pair':
        void agent.pair(); // runs for minutes; later messages (pause, shutdown) must be able to cancel it
        return;
      case 'pause':
        return agent.pause();
      case 'resume':
        return agent.resume();
      case 'unpair':
        return agent.unpair();
      case 'shutdown':
        await agent.shutdown();
        host.onExit(0);
    }
  };

  lineReader(
    host.input,
    line => {
      const msg = parseTrayMessage(line);
      if (msg instanceof Error) return log('warn', `bad message from the tray: ${msg.message}`);
      queue = queue.then(() => handle(msg)).catch(err => log('error', `${msg.type} failed: ${(err as Error).message}`));
    },
    () => {
      // The tray went away: nothing may keep running on this machine unsupervised.
      queue = queue.then(async () => {
        await agent?.shutdown();
        host.onExit(0);
      });
    },
  );
  return { agent: () => agent };
}
