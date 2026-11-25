import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeRigs, deviceRig, online, posixReport, waitFor } from './devices-fixture.js';
import { createDeviceBrowserGate, revokeOnSessionClosed } from '../devices/browser-gate.js';
import { BROWSER_SESSION_CLOSED_METHOD, DEFAULT_DEVICE_POLICY, type DevicePolicy } from '../devices/types.js';
import { DEFAULT_PERSONAL_GRANT_IDLE_MINUTES, PersonalBrowserGrants, personalGrantIdleMs } from '../devices/personal-grants.js';

afterEach(closeRigs);

const MIN = 60_000;

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('PersonalBrowserGrants', () => {
  it('a grant lapses after the idle limit and not before', () => {
    const c = clock();
    const g = new PersonalBrowserGrants({ ttlMs: 25 * MIN, now: c.now });
    const key = PersonalBrowserGrants.key('chat-1', 'device-pc');
    assert.equal(g.has(key), false);
    g.grant(key);
    c.advance(25 * MIN - 1);
    assert.equal(g.has(key), true);
    c.advance(1);
    assert.equal(g.has(key), false, 'lapsed exactly at the limit');
    assert.equal(g.size, 0, 'and was dropped');
  });

  it('use renews a live grant, again and again, but never creates or revives one', () => {
    const c = clock();
    const g = new PersonalBrowserGrants({ ttlMs: 25 * MIN, now: c.now });
    const key = PersonalBrowserGrants.key('chat-1', 'device-pc');
    g.touch(key);
    assert.equal(g.has(key), false, 'touch alone grants nothing');
    g.grant(key);
    for (let i = 0; i < 5; i++) { c.advance(20 * MIN); g.touch(key); }
    assert.equal(g.has(key), true, '100 minutes in, still alive because it was used every 20');
    c.advance(26 * MIN);
    g.touch(key);
    assert.equal(g.has(key), false, 'a lapsed grant stays lapsed');
  });

  it('grants are per chat and per device; revoking one leaves the others', () => {
    const g = new PersonalBrowserGrants({ ttlMs: 25 * MIN });
    const a = PersonalBrowserGrants.key('chat-1', 'device-pc');
    const b = PersonalBrowserGrants.key('chat-2', 'device-pc');
    const c = PersonalBrowserGrants.key('chat-1', 'device-laptop');
    for (const k of [a, b, c]) g.grant(k);
    assert.equal(g.revoke(a), true);
    assert.equal(g.revoke(a), false);
    assert.deepEqual([g.has(a), g.has(b), g.has(c)], [false, true, true]);
    assert.equal(g.revokeDevice('device-pc'), 1);
    assert.deepEqual([g.has(b), g.has(c)], [false, true]);
    g.retainDevices(new Set(['device-pc']));
    assert.equal(g.has(c), false, 'a device that is not online keeps no grants');
  });

  it('a ttl of 0 means no idle limit', () => {
    const c = clock();
    const g = new PersonalBrowserGrants({ ttlMs: 0, now: c.now });
    g.grant('k:device-pc');
    c.advance(365 * 24 * 60 * MIN);
    assert.equal(g.has('k:device-pc'), true);
  });

  it('DEVICE_PERSONAL_BROWSER_IDLE_MINUTES: 25 by default (5 under the device\'s 30), 0 = no limit, junk = the default', () => {
    assert.equal(DEFAULT_PERSONAL_GRANT_IDLE_MINUTES, 25);
    assert.equal(personalGrantIdleMs({}), 25 * MIN);
    assert.equal(personalGrantIdleMs({ DEVICE_PERSONAL_BROWSER_IDLE_MINUTES: '' }), 25 * MIN);
    assert.equal(personalGrantIdleMs({ DEVICE_PERSONAL_BROWSER_IDLE_MINUTES: '10' }), 10 * MIN);
    assert.equal(personalGrantIdleMs({ DEVICE_PERSONAL_BROWSER_IDLE_MINUTES: '0' }), 0);
    for (const junk of ['soon', '-1', '1.5', '1441', '10m']) assert.equal(personalGrantIdleMs({ DEVICE_PERSONAL_BROWSER_IDLE_MINUTES: junk }), 25 * MIN, junk);
  });
});

describe('the personal-profile gate with expiring consent', () => {
  function gateRig(policy: Partial<DevicePolicy> = {}) {
    const c = clock();
    const grants = new PersonalBrowserGrants({ ttlMs: 25 * MIN, now: c.now });
    const row = { name: 'PC', policy: { ...DEFAULT_DEVICE_POLICY, ...policy }, report: posixReport({ browser: { enabled: true, mode: 'both', profiles: ['dedicated', 'personal'], product: 'brave', executable: null } }) };
    const store = { getBySlug: (slug: string) => (slug === 'pc' ? (row as never) : null) };
    const gate = (conv = 'chat-1') => createDeviceBrowserGate({ store, grants }, conv);
    return { c, grants, gate };
  }
  const personalOpen = { url: 'https://example.com', profile: 'personal' };

  it('after "Allow" the next calls do not ask again — until the browser sits unused past the limit', () => {
    const { c, gate } = gateRig();
    const g = gate();
    assert.deepEqual(g.checkPersonalProfile('device-pc__browser_open', personalOpen), { required: true, policy: 'ask', label: 'device-pc/browser_personal_profile', deviceName: 'PC', browser: 'brave', alreadyActive: false });
    g.markPersonalActive!('device-pc__browser_open', true);
    c.advance(24 * MIN);
    assert.equal((g.checkPersonalProfile('device-pc__browser_open', personalOpen) as { alreadyActive: boolean }).alreadyActive, true);
    c.advance(26 * MIN);
    assert.equal((g.checkPersonalProfile('device-pc__browser_open', personalOpen) as { alreadyActive: boolean }).alreadyActive, false, 'asks again by policy');
  });

  it('every browser call renews it (observe, act, screenshot … not only open/tabs), so a busy chat is never asked mid-task', () => {
    const { c, gate } = gateRig();
    const g = gate();
    g.markPersonalActive!('device-pc__browser_open', true);
    for (let i = 0; i < 6; i++) { c.advance(20 * MIN); g.noteBrowserUse!('device-pc__browser_act'); }
    assert.equal((g.checkPersonalProfile('device-pc__browser_tabs', { action: 'list' }) as { required: boolean; alreadyActive?: boolean }).alreadyActive, true);
  });

  it('a browser_tabs call with no profile means personal only while the consent lives; after it lapses it is a dedicated call and needs none', () => {
    const { c, gate } = gateRig();
    const g = gate();
    g.markPersonalActive!('device-pc__browser_open', true);
    assert.equal((g.checkPersonalProfile('device-pc__browser_tabs', { action: 'list' }) as { required: boolean }).required, true);
    c.advance(26 * MIN);
    assert.deepEqual(g.checkPersonalProfile('device-pc__browser_tabs', { action: 'list' }), { required: false });
  });

  it('use of the device by another chat or a tool that is not a device tool renews nothing', () => {
    const { c, grants, gate } = gateRig();
    gate('chat-1').markPersonalActive!('device-pc__browser_open', true);
    gate('chat-2').noteBrowserUse!('device-pc__browser_act');
    gate('chat-1').noteBrowserUse!('sandbox__browser_act');
    gate('chat-1').noteBrowserUse!('device-pc'); // no `__`: not a tool name
    c.advance(26 * MIN);
    assert.equal(grants.has(PersonalBrowserGrants.key('chat-1', 'device-pc')), false);
    assert.equal(grants.has(PersonalBrowserGrants.key('chat-2', 'device-pc')), false, 'chat-2 never had one');
  });

  it('the device\'s "session closed" ends consent for that chat only, personal sessions only, and maps the device\'s `default` id', () => {
    const { grants, gate } = gateRig();
    gate('chat-1').markPersonalActive!('device-pc__browser_open', true);
    gate('chat-2').markPersonalActive!('device-pc__browser_open', true);
    gate('').markPersonalActive!('device-pc__browser_open', true); // no conversation id: nothing is recorded for it
    assert.equal(revokeOnSessionClosed(grants, 'device-pc', { conversationId: 'chat-1', profile: 'dedicated' }), false);
    assert.equal(revokeOnSessionClosed(grants, 'device-laptop', { conversationId: 'chat-1', profile: 'personal' }), false);
    assert.equal(revokeOnSessionClosed(grants, 'device-pc', { conversationId: 'chat-1', profile: 'personal' }), true);
    assert.equal(grants.has('chat-1:device-pc'), false);
    assert.equal(grants.has('chat-2:device-pc'), true);
    grants.grant(':device-pc');
    assert.equal(revokeOnSessionClosed(grants, 'device-pc', { conversationId: 'default', profile: 'personal' }), true);
    assert.equal(grants.has(':device-pc'), false);
  });
});

describe('the device says its browser session ended (over a real WebSocket)', () => {
  it('delivers the notification with the device\'s connection name; a malformed one and an unknown profile are dropped; an old agent simply sends none', async () => {
    const got: Array<{ conn: string; conversationId: string; profile: string; reason: string }> = [];
    const r = await deviceRig({}, [], (conn, e) => { got.push({ conn, ...e }); });
    const p = r.pair('PC');
    const d = await online(r, p.token);
    await waitFor(() => r.svc.hub.isOnline(p.id), 3000, 'device online');
    const send = (params: unknown) => d.server.notification({ method: BROWSER_SESSION_CLOSED_METHOD, params } as never);

    await send({ conversationId: 'chat-1', profile: 'personal', reason: 'idle timeout, idle 31m' });
    await waitFor(() => got.length === 1, 3000, 'notification');
    assert.deepEqual(got[0], { conn: 'device-pc', conversationId: 'chat-1', profile: 'personal', reason: 'idle timeout, idle 31m' });

    await send({ conversationId: 'chat-2', profile: 'dedicated' }); // reason is optional
    await send({ conversationId: 'chat-3', profile: 'work', reason: 'x' });
    await send({ profile: 'personal' });
    await send('nonsense');
    await send({ conversationId: 'chat-4', profile: 'personal', reason: 'ok' });
    await waitFor(() => got.length === 3, 3000, 'later notifications');
    assert.deepEqual(got.slice(1).map(g => [g.conversationId, g.profile, g.reason]), [['chat-2', 'dedicated', ''], ['chat-4', 'personal', 'ok']]);
  });

  it('end to end: the grant a chat holds is gone after the device reports the session closed, and the next personal call asks again', async () => {
    const c = clock();
    const grants = new PersonalBrowserGrants({ ttlMs: 25 * MIN, now: c.now });
    const r = await deviceRig({}, [], (conn, e) => { revokeOnSessionClosed(grants, conn, e); });
    const p = r.pair('PC');
    const d = await online(r, p.token, { report: posixReport({ browser: { enabled: true, mode: 'both', profiles: ['dedicated', 'personal'], product: 'brave', executable: null } }) });
    await waitFor(() => r.svc.hub.isOnline(p.id), 3000, 'device online');
    const gate = createDeviceBrowserGate({ store: r.svc.store, grants }, 'chat-1');
    const open = { url: 'https://example.com', profile: 'personal' };
    gate.markPersonalActive!(`${p.connection}__browser_open`, true);
    assert.equal((gate.checkPersonalProfile(`${p.connection}__browser_open`, open) as { alreadyActive: boolean }).alreadyActive, true);

    await d.server.notification({ method: BROWSER_SESSION_CLOSED_METHOD, params: { conversationId: 'chat-1', profile: 'personal', reason: 'the browser was closed' } } as never);
    await waitFor(() => !grants.has(PersonalBrowserGrants.key('chat-1', p.connection)), 3000, 'grant revoked');
    const again = gate.checkPersonalProfile(`${p.connection}__browser_open`, open) as { required: boolean; alreadyActive: boolean; policy: string };
    assert.deepEqual([again.required, again.alreadyActive, again.policy], [true, false, 'ask']);
  });
});
