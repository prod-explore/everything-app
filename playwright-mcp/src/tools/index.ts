import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { registerBrowserOpen } from './browserOpen.js';
import { registerBrowserObserve } from './browserObserve.js';
import { registerBrowserAct } from './browserAct.js';
import { registerBrowserClose } from './browserClose.js';
import { registerBrowserTabs } from './browserTabs.js';
import { registerBrowserScreenshot } from './browserScreenshot.js';

export function registerAllTools(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  // Multi-step, session-based — for tasks that need to click/type/navigate.
  registerBrowserOpen(server, config, pool);
  registerBrowserObserve(server, config, pool);
  registerBrowserAct(server, config, pool);
  registerBrowserTabs(server, config, pool);
  registerBrowserScreenshot(server, config, pool);
  registerBrowserClose(server, pool);
}
