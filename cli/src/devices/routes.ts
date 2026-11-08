import express from 'express';
import type Database from 'better-sqlite3';
import { deleteApprovalGrantsWithPrefix, logApprovalAudit } from '../db.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { DeviceHub } from './hub.js';
import { PairingError, USER_CODE_RE, type PairingManager } from './pairing.js';
import { hashDeviceToken, newDeviceToken, type DeviceRow, type DeviceStore } from './store.js';
import { PLATFORMS, connectionNameOf, validatePolicyPatch, type DeviceInfo, type DevicePlatform } from './types.js';

/**
 * REST endpoints of the device bridge (docs/devices.md). Two routers, because they sit on different sides of the app's
 * login: `public` (pairing start and poll — the device has no session yet) is mounted before the auth middleware,
 * `api` (approving a pairing, listing, changing and revoking devices) after it. The public ones create nothing: a device
 * row appears only when a logged-in person approves a pairing.
 */

export interface DeviceRoutesDeps {
  db: Database.Database;
  store: DeviceStore;
  hub: DeviceHub;
  registry: ToolRegistry;
  pairing: PairingManager;
  /** A device was added, changed or removed (Settings → Devices refreshes). */
  onChange?: (deviceId: string) => void;
}

/** A display name: 1–40 characters, no control characters. */
function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

const route = (fn: (req: express.Request, res: express.Response) => void): express.RequestHandler =>
  (req, res) => { try { fn(req, res); } catch (err) { if (!res.headersSent) res.status(500).json({ error: (err as Error).message }); } };

export function createDeviceRoutes(deps: DeviceRoutesDeps) {
  const { db, store, hub, registry, pairing } = deps;
  const notify = (id: string) => { try { deps.onChange?.(id); } catch { /* never blocks a request */ } };

  function info(row: DeviceRow): DeviceInfo {
    const connectionName = connectionNameOf(row.slug);
    const live = hub.list().find(l => l.deviceId === row.id);
    return {
      id: row.id,
      name: row.name,
      connectionName,
      platform: row.platform,
      agentVersion: row.agentVersion,
      online: live !== undefined,
      connectedAt: live?.connectedAt ?? null,
      lastSeenAt: live?.lastActivityAt ?? row.lastSeenAt,
      createdAt: row.createdAt,
      policy: row.policy,
      report: row.report,
      tools: live ? registry.toolsOf(connectionName).map(t => t.name) : [],
    };
  }

  // ── unauthenticated: the device starts and polls ────────────────────────────
  const pub = express.Router();

  pub.post('/devices/pair/start', route((req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = cleanName(b['name']);
    const agentVersion = typeof b['agentVersion'] === 'string' ? b['agentVersion'].trim() : '';
    if (!name || !PLATFORMS.includes(b['platform'] as DevicePlatform) || agentVersion.length < 1 || agentVersion.length > 32) {
      res.status(400).json({ error: 'expected { name: string(1..40), platform: "windows"|"macos"|"linux", agentVersion: string(1..32) }' });
      return;
    }
    try {
      res.json(pairing.start({ name, platform: b['platform'] as DevicePlatform, agentVersion, ip: req.ip ?? 'unknown' }));
    } catch (err) {
      if (!(err instanceof PairingError)) throw err;
      res.set('Retry-After', '60').status(429).json({ error: err.message, code: err.code });
    }
  }));

  pub.post('/devices/pair/poll', route((req, res) => {
    const code = (req.body as Record<string, unknown> | undefined)?.['deviceCode'];
    if (typeof code !== 'string' || code.length < 1 || code.length > 200) { res.status(400).json({ error: 'expected { deviceCode: string }' }); return; }
    const result = pairing.poll(code);
    res.status(result.status === 'denied' || result.status === 'expired' ? 410 : 200).json(result);
  }));

  // ── authenticated: the person decides, Settings manages ─────────────────────
  const api = express.Router();

  api.get('/devices/pair/:userCode', route((req, res) => {
    const code = String(req.params['userCode']).toUpperCase();
    const view = USER_CODE_RE.test(code) ? pairing.view(code) : null;
    if (!view) { res.status(404).json({ error: 'no pending pairing with this code (it may have expired)' }); return; }
    res.json(view);
  }));

  api.post('/devices/pair/:userCode/approve', route((req, res) => {
    const code = String(req.params['userCode']).toUpperCase();
    const body = (req.body ?? {}) as Record<string, unknown>;
    let chosen: string | undefined;
    if (body['name'] !== undefined) {
      const n = cleanName(body['name']);
      if (!n) { res.status(400).json({ error: 'name must be 1 to 40 characters' }); return; }
      chosen = n;
    }
    const grant = USER_CODE_RE.test(code)
      ? pairing.approve(code, request => {
        const token = newDeviceToken();
        const row = store.create({ name: chosen ?? request.name, platform: request.platform, agentVersion: request.agentVersion, tokenHash: hashDeviceToken(token) });
        logApprovalAudit(db, { action: 'device_paired', toolLabel: connectionNameOf(row.slug), toolArgs: JSON.stringify({ platform: row.platform, ip: request.ip }) });
        return { deviceId: row.id, deviceToken: token, connectionName: connectionNameOf(row.slug) };
      })
      : null;
    if (!grant) { res.status(404).json({ error: 'no pending pairing with this code (it may have expired)' }); return; }
    notify(grant.deviceId);
    res.json({ deviceId: grant.deviceId });
  }));

  api.post('/devices/pair/:userCode/deny', route((req, res) => {
    const code = String(req.params['userCode']).toUpperCase();
    if (!USER_CODE_RE.test(code) || !pairing.deny(code)) { res.status(404).json({ error: 'no pending pairing with this code (it may have expired)' }); return; }
    res.json({});
  }));

  api.get('/devices', route((_req, res) => {
    pairing.sweep();
    res.json({ devices: store.list().map(info) });
  }));

  api.patch('/devices/:id', route((req, res) => {
    const row = store.get(String(req.params['id']));
    if (!row) { res.status(404).json({ error: 'unknown device' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    let name: string | undefined;
    if (body['name'] !== undefined) {
      const n = cleanName(body['name']);
      if (!n) { res.status(400).json({ error: 'name must be 1 to 40 characters' }); return; }
      name = n;
    }
    let patch: ReturnType<typeof validatePolicyPatch> | undefined;
    if (body['policy'] !== undefined) {
      patch = validatePolicyPatch(body['policy']);
      if ('error' in patch) { res.status(400).json({ error: patch.error }); return; }
    }
    if (name !== undefined) store.rename(row.id, name);
    if (patch && 'patch' in patch) store.setPolicy(row.id, { ...row.policy, ...patch.patch });
    notify(row.id);
    res.json(info(store.get(row.id)!));
  }));

  // Revoke: the row (and with it the token) goes first, so a reconnect is refused even in the instant before the socket closes.
  api.delete('/devices/:id', route((req, res) => {
    const row = store.get(String(req.params['id']));
    if (!row) { res.status(404).json({ error: 'unknown device' }); return; }
    const connection = connectionNameOf(row.slug);
    store.delete(row.id);
    hub.revoke(row.id);
    registry.removeConnection(connection);
    // `device-pc/` also never matches `device-pc-2/`; the slash and the colon end the name.
    const grants = deleteApprovalGrantsWithPrefix(db, [`${connection}/`, `cmd@${connection}:`]);
    logApprovalAudit(db, { action: 'device_revoked', toolLabel: connection, toolArgs: JSON.stringify({ grantsRemoved: grants }) });
    notify(row.id);
    res.json({});
  }));

  return { public: pub, api };
}
