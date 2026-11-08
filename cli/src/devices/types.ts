/**
 * Shapes of the device bridge (docs/devices.md): what the orchestrator stores about a device, what the device reports
 * about itself, and what the API returns. Parsing of anything that arrives from outside is tolerant on optional parts and
 * strict on the parts a decision depends on (a permission level is one of its values or the default).
 */

export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export type DevicePlatform = (typeof PLATFORMS)[number];

export type ShellLevel = 'allowlist' | 'strict' | 'auto';
export type AskLevel = 'ask' | 'auto';

/** The three levels of Settings → Devices (ADR 0019). */
export interface DevicePolicy {
  shell: ShellLevel;
  filesWrite: AskLevel;
  browserAct: AskLevel;
}

export const DEFAULT_DEVICE_POLICY: DevicePolicy = { shell: 'allowlist', filesWrite: 'ask', browserAct: 'ask' };

const SHELL_LEVELS: readonly string[] = ['allowlist', 'strict', 'auto'];
const ASK_LEVELS: readonly string[] = ['ask', 'auto'];

/** A stored or submitted policy → a complete one: anything missing or unknown falls back to the (restrictive) default. */
export function parseDevicePolicy(raw: unknown): DevicePolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    shell: SHELL_LEVELS.includes(o['shell'] as string) ? (o['shell'] as ShellLevel) : DEFAULT_DEVICE_POLICY.shell,
    filesWrite: ASK_LEVELS.includes(o['filesWrite'] as string) ? (o['filesWrite'] as AskLevel) : DEFAULT_DEVICE_POLICY.filesWrite,
    browserAct: ASK_LEVELS.includes(o['browserAct'] as string) ? (o['browserAct'] as AskLevel) : DEFAULT_DEVICE_POLICY.browserAct,
  };
}

/** Validates the body of PATCH /devices/:id: returns the keys to change, or an error sentence. Unknown keys are refused, not ignored. */
export function validatePolicyPatch(raw: unknown): { patch: Partial<DevicePolicy> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'policy must be an object' };
  const patch: Partial<DevicePolicy> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'shell' && SHELL_LEVELS.includes(value as string)) patch.shell = value as ShellLevel;
    else if (key === 'filesWrite' && ASK_LEVELS.includes(value as string)) patch.filesWrite = value as AskLevel;
    else if (key === 'browserAct' && ASK_LEVELS.includes(value as string)) patch.browserAct = value as AskLevel;
    else return { error: `policy.${key}: ${key === 'shell' ? 'allowlist | strict | auto' : key === 'filesWrite' || key === 'browserAct' ? 'ask | auto' : 'unknown level'}` };
  }
  return { patch };
}

/** `evvapp://device/info`, as the device describes itself. */
export interface DeviceReport {
  name: string;
  platform: DevicePlatform;
  arch: string;
  hostname: string;
  agentVersion: string;
  shell: { enabled: boolean; kind: 'posix' | 'powershell'; path: string };
  files: { enabled: boolean; roots: string[]; write: boolean };
  browser: { enabled: boolean; mode: 'profile' | 'dedicated'; product: 'brave' | 'chrome' | 'edge' | 'chromium' | 'custom'; executable: string | null };
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The device's own description, cleaned. null when it is not an object at all or names no platform we know — the report
 * feeds a security decision (is the shell POSIX?), so a half-understood one is no report. A missing shell `kind` becomes
 * `powershell`: the gate then treats the shell as the one it cannot parse.
 */
export function parseDeviceReport(raw: unknown): DeviceReport | null {
  const o = obj(raw);
  if (!PLATFORMS.includes(o['platform'] as DevicePlatform)) return null;
  const shell = obj(o['shell']);
  const files = obj(o['files']);
  const browser = obj(o['browser']);
  const products = ['brave', 'chrome', 'edge', 'chromium', 'custom'] as const;
  return {
    name: str(o['name'], 80),
    platform: o['platform'] as DevicePlatform,
    arch: str(o['arch'], 32),
    hostname: str(o['hostname'], 100),
    agentVersion: str(o['agentVersion'], 32),
    shell: { enabled: shell['enabled'] === true, kind: shell['kind'] === 'posix' ? 'posix' : 'powershell', path: str(shell['path'], 300) },
    files: {
      enabled: files['enabled'] === true,
      roots: Array.isArray(files['roots']) ? files['roots'].filter((r): r is string => typeof r === 'string').slice(0, 50).map(r => r.slice(0, 300)) : [],
      write: files['write'] === true,
    },
    browser: {
      enabled: browser['enabled'] === true,
      mode: browser['mode'] === 'dedicated' ? 'dedicated' : 'profile',
      product: products.includes(browser['product'] as (typeof products)[number]) ? (browser['product'] as (typeof products)[number]) : 'custom',
      executable: typeof browser['executable'] === 'string' ? browser['executable'].slice(0, 300) : null,
    },
  };
}

/** What GET /api/devices returns for one device. */
export interface DeviceInfo {
  id: string;
  name: string;
  connectionName: string;
  platform: DevicePlatform;
  agentVersion: string;
  online: boolean;
  connectedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  policy: DevicePolicy;
  report: DeviceReport | null;
  tools: string[];
}

export const connectionNameOf = (slug: string): string => `device-${slug}`;
export const CONNECT_PATH = '/api/devices/connect';
export const REPORT_URI = 'evvapp://device/info';
