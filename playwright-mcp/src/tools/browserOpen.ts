import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';
import { drainEvents, withAgentAction } from '../browserContext.js';
import { normalizeHost } from '../policy.js';
import { observePage } from '../observe.js';
import { observationResult, UNTRUSTED_CONTENT_NOTICE } from './formatObservation.js';
import {
  applyCallPolicy,
  checkTargetUrl,
  effectivePolicy,
  ensurePageApproved,
  hiddenPolicyArgs,
  resolveProfileChoice,
  withDownloadPermission,
} from './policyArgs.js';
import { openTab } from '../sessionPool.js';
import type { Tab } from '../tabs.js';
import { formatTabs, tabNote } from './tabNote.js';
import { fail } from './types.js';

/** The normalized host of `url` when it is exactly the host the orchestrator says the user approved. */
export function approvedHostFor(url: string, approvedHost: string | undefined): string | null {
  if (!approvedHost) return null;
  try {
    const host = normalizeHost(new URL(url).hostname);
    return host === normalizeHost(approvedHost) ? host : null;
  } catch {
    return null;
  }
}

/** `approvedHostFor` plus the apex <-> `www.` sibling for two-label public domain names (handles `www.github.com` <-> `github.com` redirects). */
export function approvedHostsFor(url: string, approvedHost: string | undefined): string[] {
  const host = approvedHostFor(url, approvedHost);
  if (!host) return [];
  const hosts = [host];
  if (host.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':') && !host.endsWith('.localhost')) {
    if (host.startsWith('www.') && host.slice(4).includes('.')) hosts.push(host.slice(4));
    else if (host.split('.').length === 2) hosts.push(`www.${host}`);
  }
  return hosts;
}

export function registerBrowserOpen(server: McpServer, config: PlaywrightConfig, pool: BrowserSessionPool): void {
  const profiles = config?.availableProfiles;
  const profileDesc = profiles && profiles.length > 1
    ? `Which browser profile to open: "${profiles.join('" or "')}" (default "${config.defaultProfile ?? 'dedicated'}" — use "personal" only when the user wants you to work in their own logged-in browser or tabs; it asks the user for approval).`
    : 'Optional browser profile choice ("dedicated" or "personal") when the device supports multiple profiles.';
  server.registerTool(
    'browser_open',
    {
      title: 'Open page',
      description: 'Open (or reuse) this conversation\'s browser session and navigate to a URL. ' +
        'The session STAYS OPEN across calls — use browser_act to click/type/' +
        'select on the page afterward, and browser_close when you\'re done with it. ' +
        'The page opens in the current tab; with new_tab: true it opens in a new tab and the other tabs stay as they ' +
        'were (switch between them with browser_tabs). With `tab: N`, attaches to an already-open tab N (e.g. a user tab listed by browser_tabs) without reloading if it is already on that URL host. ' +
        (config?.persistentProfile
          ? 'When running in a persistent profile on the user\'s device, it is visible on their screen with their saved logins and cookies; if a site needs a login that is not there, ask the user to log in in that window. '
          : 'The browser profile is ephemeral: no saved logins or cookies from earlier sessions; if a site ' +
            'needs a login, ask the user to log in via the live view. ') +
        'The user approves each website ' +
        '(domain) the first time you open it; a link or redirect to a DIFFERENT domain is blocked until you browser_open that URL, ' +
        'which asks the user. A domain the operator blocked stays blocked — tell the user instead of retrying. ' +
        'Returns a deterministic observation: the interactive element list (refs for browser_act) and ' +
        'the visible page text. ' +
        UNTRUSTED_CONTENT_NOTICE,
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to. Must be http or https.'),
        new_tab: z
          .boolean()
          .optional()
          .describe('Open the URL in a NEW tab (which becomes the active one) instead of replacing the current page, so the page you were on stays open. Default false.'),
        tab: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Existing tab number (from browser_tabs list) to activate and attach to instead of opening a new tab. If that tab is already on the same host, it is observed without reloading.'),
        profile: z
          .enum(['dedicated', 'personal'])
          .optional()
          .describe(profileDesc),
        _conversation_id: z
          .string()
          .optional()
          .describe('Internal: conversation ID for session isolation. Set by the orchestrator.'),
        ...hiddenPolicyArgs,
        _approved_host: z
          .string()
          .optional()
          .describe('Internal: the host the user just approved for this browser session. Set by the orchestrator, never by the model.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, new_tab, tab, profile, _conversation_id, _policy, _allow_downloads, _approved_host, _personal_profile_approved }) => {
      const convId = _conversation_id ?? 'default';
      const resolvedProfile = resolveProfileChoice(config, profile);
      if ('error' in resolvedProfile) return fail(resolvedProfile.error);
      const targetProfile = resolvedProfile.profile;
      if (config.requirePersonalApproval && targetProfile === 'personal' && _personal_profile_approved !== true) {
        return fail('Personal browser profile requires explicit user approval.');
      }

      let existing = pool.get(convId);
      const notes: string[] = [];
      if (existing && targetProfile && existing.state.profile && existing.state.profile !== targetProfile) {
        await pool.close(convId, `switching browser profile (${existing.state.profile} → ${targetProfile})`);
        notes.push(`(switched browser profile to "${targetProfile}")`);
        existing = undefined;
      }

      const override = _policy ?? existing?.state.override;
      // The host the user approved on the card counts for this session (not just this call): the pages it links
      // to on the same host must stay reachable. It must be the host of the URL being opened, nothing wider.
      const approved = approvedHostsFor(url, _approved_host);
      const preflight = new Set([...(existing?.state.approvedHosts ?? []), ...approved]);
      const policy = effectivePolicy(config, override, preflight);

      const blocked = await checkTargetUrl(config, policy, url);
      if (blocked) return fail(blocked);

      try {
        // JS on/off is fixed when a context is created — a changed JS policy needs a fresh session.
        if (existing && existing.state.policy.js !== policy.js) {
          await pool.close(convId, `JS policy changed (${existing.state.policy.js} → ${policy.js})`);
          notes.push(`(JS policy changed to "${policy.js}" — restarted the browser session)`);
        }
        const { session, isNew } = await pool.claim(convId, {
          policy,
          override,
          persistentProfile: config.persistentProfile,
          profile: targetProfile,
          personalApproved: _personal_profile_approved === true,
        });
        for (const h of approved) session.state.approvedHosts.add(h);
        if (_personal_profile_approved) session.state.personalApproved = true;
        applyCallPolicy(config, session.state, _policy);
        notes.unshift(
          isNew ? '(opened a new browser session for this conversation)' : '(reusing this conversation\'s existing browser session)',
        );

        return await withDownloadPermission(session.state, _allow_downloads, async () => {
          return await withAgentAction(session.state, async () => {
            let createdTab: Tab | null = null;
            if (tab !== undefined) {
              const target = session.tabs.get(tab);
              if (!target) return fail(`There is no tab [${tab}].\n${formatTabs(session)}`);
              session.tabs.activate(tab);
              await target.page.bringToFront().catch(() => {});
              let currentHost: string | null = null;
              try {
                currentHost = normalizeHost(new URL(target.page.url()).hostname);
              } catch {
                currentHost = null;
              }
              const targetHosts = new Set<string>(approved);
              try {
                targetHosts.add(normalizeHost(new URL(url).hostname));
              } catch {
                /* keep approved */
              }
              if (currentHost && targetHosts.has(currentHost) && ensurePageApproved(session, target.page, tab) === null) {
                pool.setCurrentUrl(convId, target.page.url());
                const obs = await observePage(target.page, config, session.state.policy.js);
                return observationResult(obs, [...notes, `(attached to tab [${tab}] without reloading)`, tabNote(session)], drainEvents(session.state));
              }
            } else if (new_tab && !isNew) {
              try {
                createdTab = await openTab(session);
                notes.push(`(opened in a new tab [${createdTab.id}])`);
              } catch (err) {
                return fail(`browser_open error: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            session.page.setDefaultTimeout(config.navTimeoutMs);
            try {
              await withAgentAction(session.state, () => session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }), session.page);
            } catch (err) {
              // A tab that never got its page would only sit there empty.
              if (createdTab && session.tabs.size > 1) await createdTab.page.close().catch(() => {});
              const events = drainEvents(session.state);
              const message = err instanceof Error ? err.message : String(err);
              return fail(`browser_open error: ${message}${events.length ? `\n${events.map(e => `- ${e}`).join('\n')}` : ''}`);
            }
            pool.setCurrentUrl(convId, session.page.url());
            const obs = await observePage(session.page, config, session.state.policy.js);
            return observationResult(obs, [...notes, tabNote(session)], drainEvents(session.state));
          });
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`browser_open error: ${message}`);
      }
    },
  );
}
