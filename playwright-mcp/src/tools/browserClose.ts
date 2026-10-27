import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserSessionPool } from '../sessionPool.js';
import { ok } from './types.js';

export function registerBrowserClose(server: McpServer, pool: BrowserSessionPool): void {
  server.registerTool(
    'browser_close',
    {
      title: 'Close browser session',
      description: 'Close this conversation\'s browser session. The profile is ephemeral, so this also discards ' +
        'its cookies, logins and any allowed downloads. Not required at the end of a task; idle sessions ' +
        'time out on their own, but call this when you know you\'re done to free the slot sooner.',
      inputSchema: {
        _conversation_id: z
          .string()
          .optional()
          .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ _conversation_id }) => {
      const convId = _conversation_id ?? 'default';
      const closed = await pool.close(convId, 'closed by agent');
      return ok(closed ? 'Browser session closed.' : 'No open browser session for this conversation.');
    },
  );
}
