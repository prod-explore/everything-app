import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import { deviceLabel } from '../report.js';
import { capOutput } from '../shell/output.js';
import { SessionBusyError, type RunOutcome } from '../shell/session.js';
import type { ShellManager } from '../shell/manager.js';
import { conversationIdArg, conversationOf, errMessage, fail, ok, type ToolResult } from './common.js';

/**
 * shell_run / shell_send / shell_read / shell_list / shell_close — persistent shells on the person's own computer.
 * Tone and shape follow the sandbox's run_bash; what differs is said in the descriptions, because a model choosing
 * between the two must know that this one is NOT a sandbox.
 */

const sessionName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'letters, digits, "_" and "-", 1–32 characters')
  .describe('Session name; letters, digits, "_" and "-", up to 32. Default "main".');

const DEFAULT_TIMEOUT_S = 120;

function busyHint(name: string, command: string): string {
  const shown = command.length > 80 ? `${command.slice(0, 80)}…` : command;
  return (
    `Session "${name}" is still running: ${shown}\n` +
    'Collect its output with shell_read, answer a prompt with shell_send, stop it with shell_close (interrupt_only: true), ' +
    'or use another session name.'
  );
}

/** The text a model sees for a finished foreground command. Pure, so it is tested without a shell. */
export function formatRun(o: RunOutcome, name: string, timeoutS: number, exitDescription = 'the shell ended'): { text: string; isError: boolean } {
  const lines = [capOutput(o.output.replace(/\r\n/g, '\n').replace(/\n$/, ''))];
  if (o.timedOut) {
    lines.push(
      o.shellEnded
        ? `[timed out after ${timeoutS}s and did not stop when interrupted, so the shell was killed — its directory and variables are gone; the next command opens a fresh session]`
        : `[timed out after ${timeoutS}s — the command was interrupted; session "${name}" is still open. Run long jobs with background: true and poll with shell_read]`,
    );
  } else if (o.cancelled) {
    lines.push('[cancelled — the command was interrupted]');
  } else if (o.shellEnded) {
    lines.push(`[${exitDescription} — the next command opens a fresh session]`);
  }
  if (o.exitCode !== null && !o.shellEnded) lines.push(`exit code: ${o.exitCode}`);
  if (o.cwd) lines.push(`[cwd: ${o.cwd}]`);
  return {
    text: lines.filter(l => l !== '').join('\n'),
    isError: o.timedOut || o.cancelled || o.shellEnded || (o.exitCode !== null && o.exitCode !== 0),
  };
}

export function registerShellTools(server: McpServer, cfg: ResolvedConfig, shells: ShellManager): void {
  const where = deviceLabel(cfg);
  const kind = cfg.shell.kind === 'powershell' ? 'PowerShell' : 'a POSIX shell';
  const isPs = cfg.shell.kind === 'powershell';

  server.registerTool(
    'shell_run',
    {
      title: 'Run shell command on the device',
      description:
        `Run a command in a persistent shell on ${where} — not a sandbox: real files, real network, real accounts, and anything it changes stays changed. ` +
        `A session is a long-lived ${kind}: the working directory, environment variables and ${isPs ? 'functions' : 'functions and aliases defined in it'} carry over to the next command in the same session ` +
        `(the result ends with [cwd: …]). Use separate named sessions for separate jobs (e.g. "dev", "tests"); the default is "main"; at most 8 are open on the device and an unused one is closed after 30 minutes. ` +
        `stdout and stderr are merged. ${isPs ? 'Write PowerShell, not bash. ' : ''}` +
        `A command is limited to timeout_s (default ${DEFAULT_TIMEOUT_S}, at most 600); on timeout it is interrupted like Ctrl-C and the session survives. ` +
        'Output beyond 30 000 characters is cut in the middle. Full-screen programs (vim, top) do not work. ' +
        'For anything long-running (dev servers, watchers, builds) or anything that asks questions, pass background: true: the call returns at once, ' +
        'shell_read collects the output, shell_send answers a prompt, shell_close stops it. ' +
        'The user decides which commands run without asking; a command may wait for their approval in the app.',
      inputSchema: {
        command: z.string().min(1).describe(`The command to run${isPs ? ' (PowerShell; multi-line allowed)' : ' (any shell syntax, multi-line allowed)'}.`),
        session: sessionName.optional(),
        cwd: z.string().min(1).optional().describe('Working directory for a NEW session. Ignored when the session already exists (cd instead).'),
        timeout_s: z.number().int().min(1).max(600).optional().describe(`Seconds before the command is interrupted. Default ${DEFAULT_TIMEOUT_S}.`),
        background: z.boolean().optional().describe('Start the command and return immediately; collect output with shell_read. Default false.'),
        ...conversationIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ command, session, cwd, timeout_s, background, _conversation_id }, extra): Promise<ToolResult> => {
      const conv = conversationOf(_conversation_id);
      const name = session ?? 'main';
      const timeoutS = timeout_s ?? DEFAULT_TIMEOUT_S;
      let acquired;
      try {
        acquired = await shells.acquire(conv, name, cwd);
      } catch (err) {
        return fail(`shell_run error: ${errMessage(err)}`);
      }
      const { session: s, created } = acquired;
      const note = !created && cwd ? `(session "${name}" already exists, so cwd was ignored; it is in ${s.cwd})\n` : '';
      try {
        if (background) {
          s.startBackground(command);
          return ok(
            `${note}Started in the background in session "${name}". Use shell_read to collect its output, shell_send to answer a prompt, ` +
              'shell_close to stop it.',
          );
        }
        const outcome = await s.run(command, timeoutS * 1000, extra.signal);
        const { text, isError } = formatRun(outcome, name, timeoutS, s.exitDescription);
        const full = note + text;
        return isError ? fail(full) : ok(full, { exitCode: outcome.exitCode, cwd: outcome.cwd });
      } catch (err) {
        if (err instanceof SessionBusyError) return fail(busyHint(name, s.runningCommand ?? command));
        return fail(`shell_run error: ${errMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'shell_send',
    {
      title: 'Send input to a running command',
      description:
        `Write a line of input (followed by a newline) to the command currently running in a session on ${deviceLabel(cfg, false)} — answering a prompt ` +
        '(a confirmation, a password a program asks for, a REPL line). Returns the output that appears within a moment of sending; ' +
        'shell_read fetches more. Only works while a command is running (start it with background: true); otherwise use shell_run.' +
        (isPs ? ' Not available in PowerShell sessions.' : ''),
      inputSchema: {
        session: sessionName,
        input: z.string().describe('The text to send; a newline is added.'),
        ...conversationIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ session, input, _conversation_id }): Promise<ToolResult> => {
      const s = await shells.get(conversationOf(_conversation_id), session);
      if (!s) return fail(`No open session "${session}". Start one with shell_run.`);
      try {
        s.send(input);
      } catch (err) {
        return fail(`shell_send error: ${errMessage(err)}`);
      }
      await s.settle(1_500, 250);
      return ok(formatRead(s.read(), 'Sent.'));
    },
  );

  server.registerTool(
    'shell_read',
    {
      title: 'Read new shell output',
      description:
        `Return the output a session on ${deviceLabel(cfg, false)} produced since the last read — mainly for commands started with background: true — ` +
        'and whether the command is still running or has finished (with its exit code). Waits briefly for output when the command is running and has been quiet.',
      inputSchema: {
        session: sessionName,
        max_chars: z.number().int().min(100).max(30_000).optional().describe('Most characters to return (default 30000); a longer output keeps its start and end.'),
        ...conversationIdArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session, max_chars, _conversation_id }): Promise<ToolResult> => {
      const s = await shells.get(conversationOf(_conversation_id), session);
      if (!s) return fail(`No open session "${session}". It may have ended or been closed after 30 idle minutes; start one with shell_run.`);
      await s.settle(1_000, 150);
      return ok(formatRead(s.read(), '', max_chars));
    },
  );

  server.registerTool(
    'shell_list',
    {
      title: 'List shell sessions',
      description: `List this chat's open shell sessions on ${deviceLabel(cfg, false)}: name, working directory, the command running in it (if any) and how long it has been idle.`,
      inputSchema: { ...conversationIdArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ _conversation_id }): Promise<ToolResult> => {
      const list = await shells.list(conversationOf(_conversation_id));
      if (list.length === 0) return ok('No open shell sessions.', { sessions: [] });
      const text = list
        .map(s => `${s.name}  cwd: ${s.cwd}  ${s.running ? `running: ${s.running.length > 80 ? `${s.running.slice(0, 80)}…` : s.running}` : 'idle'}  (untouched for ${s.idleSeconds}s)`)
        .join('\n');
      return ok(text, { sessions: list });
    },
  );

  server.registerTool(
    'shell_close',
    {
      title: 'Close or interrupt a shell session',
      description:
        `Close a shell session on ${deviceLabel(cfg, false)}, ending the shell and everything it started — including background jobs. ` +
        'With interrupt_only: true the running command is interrupted (like Ctrl-C) and the session stays open.',
      inputSchema: {
        session: sessionName,
        interrupt_only: z.boolean().optional().describe('Only interrupt the running command; keep the session. Default false.'),
        ...conversationIdArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session, interrupt_only, _conversation_id }): Promise<ToolResult> => {
      const conv = conversationOf(_conversation_id);
      if (interrupt_only) {
        const s = await shells.get(conv, session);
        if (!s) return fail(`No open session "${session}".`);
        if (!s.isRunning) return ok(`Nothing is running in session "${session}".`);
        s.interrupt();
        return ok(`Interrupted session "${session}". Use shell_read to see how it ended.`);
      }
      return (await shells.close(conv, session)) ? ok(`Closed session "${session}".`) : ok(`No open session "${session}".`);
    },
  );
}

export function formatRead(r: import('../shell/session.js').ReadOutcome, prefix: string, maxChars?: number): string {
  const body = capOutput(r.output.replace(/\r\n/g, '\n').replace(/\n$/, ''), maxChars);
  const status = r.finished
    ? r.finished.shellEnded
      ? `[the shell ended${r.finished.exitCode !== null ? ` with code ${r.finished.exitCode}` : ''}; the next command opens a fresh session]`
      : `[finished — exit code: ${r.finished.exitCode}${r.finished.cwd ? `, cwd: ${r.finished.cwd}` : ''}]`
    : r.running
      ? '[still running]'
      : '[no command running]';
  return [prefix, body, status].filter(l => l !== '').join('\n');
}
