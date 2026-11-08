/** The tray ↔ agent stdio protocol (docs/devices.md): one JSON object per line. */

export type AgentState =
  | 'unpaired'
  | 'pairing'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'paused'
  | 'revoked'
  | 'replaced'
  | 'error';

export type LogLevel = 'info' | 'warn' | 'error';

/** Tray → agent. */
export type TrayMessage =
  | { type: 'start'; configPath: string; dataDir: string; token: string | null }
  | { type: 'config-changed' }
  | { type: 'pair' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'unpair' }
  | { type: 'shutdown' };

/** Agent → tray. */
export type AgentMessage =
  | { type: 'status'; state: AgentState; detail?: string }
  | { type: 'pairing'; userCode: string; url: string }
  | { type: 'paired'; token: string; deviceId: string }
  | { type: 'unpaired' }
  | { type: 'activity'; tool: string; summary: string }
  | { type: 'log'; level: LogLevel; message: string };

const TRAY_TYPES = new Set(['start', 'config-changed', 'pair', 'pause', 'resume', 'unpair', 'shutdown']);

/** Parses one line from the tray. Returns an Error (not a throw) so the reader can log and carry on. */
export function parseTrayMessage(line: string): TrayMessage | Error {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return new Error(`not JSON: ${line.slice(0, 80)}`);
  }
  if (!value || typeof value !== 'object') return new Error('message is not an object');
  const m = value as Record<string, unknown>;
  if (typeof m['type'] !== 'string' || !TRAY_TYPES.has(m['type'])) return new Error(`unknown message type: ${String(m['type'])}`);
  if (m['type'] === 'start') {
    if (typeof m['configPath'] !== 'string' || typeof m['dataDir'] !== 'string') return new Error('start needs configPath and dataDir');
    if (m['token'] !== null && typeof m['token'] !== 'string') return new Error('start.token must be a string or null');
    return { type: 'start', configPath: m['configPath'], dataDir: m['dataDir'], token: (m['token'] as string | null) ?? null };
  }
  return { type: m['type'] } as TrayMessage;
}

export function encodeAgentMessage(message: AgentMessage): string {
  return `${JSON.stringify(message)}\n`;
}
