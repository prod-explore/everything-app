import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { drainEvents } from '../browserContext.js';
import { observePage } from '../observe.js';
import { observationResult, UNTRUSTED_CONTENT_NOTICE } from './formatObservation.js';
import { applyCallPolicy, hiddenPolicyArgs } from './policyArgs.js';
import { formatTabs, tabNote } from './tabNote.js';
import { fail, ok } from './types.js';

const ACTIONS = ['list', 'switch', 'close'] as const;

export function registerBrowserTabs(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  server.tool(
    'browser_tabs',
    'List, switch or close the tabs of this conversation\'s browser session. A session can hold several tabs ' +
      '(open one with browser_open and new_tab: true; a link that opens a new window also becomes a tab). ' +
      'Actions: "list" shows every tab with its number, address and title; "switch" (tab = its number) makes that ' +
      'tab the active one and returns its observation — browser_observe and browser_act always work on the active ' +
      'tab, and refs belong to the tab they were read from, so observe again after switching; "close" (tab = its ' +
      'number) closes one tab — the last tab cannot be closed this way, use browser_close. Fails if no session is ' +
      'open yet. ' +
      UNTRUSTED_CONTENT_NOTICE,
    {
      action: z.enum(ACTIONS).describe('"list", "switch" or "close".'),
      tab: z.number().int().positive().optional().describe('The tab number from the list. Required for "switch" and "close".'),
      _conversation_id: z
        .string()
        .optional()
        .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
      ...hiddenPolicyArgs,
    },
    async ({ action, tab, _conversation_id, _policy }) => {
      const convId = _conversation_id ?? 'default';
      const session = pool.get(convId);
      if (!session) return fail('No open browser session for this conversation — call browser_open with a URL first.');
      pool.touch(convId);
      applyCallPolicy(config, session.state, _policy);

      try {
        if (action === 'list') return ok(formatTabs(session), { tabs: session.tabs.all().map(t => ({ id: t.id, url: t.page.url(), active: t.id === session.tabs.active().id })) });

        if (tab === undefined) return fail(`Action "${action}" requires tab (the number from browser_tabs list).`);
        const target = session.tabs.get(tab);
        if (!target) return fail(`There is no tab [${tab}].\n${formatTabs(session)}`);

        if (action === 'close') {
          if (session.tabs.size === 1) return fail('That is the only tab — use browser_close to end the browser session.');
          await target.page.close();
          pool.setCurrentUrl(convId, session.page.url());
          return ok(`Closed tab [${tab}].\n${formatTabs(session)}`);
        }

        // switch
        session.tabs.activate(tab);
        await target.page.bringToFront().catch(() => {});
        pool.setCurrentUrl(convId, target.page.url());
        const obs = await observePage(target.page, config, session.state.policy.js);
        return observationResult(obs, [`(switched to tab [${tab}])`, tabNote(session)], drainEvents(session.state));
      } catch (err: unknown) {
        return fail(`browser_tabs error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
