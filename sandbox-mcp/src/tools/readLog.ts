import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, fail, ownerIds, ownerOf, ToolContext } from './types.js';

export function registerReadLog(server: McpServer, { supervisor }: ToolContext): void {
  server.registerTool(
    'read_log',
    {
      title: 'Read action log',
      description: 'Read the append-only action log from the sandbox. ' +
        'Every command executed via run_bash or git_op is recorded here with a timestamp. ' +
        'Use this to audit what the agent has done in the current session. ' +
        'This tool is read-only and does not require approval.',
      inputSchema: {
        lines: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Number of most recent log lines to return. Defaults to 50, max 500.'),
        ...ownerIds,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ lines = 50, ...ids }) => {
      try {
        const claimed = await supervisor.claim(ownerOf(ids));

        const result = await supervisor.exec(
          claimed.containerId,
          `tail -n ${lines} /workspace/.ea-checkpoints/actions.log 2>/dev/null || true`,
          5_000,
        );

        const content = result.stdout.trim();
        return ok(content || '(action log is empty)');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`read_log error: ${message}`);
      }
    },
  );
}
