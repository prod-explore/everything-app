import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as nodePath from 'node:path';
import { z } from 'zod';
import {
  defaultUserDataDir,
  detectBrowserExecutable,
  detectShell,
  hostEnv,
  shellKind,
  type BrowserProduct,
  type DevicePlatform,
  type HostEnv,
  type ShellKind,
} from './detect.js';

/**
 * The device config (`config.json`, docs/devices.md). Every capability is OFF unless the file says otherwise except the
 * shell, and the file is the ceiling the owner of the machine sets (ADR 0019): nothing in here can be changed by the server.
 * `null` means "detect it" — see detect.ts; `resolveConfig` turns a validated config into concrete paths.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function defaultDeviceName(): string {
  return hostname().trim().slice(0, 40) || 'My computer';
}

const serverUrl = z
  .string()
  .trim()
  .refine(v => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http:// or https:// URL');

export const configSchema = z.object({
  server: serverUrl.nullable().default(null),
  deviceName: z.string().trim().min(1).max(40).default(defaultDeviceName),
  shell: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().min(1).nullable().default(null),
      cwd: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  files: z
    .object({
      enabled: z.boolean().default(false),
      roots: z.array(z.string().min(1)).default([]),
      write: z.boolean().default(false),
    })
    .prefault({}),
  browser: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['profile', 'dedicated']).default('profile'),
      product: z.enum(['brave', 'chrome', 'edge', 'chromium', 'custom']).default('brave'),
      executable: z.string().min(1).nullable().default(null),
      userDataDir: z.string().min(1).nullable().default(null),
      profileDirectory: z.string().min(1).default('Default'),
      allowPrivateNetwork: z.boolean().default(true),
    })
    .prefault({}),
});

export type DeviceConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): DeviceConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) throw new ConfigError(`invalid config:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Reads and validates the config file. A missing file is the all-defaults config; a broken one is an error, never silently defaults. */
export async function loadConfig(configPath: string): Promise<DeviceConfig> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig({});
    throw new ConfigError(`cannot read ${configPath}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseConfig(json);
  } catch (err) {
    throw new ConfigError(`${configPath}: ${(err as Error).message}`);
  }
}

/** Merges `patch` into the file's existing JSON (unknown keys survive) and writes it atomically. Used by headless pairing. */
export async function updateConfigFile(configPath: string, patch: { server?: string; deviceName?: string }): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    /* missing or unreadable: start from an empty object */
  }
  const next = { ...current, ...patch };
  parseConfig(next); // never write a file the next start would refuse
  await mkdir(nodePath.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, configPath);
}

/** `~` and `~/x` to the home directory; everything else untouched. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return nodePath.join(home, p.slice(2));
  return p;
}

// ─── Resolution ─────────────────────────────────────────────────────────────────

export interface ResolvedShell {
  enabled: boolean;
  kind: ShellKind;
  path: string;
  cwd: string;
}

export interface ResolvedFiles {
  enabled: boolean;
  roots: string[];
  write: boolean;
}

export interface ResolvedBrowser {
  enabled: boolean;
  mode: 'profile' | 'dedicated';
  product: BrowserProduct;
  executable: string | null;
  /** The directory handed to Chromium as --user-data-dir; null only when nothing could be determined (custom product without one). */
  userDataDir: string | null;
  profileDirectory: string;
  allowPrivateNetwork: boolean;
}

export interface ResolvedConfig {
  server: string | null;
  deviceName: string;
  platform: DevicePlatform;
  shell: ResolvedShell;
  files: ResolvedFiles;
  browser: ResolvedBrowser;
  /** Why a capability the file switched on is not usable (nothing found, no folders…); shown in logs, never fatal. */
  warnings: string[];
}

/**
 * Concrete values for every `null`. A capability that is switched on but cannot work (no shell found, no folders) is
 * switched off in the result with a warning, so the report the server reads never promises tools that cannot run.
 */
export function resolveConfig(cfg: DeviceConfig, dataDir: string, h: HostEnv = hostEnv()): ResolvedConfig {
  const warnings: string[] = [];

  const detected = cfg.shell.path ? { path: expandHome(cfg.shell.path, h.home), kind: shellKind(cfg.shell.path) } : detectShell(h);
  if (cfg.shell.enabled && !detected) warnings.push('shell: no usable shell found (set shell.path)');
  const shell: ResolvedShell = {
    enabled: cfg.shell.enabled && !!detected,
    kind: detected?.kind ?? 'posix',
    path: detected?.path ?? '',
    cwd: cfg.shell.cwd ? expandHome(cfg.shell.cwd, h.home) : h.home,
  };

  const roots = [...new Set(cfg.files.roots.map(r => nodePath.resolve(expandHome(r, h.home))))];
  if (cfg.files.enabled && roots.length === 0) warnings.push('files: enabled but no folders are configured (files.roots)');
  const files: ResolvedFiles = { enabled: cfg.files.enabled && roots.length > 0, roots, write: cfg.files.write };

  const b = cfg.browser;
  const executable = b.executable ? expandHome(b.executable, h.home) : detectBrowserExecutable(b.product, h);
  if (b.enabled && !executable) warnings.push(`browser: no ${b.product} executable found (set browser.executable)`);
  const dedicatedDir = (h.platform === 'windows' ? nodePath.win32 : nodePath.posix).join(dataDir, 'browser-profile');
  const userDataDir = b.mode === 'dedicated' ? dedicatedDir : b.userDataDir ? expandHome(b.userDataDir, h.home) : defaultUserDataDir(b.product, h);
  if (b.enabled && !userDataDir) warnings.push('browser: product "custom" in profile mode needs browser.userDataDir');
  const browser: ResolvedBrowser = {
    // Without an executable the tools would only ever fail; the server should not see them. Profile mode with an unknown
    // profile directory is the same situation.
    enabled: b.enabled && !!executable && !!userDataDir,
    mode: b.mode,
    product: b.product,
    executable,
    userDataDir,
    profileDirectory: b.mode === 'dedicated' ? 'Default' : b.profileDirectory,
    allowPrivateNetwork: b.allowPrivateNetwork,
  };

  return { server: cfg.server?.replace(/\/+$/, '') ?? null, deviceName: cfg.deviceName, platform: h.platform, shell, files, browser, warnings };
}
