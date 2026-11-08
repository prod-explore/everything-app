import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { DeviceConnection, type ConnectionState } from './connection.js';
import { ConfigError, loadConfig, resolveConfig, updateConfigFile, type ResolvedConfig } from './config.js';
import { hostEnv } from './detect.js';
import { pairDevice, PairingError } from './pairing.js';
import type { AgentMessage, AgentState, LogLevel } from './protocol.js';
import { DeviceRuntime } from './runtime.js';
import { AGENT_VERSION } from './version.js';

/**
 * The agent proper, shared by the tray (stdio) and headless modes: owns the config, the token, the pairing flow, the
 * connection and the runtime (shells, browser). Everything it has to say goes out through `emit` as protocol messages;
 * what the process prints or writes to stdout is the host's business (main.ts), never the agent's.
 */

export interface AgentOptions {
  configPath: string;
  dataDir: string;
  /** The device token, if the host has one (the tray passes it on stdin, headless reads the token file). */
  token: string | null;
  /** Headless: keep the token in `<dataDir>/token` (0600). The tray stores it in the OS credential store instead. */
  persistToken: boolean;
  emit: (message: AgentMessage) => void;
  /** Overrides for tests. */
  connectionBackoff?: ConstructorParameters<typeof DeviceConnection>[0]['backoff'];
}

export function tokenFilePath(dataDir: string): string {
  return nodePath.join(dataDir, 'token');
}

export async function readTokenFile(dataDir: string): Promise<string | null> {
  try {
    return (await readFile(tokenFilePath(dataDir), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function writeTokenFile(dataDir: string, token: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = tokenFilePath(dataDir);
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {}); // a pre-existing file keeps its old mode otherwise; no-op on Windows
}

export interface PairOutcome {
  ok: boolean;
  deviceId?: string;
  error?: string;
}

export class Agent {
  private token: string | null;
  private state: AgentState = 'unpaired';
  private cfg: ResolvedConfig | null = null;
  private runtime: DeviceRuntime | null = null;
  private connection: DeviceConnection | null = null;
  private pairing: AbortController | null = null;
  private paused = false;
  private shuttingDown = false;

  constructor(private readonly opts: AgentOptions) {
    this.token = opts.token;
  }

  get currentState(): AgentState {
    return this.state;
  }

  get config(): ResolvedConfig | null {
    return this.cfg;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  private log(level: LogLevel, message: string): void {
    this.opts.emit({ type: 'log', level, message });
  }

  private setState(state: AgentState, detail?: string): void {
    this.state = state;
    this.opts.emit(detail === undefined ? { type: 'status', state } : { type: 'status', state, detail });
  }

  /** Loads the config and, when there is a token, connects. */
  async start(): Promise<void> {
    if (!(await this.reload())) return;
    if (this.token && this.cfg?.server) this.connect();
    else if (this.token) this.setState('error', 'no server configured (set "server" in config.json)');
    else this.setState('unpaired');
  }

  /** (Re)reads config.json and rebuilds the runtime. False when the config is unusable (state `error`). */
  private async reload(): Promise<boolean> {
    try {
      const cfg = resolveConfig(await loadConfig(this.opts.configPath), this.opts.dataDir, hostEnv());
      for (const w of cfg.warnings) this.log('warn', w);
      await this.runtime?.dispose('configuration changed');
      this.cfg = cfg;
      this.runtime = new DeviceRuntime(cfg, (tool, summary) => this.opts.emit({ type: 'activity', tool, summary }));
      return true;
    } catch (err) {
      const message = err instanceof ConfigError ? err.message : (err as Error).message;
      this.log('error', message);
      this.cfg = null;
      await this.runtime?.dispose('configuration invalid');
      this.runtime = null;
      this.setState('error', message.split('\n')[0]);
      return false;
    }
  }

  private connect(): void {
    const { cfg, runtime, token } = this;
    if (!cfg?.server || !runtime || !token) return;
    this.connection = new DeviceConnection({
      server: cfg.server,
      token,
      createServer: () => runtime.createServer(),
      onState: (state: ConnectionState, detail) => {
        if (this.connection === null) return; // torn down meanwhile
        this.setState(state, detail);
        if (state === 'revoked' || state === 'replaced') void this.runtime?.dispose(`device ${state}`);
      },
      log: (level, message) => this.log(level, message),
      ...(this.opts.connectionBackoff ? { backoff: this.opts.connectionBackoff } : {}),
    });
    this.connection.start();
  }

  private async disconnect(): Promise<void> {
    const c = this.connection;
    this.connection = null;
    await c?.stop();
  }

  /** The tray changed config.json: re-read it and reconnect with the new capabilities. */
  async configChanged(): Promise<void> {
    if (this.pairing) return; // pairing uses server/name from the file as read when it started
    await this.disconnect();
    if (!(await this.reload())) return;
    if (this.paused) return this.setState('paused');
    if (this.token) this.connect();
    else this.setState('unpaired');
  }

  /** Pauses: disconnect, end every shell, close the browser. The device stays paired. */
  async pause(): Promise<void> {
    this.paused = true;
    this.pairing?.abort();
    await this.disconnect();
    await this.runtime?.dispose('paused');
    this.setState('paused');
  }

  async resume(): Promise<void> {
    this.paused = false;
    // Pausing disposed the old runtime's shells and browser; a fresh one starts clean.
    await this.disconnect();
    if (!(await this.reload())) return;
    if (this.token) this.connect();
    else this.setState('unpaired');
  }

  /** Forget this device locally. (Removing it on the server is done in the app's Settings → Devices.) */
  async unpair(): Promise<void> {
    this.pairing?.abort();
    await this.disconnect();
    await this.runtime?.dispose('unpaired');
    this.token = null;
    this.paused = false;
    if (this.opts.persistToken) await rm(tokenFilePath(this.opts.dataDir), { force: true });
    this.opts.emit({ type: 'unpaired' });
    this.setState('unpaired');
  }

  /**
   * Pairing with the server and name from the config (or the overrides): emits `pairing` with the code, waits for the
   * person to approve, then emits `paired` and — unless `connectAfter` is false — connects.
   */
  async pair(overrides: { server?: string; name?: string } = {}, connectAfter = true): Promise<PairOutcome> {
    if (this.pairing) return { ok: false, error: 'pairing is already in progress' };
    if (!this.cfg && !(await this.reload())) return { ok: false, error: 'invalid config' };
    const cfg = this.cfg!;
    const server = (overrides.server ?? cfg.server)?.replace(/\/+$/, '');
    const name = overrides.name ?? cfg.deviceName;
    if (!server) {
      const error = 'no server configured: set "server" in config.json (or pass --server)';
      this.setState('error', error);
      return { ok: false, error };
    }

    await this.disconnect();
    const abort = new AbortController();
    this.pairing = abort;
    this.paused = false;
    this.setState('pairing');
    try {
      const result = await pairDevice({
        request: { server, name, platform: cfg.platform, agentVersion: AGENT_VERSION },
        signal: abort.signal,
        onCode: code => this.opts.emit({ type: 'pairing', userCode: code.userCode, url: code.url }),
      });
      this.pairing = null;
      this.token = result.deviceToken;
      if (this.opts.persistToken) await writeTokenFile(this.opts.dataDir, result.deviceToken);
      if (overrides.server || overrides.name) {
        await updateConfigFile(this.opts.configPath, { ...(overrides.server ? { server } : {}), ...(overrides.name ? { deviceName: name } : {}) });
        await this.reload();
      }
      this.opts.emit({ type: 'paired', token: result.deviceToken, deviceId: result.deviceId });
      if (connectAfter) this.connect();
      else this.setState('offline', 'paired');
      return { ok: true, deviceId: result.deviceId };
    } catch (err) {
      this.pairing = null;
      const message = (err as Error).message;
      const aborted = err instanceof PairingError && err.reason === 'aborted';
      if (!aborted) this.log('warn', `pairing failed: ${message}`);
      if (this.token && this.cfg?.server && !aborted) this.connect(); // a failed re-pairing leaves the old pairing working
      else if (!aborted) this.setState(this.token ? 'offline' : 'unpaired', message);
      return { ok: false, error: message };
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.pairing?.abort();
    await this.disconnect();
    await this.runtime?.dispose('shutting down');
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** For `process.on('exit')`. */
  killNow(): void {
    this.runtime?.killNow();
  }
}
