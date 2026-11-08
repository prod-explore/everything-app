/**
 * playwright-mcp as a library: the six browser tools and the pieces a host needs to give them its own browser launcher.
 *
 * The first host besides this server is the device agent (`device/agent`), which drives the person's own Brave/Chrome/
 * Edge with a persistent profile instead of the hardened ephemeral Chromium (ADR 0020). Everything that makes the tools
 * safe stays here and is shared, not copied: the domain gate (policy.ts + the request route), injection handling and
 * page-text wrapping (observe.ts / injection.ts), the download/file-chooser/dialog handlers and the hidden `_policy` /
 * `_allow_downloads` arguments. What a host replaces is only HOW a context is created (a `ContextLauncher`).
 *
 * Importing this file starts nothing and reads no environment: `config.ts` (dotenv, MCP_API_KEY) is only used for its types.
 */
import type { PlaywrightConfig } from './config.js';

export { registerAllTools as registerBrowserTools } from './tools/index.js';
export { BrowserSessionPool, SessionLimitError } from './sessionPool.js';
export type { ContextLauncher, SessionHandle, SessionPoolOptions } from './sessionPool.js';
export { attachPageHandlers, installPolicyRoutes, newSessionState } from './browserContext.js';
export type { SessionState } from './browserContext.js';
export { jsContextOptions } from './policy.js';
export { UrlGuard } from './urlSafety.js';
export type { PlaywrightConfig } from './config.js';

/**
 * A PlaywrightConfig for a host that has no env file: the server-only fields (port, API key) are inert here and the
 * limits are the server's defaults, except `maxSessions` (the host's call: the device runs one browser) and the idle
 * watchdog, which checks every minute instead of every two.
 */
export function embeddedConfig(overrides: Partial<PlaywrightConfig> = {}): PlaywrightConfig {
  return {
    mcpPort: 0,
    apiKey: '',
    navTimeoutMs: 30_000,
    maxSessions: 1,
    maxTabs: 6,
    sessionIdleTimeoutMs: 30 * 60_000,
    watchdogIntervalMs: 60_000,
    allowPrivateHosts: [],
    observationMaxTextChars: 12_000,
    observationLabelMaxChars: 100,
    observationMaxElements: 300,
    domainAllow: [],
    domainDeny: [],
    jsPolicy: 'allowed',
    ...overrides,
  };
}
