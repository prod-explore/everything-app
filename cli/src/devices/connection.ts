import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { TOOL_CALL_TIMEOUT_MS, toCallResult, type McpConnectionLike, type McpToolCallResult, type McpToolInfo } from '../mcp-client.js';
import { connectionNameOf, parseDeviceReport, REPORT_URI, type DevicePolicy, type DeviceReport } from './types.js';

/**
 * A device that is online, as the rest of the app sees it: an ordinary MCP connection named `device-<slug>` (ADR 0017).
 * The registry, the approval gate, the audit log and subagents need nothing special — a device tool is
 * `device-pc__shell_run` the way a sandbox tool is `sandbox__run_bash`.
 *
 * Three things are device-specific:
 *  - tools whose name starts with `_` are internal: `callInternal` reaches them, `listTools` never shows them to a model;
 *  - `autoApproves` answers the registry's "does this call need a person?" from the device's live permission levels
 *    (ADR 0019), read from the store on every call so a change in Settings applies to the next call;
 *  - a call that fails because the device went away is an error RESULT, not an exception: the call may have run, and the
 *    model must be told that rather than the turn crashing or the call being retried (ADR 0017).
 */

/** Tools that only look: no approval once the capability is on. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'shell_read', 'shell_list', 'shell_close',
  'fs_list', 'fs_read', 'fs_search',
  'browser_observe', 'browser_screenshot', 'browser_tabs', 'browser_close',
]);
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['fs_write', 'fs_edit', 'fs_mkdir']);

/**
 * ADR 0019's table as a function. `shell_run` / `shell_send` go to the gate's command policy, `browser_open` to the
 * per-domain web gate (the loop skips the tool-level approval for it when a domain gate is active, and asks otherwise).
 * A tool this table does not know asks: a new capability does not start out unattended.
 */
export function deviceAutoApproves(realName: string, policy: DevicePolicy): boolean {
  if (READ_TOOLS.has(realName)) return true;
  if (FILE_WRITE_TOOLS.has(realName)) return policy.filesWrite === 'auto';
  if (realName === 'browser_act') return policy.browserAct === 'auto';
  return false;
}

export interface DeviceConnectionOptions {
  deviceId: string;
  slug: string;
  client: Client;
  /** Current permission levels of the device (read live). */
  policy: () => DevicePolicy;
}

export class DeviceConnection implements McpConnectionLike {
  readonly trusted = true;
  readonly deviceId: string;
  readonly slug: string;
  private readonly client: Client;
  private readonly policy: () => DevicePolicy;
  private up = true;

  constructor(opts: DeviceConnectionOptions) {
    this.deviceId = opts.deviceId;
    this.slug = opts.slug;
    this.client = opts.client;
    this.policy = opts.policy;
  }

  get name(): string {
    return connectionNameOf(this.slug);
  }

  get connected(): boolean {
    return this.up;
  }

  get serverName(): string | undefined {
    return this.client.getServerVersion()?.name;
  }

  /** Called by the hub when the socket is gone. */
  markDown(): void {
    this.up = false;
  }

  autoApproves(realName: string): boolean {
    return deviceAutoApproves(realName, this.policy());
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
      for (const t of page.tools) {
        if (t.name.startsWith('_')) continue; // internal: the server calls these itself (callInternal)
        out.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (name.startsWith('_')) return { text: `${name} is internal to the server and cannot be called by a model.`, isError: true };
    try {
      return toCallResult(await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutFor(name, args) }));
    } catch (err) {
      return { text: this.failure(name, err), isError: true };
    }
  }

  /**
   * Calls an internal (`_`) tool and returns the object it answers with: the result's `structuredContent`, else the JSON
   * in its first text block. Throws on a tool error or a missing device — the caller (device_transfer) reports it.
   */
  async callInternal(name: string, args: Record<string, unknown>, timeoutMs = TOOL_CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (err) {
      throw new Error(this.failure(name, err));
    }
    const text = ((result.content ?? []) as Array<{ type: string; text?: string }>).find(b => b.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(text || `${name} failed`);
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === 'object') return structured as Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* falls through */ }
    throw new Error(`${name} returned something that is not an object`);
  }

  /** `evvapp://device/info`; null when the device does not answer or describes itself in a way we do not understand. */
  async readReport(): Promise<DeviceReport | null> {
    try {
      const res = await this.client.readResource({ uri: REPORT_URI }, { timeout: 15_000 });
      const first = res.contents[0] as { text?: unknown } | undefined;
      return typeof first?.text === 'string' ? parseDeviceReport(JSON.parse(first.text)) : null;
    } catch {
      return null;
    }
  }

  private failure(tool: string, err: unknown): string {
    const why = err instanceof Error ? err.message : String(err);
    if (!this.up || /connection closed|not open|not connected/i.test(why)) {
      return `The device went offline during ${tool}. It may or may not have run — check before repeating it.`;
    }
    return `${tool} failed on the device: ${why.slice(0, 300)}`;
  }
}

/** A shell command may run up to 600 s (`timeout_s`), longer than the usual cap on a tool call: wait for it, plus slack. */
function timeoutFor(tool: string, args: Record<string, unknown>): number {
  if (tool !== 'shell_run') return TOOL_CALL_TIMEOUT_MS;
  const requested = typeof args['timeout_s'] === 'number' && Number.isFinite(args['timeout_s']) ? Math.min(600, Math.max(1, args['timeout_s'])) : 120;
  return Math.max(TOOL_CALL_TIMEOUT_MS, requested * 1000 + 30_000);
}
