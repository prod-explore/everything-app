import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ownerIds, ownerOf, ToolContext } from './types.js';

// The subcommands a coding agent needs. `push` is deliberately excluded: pushing needs a credential and a human approval, and git
// credentials never enter the sandbox (they stay in git-proxy).
export const ALLOWED_SUBCOMMANDS = [
  'clone',
  'status',
  'diff',
  'log',
  'add',
  'commit',
  'pull',
  'fetch',
  'checkout',
  'branch',
  'stash',
  'show',
] as const;

type GitSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

export function registerGitOp(server: McpServer, { config, supervisor }: ToolContext): void {
  server.registerTool(
    'git_op',
    {
      title: 'Run git command',
      description: 'Run a whitelisted git command inside the sandboxed container. ' +
        `Allowed subcommands: ${ALLOWED_SUBCOMMANDS.join(', ')}. ` +
        'git push is not available here: the sandbox holds no git credentials, so the user pushes from the Source Control panel. ' +
        'Requires approval before execution.',
      inputSchema: {
        subcommand: z
          .enum(ALLOWED_SUBCOMMANDS)
          .describe('The git subcommand to run.'),
        args: z
          .array(z.string())
          .optional()
          .describe('Additional arguments (e.g. ["-m", "my commit message"]).'),
        ...ownerIds,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ subcommand, args = [], ...ids }: { subcommand: GitSubcommand; args?: string[]; _conversation_id?: string; _project_id?: string }) => {

      const owner = ownerOf(ids);

      // Shell-escape each argument to prevent injection via args array.
      const escapedArgs = [subcommand, ...args]
        .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' ');

      let containerId: string | null = null;
      try {
        const claimed = await supervisor.claim(owner);
        containerId = claimed.containerId;

        const command = `cd ${claimed.workspacePath} && git ${escapedArgs}`;

        const result = await supervisor.exec(containerId, command, config.sandboxTimeoutMs);

        const output = [
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
          `exit code: ${result.exitCode}`,
        ]
          .filter(Boolean)
          .join('\n');

        return result.exitCode === 0 ? ok(output) : fail(output);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`git_op error: ${message}`);
      }
      // The sandbox is not released after the command: the supervisor stops it once it has been idle long enough.
    },
  );
}
