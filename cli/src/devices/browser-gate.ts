import type { ConversationDeps } from '../llm-loop.js';
import { PersonalBrowserGrants } from './personal-grants.js';
import type { DeviceStore } from './store.js';

/**
 * The server's side of the personal-browser-profile consent for paired devices (ADR 0019/0020): which `browser_open` /
 * `browser_tabs` calls need the person's say-so, and what the consent covers afterwards. The turn loop asks this gate
 * before such a call and tells it what happened; the consent itself lives in `PersonalBrowserGrants` and ends with the
 * browser session it was given for (see that file).
 */

export type DeviceBrowserGate = NonNullable<ConversationDeps['deviceBrowserGate']>;

export interface DeviceBrowserGateDeps {
  store: Pick<DeviceStore, 'getBySlug'>;
  grants: PersonalBrowserGrants;
}

/** The part of a tool name before `__`, when it is a device tool (`device-pc__browser_open` → `device-pc`). */
function deviceConnectionOf(toolName: string): string | null {
  if (!toolName.startsWith('device-')) return null;
  const sep = toolName.indexOf('__');
  return sep < 0 ? null : toolName.slice(0, sep);
}

export function createDeviceBrowserGate(deps: DeviceBrowserGateDeps, convId: string | null | undefined): DeviceBrowserGate {
  const { store, grants } = deps;
  const keyOf = (connName: string) => PersonalBrowserGrants.key(convId, connName);
  return {
    checkPersonalProfile(toolName, args) {
      const connName = deviceConnectionOf(toolName);
      if (!connName) return { required: false };
      const real = toolName.slice(connName.length + 2);
      if (real !== 'browser_open' && real !== 'browser_tabs') return { required: false };
      const row = store.getBySlug(connName.slice('device-'.length));
      if (!row?.report?.browser.enabled) return { error: `Browser control is not enabled on ${row?.name ?? connName}.` };
      const mode = row.report.browser.mode;
      const rawProfile = args['profile'];
      if (rawProfile !== undefined && rawProfile !== 'dedicated' && rawProfile !== 'personal') {
        return { error: `Invalid browser profile "${String(rawProfile)}" — expected "dedicated" or "personal".` };
      }
      const key = keyOf(connName);
      // One look at the grant per call, so its expiry cannot change between the decision below and `alreadyActive`.
      const active = grants.has(key);
      let target: 'dedicated' | 'personal';
      if (mode === 'profile') {
        if (rawProfile === 'dedicated') return { error: `${row.name} only enables your personal browser profile (mode="profile").` };
        target = 'personal';
      } else if (mode === 'dedicated') {
        if (rawProfile === 'personal') return { error: `${row.name} is set to Dedicated browser mode only; switch it to "both" in the tray app to allow personal profile.` };
        target = 'dedicated';
      } else {
        if (rawProfile === 'personal') target = 'personal';
        else if (rawProfile === 'dedicated') target = 'dedicated';
        else target = real === 'browser_tabs' && active ? 'personal' : 'dedicated';
      }
      if (target !== 'personal') return { required: false };
      return {
        required: true,
        policy: row.policy.browserPersonalProfile,
        label: `${connName}/browser_personal_profile`,
        deviceName: row.name,
        browser: row.report.browser.product,
        alreadyActive: active,
      };
    },

    markPersonalActive(toolName, active) {
      const connName = deviceConnectionOf(toolName);
      if (!convId || !connName) return;
      if (active) grants.grant(keyOf(connName));
      else grants.revoke(keyOf(connName));
    },

    noteBrowserUse(toolName) {
      const connName = deviceConnectionOf(toolName);
      if (!convId || !connName) return;
      grants.touch(keyOf(connName));
    },
  };
}

/**
 * A device said a browser session ended: the consent for a personal one ends with it. (`default` is the id the device uses
 * for a call that carried no conversation id; the server's key for such a call is the empty id.) Returns whether a grant was dropped.
 */
export function revokeOnSessionClosed(
  grants: PersonalBrowserGrants,
  connectionName: string,
  event: { conversationId: string; profile: 'dedicated' | 'personal' },
): boolean {
  if (event.profile !== 'personal') return false;
  return grants.revoke(PersonalBrowserGrants.key(event.conversationId === 'default' ? '' : event.conversationId, connectionName));
}
