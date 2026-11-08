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
  type ContextLauncher,
  type PlaywrightConfig,
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
      'the browser on this device is in use by another chat — a device runs one browser session at a time. ' +
        'It is released when that chat calls browser_close or after 30 idle minutes.',
    );
    this.name = 'BrowserInUseError';
  }
}

export class DevicePool extends BrowserSessionPool {
  override async claim(...args: Parameters<BrowserSessionPool['claim']>): ReturnType<BrowserSessionPool['claim']> {
    try {
      return await super.claim(...args);
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

  async launch(state: SessionState): Promise<{ context: BrowserContext; page: Page }> {
    const b = this.browser;
    const name = PRODUCT_NAMES[b.product];
    if (!b.executable) throw new Error(`no ${name} executable found on this device (set browser.executable in the device config)`);
    if (!b.userDataDir) throw new Error('no browser profile directory is configured for this device');

    if (b.mode === 'profile') {
      if (await profileInUse(b.userDataDir, this.platform)) {
        throw new Error(`${name} is open with this profile — close it, or switch the device to the dedicated profile`);
      }
    } else {
      await mkdir(b.userDataDir, { recursive: true });
    }

    state.downloadDir = this.downloadDir;
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(b.userDataDir, {
        executablePath: b.executable,
        headless: process.env[TEST_HEADLESS] === '1',
        args: launchArgs(b.profileDirectory),
        ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
        acceptDownloads: true,
        viewport: null,
        ...jsContextOptions(state.policy.js),
      });
    } catch (err) {
      const hint =
        b.product === 'chrome' && b.mode === 'profile'
          ? ' Chrome 136+ refuses automation on its default profile folder — switch the device to the dedicated profile.'
          : '';
      throw new Error(`could not start ${name}: ${firstLine(errMessage(err))}.${hint}`);
    }

    try {
      // Only the domain gate here; the SSRF guard joins it when the device does not allow its private network.
      await installPolicyRoutes(context, state, b.allowPrivateNetwork ? undefined : new UrlGuard());
      for (const p of context.pages()) attachPageHandlers(p, state);
      context.on('page', p => attachPageHandlers(p, state));
      // A restored session may bring tabs of the person's own: leave them alone and work in a tab of our own.
      const page = await context.newPage();
      context.once('close', () => this.onClosed());
      return { context, page };
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

export function createDeviceBrowser(browser: ResolvedBrowser, platform: DevicePlatform, downloadDir = nodePath.join(homedir(), 'Downloads')): DeviceBrowser {
  const config = embeddedConfig({ maxSessions: 1, persistentProfile: true, allowPrivateNetwork: browser.allowPrivateNetwork });
  const pool: BrowserSessionPool = new DevicePool({
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.sessionIdleTimeoutMs,
    watchdogIntervalMs: config.watchdogIntervalMs,
    maxTabs: config.maxTabs,
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
