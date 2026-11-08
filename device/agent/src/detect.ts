import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';

/**
 * Auto-detection for everything the device config leaves `null`: which shell, which browser binary, where that browser
 * keeps its profile. Pure functions over an explicit environment (`HostEnv`) so every OS branch is testable on any OS.
 */

export type DevicePlatform = 'windows' | 'macos' | 'linux';
export type ShellKind = 'posix' | 'powershell';
export type BrowserProduct = 'brave' | 'chrome' | 'edge' | 'chromium' | 'custom';

export interface HostEnv {
  platform: DevicePlatform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
}

export function hostPlatform(): DevicePlatform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

export function hostEnv(): HostEnv {
  return { platform: hostPlatform(), env: process.env, home: homedir(), exists: existsSync };
}

/** Windows paths need win32 joins even when the detection logic runs elsewhere (tests). */
function pathFor(platform: DevicePlatform): nodePath.PlatformPath {
  return platform === 'windows' ? nodePath.win32 : nodePath.posix;
}

/** Environment variable lookup that ignores case on Windows, where `ProgramFiles` and `PROGRAMFILES` are one variable. */
function envVar(h: HostEnv, name: string): string | undefined {
  if (h.platform !== 'windows') return h.env[name];
  const key = Object.keys(h.env).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? h.env[key] : undefined;
}

export function findOnPath(command: string, h: HostEnv): string | null {
  const p = pathFor(h.platform);
  const sep = h.platform === 'windows' ? ';' : ':';
  for (const dir of (envVar(h, 'PATH') ?? '').split(sep)) {
    if (!dir) continue;
    const candidate = p.join(dir, command);
    if (h.exists(candidate)) return candidate;
  }
  return null;
}

// ─── Shell ──────────────────────────────────────────────────────────────────────

export interface ShellChoice {
  path: string;
  kind: ShellKind;
}

export function shellKind(shellPath: string): ShellKind {
  const base = shellPath.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  return base === 'pwsh' || base === 'powershell' ? 'powershell' : 'posix';
}

/** Shells whose syntax the session protocol (`$?`, heredocs, `exec 2>&1`) works with. fish, csh and nushell do not. */
const POSIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash']);

export function isSupportedPosixShell(shellPath: string): boolean {
  return POSIX_SHELLS.has(shellPath.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, ''));
}

/**
 * Windows: Git Bash first (models write bash far better than PowerShell, and the command policy parses POSIX shell),
 * then PowerShell 7, then Windows PowerShell. macOS/Linux: `$SHELL`, unless it is one the protocol cannot drive.
 */
export function detectShell(h: HostEnv): ShellChoice | null {
  const p = pathFor(h.platform);
  if (h.platform === 'windows') {
    const pf = [envVar(h, 'ProgramFiles'), envVar(h, 'ProgramW6432'), envVar(h, 'ProgramFiles(x86)')].filter((x): x is string => !!x);
    const local = envVar(h, 'LOCALAPPDATA');
    const git: string[] = [
      ...pf.map(d => p.join(d, 'Git', 'bin', 'bash.exe')),
      ...(local ? [p.join(local, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
    ];
    // `git.exe` on PATH (Git\cmd\git.exe) says where Git for Windows really is, e.g. on another drive.
    const gitExe = findOnPath('git.exe', h);
    if (gitExe) git.push(p.join(p.dirname(p.dirname(gitExe)), 'bin', 'bash.exe'));
    // C:\Windows\System32\bash.exe is the WSL launcher, deliberately not a candidate.
    for (const c of git) if (h.exists(c)) return { path: c, kind: 'posix' };
    const pwsh = findOnPath('pwsh.exe', h) ?? pf.map(d => p.join(d, 'PowerShell', '7', 'pwsh.exe')).find(h.exists);
    if (pwsh) return { path: pwsh, kind: 'powershell' };
    const root = envVar(h, 'SystemRoot') ?? 'C:\\Windows';
    const legacy = p.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (h.exists(legacy)) return { path: legacy, kind: 'powershell' };
    return findOnPath('powershell.exe', h) ? { path: 'powershell.exe', kind: 'powershell' } : null;
  }
  const fromEnv = envVar(h, 'SHELL');
  if (fromEnv && h.exists(fromEnv) && isSupportedPosixShell(fromEnv)) return { path: fromEnv, kind: 'posix' };
  const fallbacks = h.platform === 'macos' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/usr/bin/bash', '/bin/sh'];
  const found = fallbacks.find(h.exists);
  return found ? { path: found, kind: 'posix' } : null;
}

/** "Git Bash", "PowerShell", "bash" — what the model is told it is talking to. */
export function describeShell(shellPath: string, kind: ShellKind, platform: DevicePlatform): string {
  if (kind === 'powershell') return 'PowerShell';
  if (platform === 'windows') return 'Git Bash';
  return shellPath.split('/').pop() || 'sh';
}

// ─── Browser ────────────────────────────────────────────────────────────────────

export const PRODUCT_NAMES: Record<BrowserProduct, string> = {
  brave: 'Brave',
  chrome: 'Chrome',
  edge: 'Edge',
  chromium: 'Chromium',
  custom: 'the browser',
};

interface ProductLayout {
  /** Install locations per OS; Windows entries are relative to a base directory chosen below. */
  win: { exe: string[]; data: string };
  mac: { exe: string[]; data: string };
  linux: { exe: string[]; data: string };
}

const LAYOUTS: Record<Exclude<BrowserProduct, 'custom'>, ProductLayout> = {
  brave: {
    win: { exe: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'], data: 'BraveSoftware\\Brave-Browser\\User Data' },
    mac: { exe: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'], data: 'BraveSoftware/Brave-Browser' },
    linux: {
      exe: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave-browser', '/snap/bin/brave'],
      data: 'BraveSoftware/Brave-Browser',
    },
  },
  chrome: {
    win: { exe: ['Google\\Chrome\\Application\\chrome.exe'], data: 'Google\\Chrome\\User Data' },
    mac: { exe: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], data: 'Google/Chrome' },
    linux: { exe: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'], data: 'google-chrome' },
  },
  edge: {
    win: { exe: ['Microsoft\\Edge\\Application\\msedge.exe'], data: 'Microsoft\\Edge\\User Data' },
    mac: { exe: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'], data: 'Microsoft Edge' },
    linux: { exe: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'], data: 'microsoft-edge' },
  },
  chromium: {
    win: { exe: ['Chromium\\Application\\chrome.exe'], data: 'Chromium\\User Data' },
    mac: { exe: ['/Applications/Chromium.app/Contents/MacOS/Chromium'], data: 'Chromium' },
    linux: { exe: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'], data: 'chromium' },
  },
};

export function browserCandidates(product: BrowserProduct, h: HostEnv): string[] {
  if (product === 'custom') return [];
  const layout = LAYOUTS[product];
  if (h.platform === 'macos') return [...layout.mac.exe, ...layout.mac.exe.map(e => nodePath.posix.join(h.home, e))];
  if (h.platform === 'linux') return layout.linux.exe;
  const bases = [envVar(h, 'ProgramFiles'), envVar(h, 'ProgramFiles(x86)'), envVar(h, 'LOCALAPPDATA')].filter((x): x is string => !!x);
  return layout.win.exe.flatMap(rel => bases.map(b => nodePath.win32.join(b, rel)));
}

export function detectBrowserExecutable(product: BrowserProduct, h: HostEnv): string | null {
  return browserCandidates(product, h).find(h.exists) ?? null;
}

/** The product's standard profile root ("User Data" / "~/.config/BraveSoftware/Brave-Browser"). `custom` has none. */
export function defaultUserDataDir(product: BrowserProduct, h: HostEnv): string | null {
  if (product === 'custom') return null;
  const layout = LAYOUTS[product];
  if (h.platform === 'windows') {
    const local = envVar(h, 'LOCALAPPDATA') ?? nodePath.win32.join(h.home, 'AppData', 'Local');
    return nodePath.win32.join(local, layout.win.data);
  }
  if (h.platform === 'macos') return nodePath.posix.join(h.home, 'Library', 'Application Support', layout.mac.data);
  const xdg = envVar(h, 'XDG_CONFIG_HOME');
  return nodePath.posix.join(xdg && nodePath.posix.isAbsolute(xdg) ? xdg : nodePath.posix.join(h.home, '.config'), layout.linux.data);
}

// ─── Data directory ─────────────────────────────────────────────────────────────

/** Where config.json, the token file and the dedicated browser profile live. */
export function defaultDataDir(h: HostEnv): string {
  if (h.platform === 'windows') {
    return nodePath.win32.join(envVar(h, 'APPDATA') ?? nodePath.win32.join(h.home, 'AppData', 'Roaming'), 'evvapp-device');
  }
  if (h.platform === 'macos') return nodePath.posix.join(h.home, 'Library', 'Application Support', 'evvapp-device');
  const xdg = envVar(h, 'XDG_CONFIG_HOME');
  return nodePath.posix.join(xdg && nodePath.posix.isAbsolute(xdg) ? xdg : nodePath.posix.join(h.home, '.config'), 'evvapp-device');
}
