import { arch, hostname } from 'node:os';
import type { ResolvedConfig } from './config.js';
import { describeShell, type BrowserProduct, type DevicePlatform, type ShellKind } from './detect.js';
import { AGENT_VERSION } from './version.js';

/** `evvapp://device/info` (docs/devices.md): what the server learns about the device right after `initialize`. */
export interface DeviceReport {
  name: string;
  platform: DevicePlatform;
  arch: string;
  hostname: string;
  agentVersion: string;
  shell: { enabled: boolean; kind: ShellKind; path: string };
  files: { enabled: boolean; roots: string[]; write: boolean };
  browser: {
    enabled: boolean;
    mode: 'profile' | 'dedicated';
    product: BrowserProduct;
    executable: string | null;
  };
}

export const DEVICE_INFO_URI = 'evvapp://device/info';

export function buildReport(cfg: ResolvedConfig): DeviceReport {
  return {
    name: cfg.deviceName,
    platform: cfg.platform,
    arch: arch(),
    hostname: hostname(),
    agentVersion: AGENT_VERSION,
    shell: { enabled: cfg.shell.enabled, kind: cfg.shell.kind, path: cfg.shell.path },
    files: { enabled: cfg.files.enabled, roots: cfg.files.roots, write: cfg.files.write },
    browser: {
      enabled: cfg.browser.enabled,
      mode: cfg.browser.mode,
      product: cfg.browser.product,
      executable: cfg.browser.executable,
    },
  };
}

const OS_NAMES: Record<DevicePlatform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

/**
 * "the user's own computer 'PC' (Windows, Git Bash)" — the phrase every device tool description starts from, so a model
 * choosing between `device-pc__shell_run` and `sandbox__run_bash` knows which machine, which OS and which shell it gets.
 */
export function deviceLabel(cfg: ResolvedConfig, withShell = true): string {
  const os = OS_NAMES[cfg.platform];
  const inner = withShell && cfg.shell.enabled ? `${os}, ${describeShell(cfg.shell.path, cfg.shell.kind, cfg.platform)}` : os;
  return `the user's own computer '${cfg.deviceName}' (${inner})`;
}
