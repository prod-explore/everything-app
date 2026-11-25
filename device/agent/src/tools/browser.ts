import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chromium, type BrowserContext, type Page } from 'playwright';
import {
  attachPageHandlers,
  BrowserSessionPool,
  embeddedConfig,
  installPolicyRoutes,
  jsContextOptions,
  registerBrowserTools,
  SessionLimitError,
  UrlGuard,
  type ClaimOptions,
  type ContextLauncher,
  type PlaywrightConfig,
  type SessionClosedInfo,
  type SessionPoolOptions,
  type SessionState,
} from '../../../../playwright-mcp/src/lib.js';
import { profileInUse } from '../browser/lock.js';
import type { ResolvedBrowser } from '../config.js';
import { PRODUCT_NAMES, type DevicePlatform } from '../detect.js';
import { errMessage } from './common.js';

/**
 * The device's browser tools: playwright-mcp's six (`browser_open` … `browser_close`, same names and schemas, so the
 * server's domain gate, `_policy` arguments and injection handling apply unchanged) with a launcher that starts the
 * PERSON'S browser instead of the hardened ephemeral Chromium (ADR 0020).
 *
 * What the launcher keeps from the server browser: the domain gate on every navigation (policy routes), the download /
 * file-chooser / dialog handlers, and — when the device does not allow its private network — the SSRF guard. What it
 * deliberately drops: the bot user agent, `--disable-extensions`, service-worker blocking and the permission lockdown
 * script, because this is the user's own browser in their own window, and pretending to be a bot there would only break
 * sites they are logged in to.
 */

/** Test-only switch (the real Chrome in CI has no display): run headless. Never read in production paths otherwise. */
const TEST_HEADLESS = 'EVVAPP_DEVICE_TEST_HEADLESS';

export class BrowserInUseError extends Error {
  constructor() {
    super(
      'the browser profile on this device is in use by another chat — each browser profile runs one session at a time. ' +
        'It is released when that chat calls browser_close or after 30 idle minutes.',
    );
    this.name = 'BrowserInUseError';
  }
}

export interface DevicePoolOptions extends SessionPoolOptions {
  defaultProfile?: 'dedicated' | 'personal';
  requirePersonalApproval?: boolean;
}

export class DevicePool extends BrowserSessionPool {
  private readonly defaultProfile?: 'dedicated' | 'personal';
  private readonly requirePersonalApproval: boolean;

  constructor(opts: DevicePoolOptions) {
    super(opts);
    this.defaultProfile = opts.defaultProfile;
    this.requirePersonalApproval = opts.requirePersonalApproval === true;
  }

  override async claim(conversationId: string, opts: ClaimOptions = {}): Promise<{ session: import('../../../../playwright-mcp/src/lib.js').SessionHandle; isNew: boolean }> {
    const profile = opts.profile ?? this.defaultProfile;
    if (profile === 'personal' && this.requirePersonalApproval && opts.personalApproved !== true) {
      throw new Error('Personal browser profile requires explicit user approval.');
    }
    if (!this.get(conversationId) && profile) {
      for (const s of this.status().sessions) {
        const handle = this.get(s.id);
        if (handle && handle.state.profile === profile) throw new BrowserInUseError();
      }
    }
    try {
      return await super.claim(conversationId, opts);
    } catch (err) {
      if (err instanceof SessionLimitError) throw new BrowserInUseError();
      throw err;
    }
  }
}

/**
 * Playwright adds switches meant for throwaway test browsers. Three of them would wreck the person's real browser:
 * `--disable-extensions` (their extensions, ad blockers, password managers), and `--password-store=basic` with
 * `--use-mock-keychain` (on macOS/Linux Chromium would no longer find the key that decrypts its saved cookies and
 * passwords, so the profile would look logged out).
 */
export const IGNORED_DEFAULT_ARGS = ['--disable-extensions', '--password-store=basic', '--use-mock-keychain'];

export function launchArgs(profileDirectory: string): string[] {
  const args = [`--profile-directory=${profileDirectory}`, '--no-first-run', '--no-default-browser-check'];
  if (process.env[TEST_HEADLESS] === '1' && process.getuid?.() === 0) args.push('--no-sandbox');
  return args;
}

export class DeviceLauncher implements ContextLauncher {
  constructor(
    private readonly browser: ResolvedBrowser,
    private readonly platform: DevicePlatform,
    private readonly downloadDir: string,
    private readonly onClosed: () => void,
  ) {}

  async launch(state: SessionState): Promise<{ context: BrowserContext; page: Page; existingPages: Page[] }> {
    const b = this.browser;
    const name = PRODUCT_NAMES[b.product];
    const profile: 'dedicated' | 'personal' = state.profile ?? b.defaultProfile ?? (b.mode === 'dedicated' ? 'dedicated' : 'personal');
    if (b.availableProfiles && !b.availableProfiles.includes(profile)) {
      throw new Error(`browser profile "${profile}" is not enabled on this device`);
    }
    const targetDir = profile === 'personal' ? (b.personalUserDataDir ?? b.userDataDir) : (b.dedicatedUserDataDir ?? b.userDataDir);
    const targetProfileDir = profile === 'dedicated' ? 'Default' : b.profileDirectory;
    if (!b.executable) throw new Error(`no ${name} executable found on this device (set browser.executable in the device config)`);
    if (!targetDir) throw new Error('no browser profile directory is configured for this device');

    if (profile === 'personal') {
      if (await profileInUse(targetDir, this.platform)) {
        const canDedicated = b.availableProfiles?.includes('dedicated');
        throw new Error(
          `${name} is open with this profile — close it, or switch the device to the dedicated profile` +
            (canDedicated ? ' (or call browser_open with profile="dedicated")' : ''),
        );
      }
    } else {
      await mkdir(targetDir, { recursive: true });
    }

    state.downloadDir = this.downloadDir;
    state.persistentProfile = true;
    state.profile = profile;
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(targetDir, {
        executablePath: b.executable,
        headless: process.env[TEST_HEADLESS] === '1',
        args: launchArgs(targetProfileDir),
        ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
        acceptDownloads: true,
        viewport: null,
        ...jsContextOptions(state.policy.js),
      });
    } catch (err) {
      const hint =
        b.product === 'chrome' && profile === 'personal'
          ? ' Chrome 136+ refuses automation on its default profile folder — switch the device to the dedicated profile.'
          : '';
      throw new Error(`could not start ${name}: ${firstLine(errMessage(err))}.${hint}`);
    }

    try {
      // Only the domain gate here (relaxed for manual user browsing while enforcing agent actions); SSRF guard joins if allowPrivateNetwork=false.
      await installPolicyRoutes(context, state, b.allowPrivateNetwork ? undefined : new UrlGuard());
      const existingPages = [...context.pages()];
      for (const p of existingPages) attachPageHandlers(p, state);
      context.on('page', p => attachPageHandlers(p, state));
      // A restored session may bring tabs of the person's own: leave them alone and work in a tab of our own.
      const page = await context.newPage();
      context.once('close', () => this.onClosed());
      return { context, page, existingPages };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  }
}

const firstLine = (s: string): string => s.split('\n')[0]!.trim();

export interface DeviceBrowser {
  pool: BrowserSessionPool;
  config: PlaywrightConfig;
  register(server: McpServer): void;
  closeAll(reason: string): Promise<void>;
}

export interface DeviceBrowserOptions {
  downloadDir?: string;
  /** A browser session ended, for whatever reason (see `SessionPoolOptions.onSessionClosed`). */
  onSessionClosed?: (info: SessionClosedInfo) => void;
}

export function createDeviceBrowser(browser: ResolvedBrowser, platform: DevicePlatform, options: DeviceBrowserOptions = {}): DeviceBrowser {
  const downloadDir = options.downloadDir ?? nodePath.join(homedir(), 'Downloads');
  const availableProfiles = browser.availableProfiles ?? [browser.mode === 'dedicated' ? 'dedicated' : 'personal'];
  const defaultProfile = browser.defaultProfile ?? (browser.mode === 'dedicated' ? 'dedicated' : 'personal');
  const config = embeddedConfig({
    maxSessions: Math.max(1, availableProfiles.length),
    persistentProfile: true,
    allowPrivateNetwork: browser.allowPrivateNetwork,
    availableProfiles,
    defaultProfile,
    requirePersonalApproval: true,
  });
  const pool: BrowserSessionPool = new DevicePool({
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    watchdogIntervalMs: config.watchdogIntervalMs,
    maxTabs: config.maxTabs,
    defaultProfile,
    requirePersonalApproval: true,
    ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
    makeLauncher: conversationId => new DeviceLauncher(browser, platform, downloadDir, () => void pool.close(conversationId, 'the browser was closed')),
  });
  return {
    pool,
    config,
    register: server => registerBrowserTools(server, config, pool),
    async closeAll(reason) {
      for (const s of pool.status().sessions) await pool.close(s.id, reason);
      pool.stopWatchdog();
    },
  };
}
