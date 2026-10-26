import 'dotenv/config';

export interface McpServerConfig {
  /** Short local name, used as a namespace prefix for tool routing (not sent to the model). */
  name: string;
  url: string;
  /** Bearer token, if the server requires auth (most do). */
  apiKey?: string;
}

export interface Config {
  /** Last-resort model id (`@provider/model`) for chats that have none and when no usable free model exists. Usually empty: providers and slots are configured in Settings → Models. */
  model: string;
  /** Tool names that never require interactive approval — everything else does. Default-deny by design (see README). */
  autoApproveTools: string[];
  mcpServers: McpServerConfig[];
}

/**
 * Operator connectors are entirely config-driven — adding one (a notes server,
 * a workflow engine, a calendar MCP, whatever) never needs a code change here,
 * only a new name in MCP_CONNECTORS plus its URL/key pair.
 *
 * MCP_CONNECTORS=sandbox,playwright,notes
 * MCP_SANDBOX_URL=...        MCP_SANDBOX_API_KEY=...
 * MCP_PLAYWRIGHT_URL=...     MCP_PLAYWRIGHT_API_KEY=...
 * MCP_NOTES_URL=...          MCP_NOTES_API_KEY=...
 */
function loadMcpServers(): McpServerConfig[] {
  const names = (process.env['MCP_CONNECTORS'] ?? '')
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);

  const servers: McpServerConfig[] = [];
  for (const name of names) {
    const envPrefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const url = process.env[`MCP_${envPrefix}_URL`];
    if (!url) {
      console.warn(`[config] MCP_CONNECTORS lists '${name}' but MCP_${envPrefix}_URL is unset — skipping it.`);
      continue;
    }
    servers.push({ name, url, apiKey: process.env[`MCP_${envPrefix}_API_KEY`] });
  }
  return servers;
}

/**
 * Default-deny on purpose ("whitelist, never a bare shell"): a tool that is not in this list asks for a manual approval.
 * AUTO_APPROVE_TOOLS replaces the list. Browser: opening a page is approved per DOMAIN in the orchestrator (llm-loop: Allow
 * once / this chat / always), so browser_open needs no second prompt (also with new_tab); browser_tabs only switches
 * between pages already open; browser_act runs unprompted inside the approved domain, except actions that look
 * irreversible (payment, deletion…), which always ask; after a page looked like a prompt injection every effectful call
 * asks again.
 */
export const DEFAULT_AUTO_APPROVE_TOOLS: readonly string[] = [
  'read_log', 'get_path', 'search_notes', 'browser_open', 'browser_observe', 'browser_screenshot', 'browser_act', 'browser_tabs', 'browser_close',
];

function loadAutoApproveTools(): string[] {
  const fromEnv = process.env['AUTO_APPROVE_TOOLS'];
  if (fromEnv) {
    return fromEnv.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [...DEFAULT_AUTO_APPROVE_TOOLS];
}

/**
 * Address the HTTP server binds to. Loopback unless LISTEN_HOST says otherwise, so a quickstart run on a laptop is not
 * reachable from the network with its throw-away password. The Docker image sets LISTEN_HOST=0.0.0.0 (compose publishes
 * the port on 127.0.0.1 only).
 */
export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  return env['LISTEN_HOST']?.trim() || '127.0.0.1';
}

export function loadConfig(): Config {
  const mcpServers = loadMcpServers();

  if (mcpServers.length === 0) {
    console.warn(
      '[config] No MCP connectors configured (MCP_CONNECTORS is empty/unset). ' +
        'The CLI will still work as a plain chat, just without those tools.',
    );
  }

  return {
    model: process.env['DEFAULT_MODEL'] ?? '',
    autoApproveTools: loadAutoApproveTools(),
    mcpServers,
  };
}
