import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedConfig } from './config.js';
import { PathGuard } from './fs/guard.js';
import { buildReport, DEVICE_INFO_URI, deviceLabel, type DeviceReport } from './report.js';
import { ShellManager } from './shell/manager.js';
import { createDeviceBrowser, type DeviceBrowser } from './tools/browser.js';
import { summarizeCall } from './tools/common.js';
import { registerFileTools } from './tools/files.js';
import { registerShellTools } from './tools/shell.js';
import { AGENT_VERSION } from './version.js';

/**
 * Everything the device exposes for one loaded config: the shell sessions, the browser pool and the path guard. It outlives
 * individual connections (a dropped WebSocket does not kill a running build), and is replaced when the config changes or
 * the device is paused. `createServer()` makes the per-connection MCP server on top of it.
 */
export class DeviceRuntime {
  readonly report: DeviceReport;
  readonly shells: ShellManager | null;
  readonly browser: DeviceBrowser | null;
  private readonly guard: PathGuard;

  constructor(
    readonly cfg: ResolvedConfig,
    private readonly onActivity: (tool: string, summary: string) => void,
  ) {
    this.report = buildReport(cfg);
    this.shells = cfg.shell.enabled
      ? new ShellManager({ spec: { path: cfg.shell.path, kind: cfg.shell.kind, platform: cfg.platform }, defaultCwd: cfg.shell.cwd })
      : null;
    this.browser = cfg.browser.enabled ? createDeviceBrowser(cfg.browser, cfg.platform) : null;
    this.guard = new PathGuard(cfg.files.roots);
  }

  /** A fresh MCP server (one per connection) exposing exactly the capabilities that are on. */
  createServer(): McpServer {
    const server = new McpServer(
      { name: 'evvapp-device', version: AGENT_VERSION },
      {
        instructions:
          `These tools run on ${deviceLabel(this.cfg)} — the user's real machine, not a sandbox. ` +
          'Files, processes, network and logged-in accounts here are the user\'s own; changes are real and not undone by closing the chat. ' +
          'Prefer read-only steps first, say what you are about to change, and never act beyond what the user asked.',
      },
    );
    server.registerResource(
      'device-info',
      DEVICE_INFO_URI,
      { title: 'Device information', description: 'Name, OS and enabled capabilities of this device.', mimeType: 'application/json' },
      async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this.report, null, 2) }] }),
    );

    let toolCount = 0;
    const tools = this.withActivity(server, () => toolCount++);
    if (this.shells) registerShellTools(tools, this.cfg, this.shells);
    if (this.cfg.files.enabled) registerFileTools(tools, this.cfg, this.guard);
    this.browser?.register(tools);
    if (toolCount === 0) {
      // A device with every capability off still answers tools/list (with nothing) instead of "method not found".
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    }
    return server;
  }

  /**
   * Every tool registered through the returned handle reports its calls (name + a one-line summary) to the tray before
   * running — one place instead of a line in each of ~20 handlers, including the six that come from playwright-mcp.
   */
  private withActivity(server: McpServer, onRegister: () => void): McpServer {
    const report = this.onActivity;
    return new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === 'registerTool') {
          onRegister();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (name: string, config: unknown, handler: (...a: any[]) => unknown) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (target.registerTool as any).call(target, name, config, (...a: unknown[]) => {
              try {
                report(name, summarizeCall(name, a.length > 1 ? a[0] : {}));
              } catch {
                /* reporting must never break a tool call */
              }
              return handler(...a);
            });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** Ends all shells and closes the browser (pause, unpair, shutdown, config change). */
  async dispose(reason: string): Promise<void> {
    await Promise.all([this.shells?.dispose(), this.browser?.closeAll(reason)]);
  }

  /** Synchronous kill for `process.on('exit')`. */
  killNow(): void {
    this.shells?.killAllNow();
  }
}
