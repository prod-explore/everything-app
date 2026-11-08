import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { columnExists } from '../db.js';
import {
  DEFAULT_DEVICE_POLICY, connectionNameOf, parseDevicePolicy, parseDeviceReport,
  type DevicePlatform, type DevicePolicy, type DeviceReport,
} from './types.js';

/**
 * Paired devices (ADR 0018): one row per machine. The device token is never stored — only its SHA-256. The token is 32
 * random bytes, so a fast hash is the right one: there is nothing to guess and nothing to stretch, and a leaked database
 * cannot be replayed as tokens. The policy (the three levels of ADR 0019) and the device's last self-report are JSON
 * columns; the policy is read from here on every call, so a change in Settings applies to the next tool call.
 */

export function migrateDevices(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      platform      TEXT NOT NULL,
      agent_version TEXT NOT NULL DEFAULT '',
      token_hash    TEXT NOT NULL UNIQUE,
      policy        TEXT NOT NULL DEFAULT '{}',
      report        TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at  TEXT,
      connected_at  TEXT
    );
  `);
  // Columns added after the first release go here, one `columnExists` check each (see db.ts).
  if (!columnExists(db, 'devices', 'report')) db.exec(`ALTER TABLE devices ADD COLUMN report TEXT`);
}

/** A new device token: 32 random bytes, base64url (43 characters). */
export const newDeviceToken = (): string => randomBytes(32).toString('base64url');

export const hashDeviceToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** `My Desktop PC!` → `my-desktop-pc`: lowercase `[a-z0-9-]`, 1–24 characters. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // é → e
    .replace(/[łŁ]/g, 'l').replace(/[øØ]/g, 'o').replace(/[đĐ]/g, 'd').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 24).replace(/-+$/, '');
  return slug || 'device';
}

export interface DeviceRow {
  id: string;
  name: string;
  slug: string;
  platform: DevicePlatform;
  agentVersion: string;
  policy: DevicePolicy;
  report: DeviceReport | null;
  createdAt: string;
  lastSeenAt: string | null;
  connectedAt: string | null;
}

interface Raw {
  id: string; name: string; slug: string; platform: string; agent_version: string; token_hash: string;
  policy: string; report: string | null; created_at: string; last_seen_at: string | null; connected_at: string | null;
}

const COLUMNS = `id, name, slug, platform, agent_version, token_hash, policy, report, created_at, last_seen_at, connected_at`;

function json(text: string | null): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function toRow(r: Raw): DeviceRow {
  return {
    id: r.id, name: r.name, slug: r.slug, platform: r.platform as DevicePlatform, agentVersion: r.agent_version,
    policy: parseDevicePolicy(json(r.policy)), report: parseDeviceReport(json(r.report)),
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, connectedAt: r.connected_at,
  };
}

const now = () => new Date().toISOString();

export class DeviceStore {
  constructor(private readonly db: Database.Database) {}

  list(): DeviceRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM devices ORDER BY created_at, rowid`).all() as Raw[]).map(toRow);
  }

  get(id: string): DeviceRow | null {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM devices WHERE id = ?`).get(id) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  getBySlug(slug: string): DeviceRow | null {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM devices WHERE slug = ?`).get(slug) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  /** The device a token belongs to, or null. The hash is looked up by index and then compared in constant time. */
  findByToken(token: string): DeviceRow | null {
    const hash = hashDeviceToken(token);
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM devices WHERE token_hash = ?`).get(hash) as Raw | undefined;
    if (!r) return null;
    const a = Buffer.from(r.token_hash);
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b) ? toRow(r) : null;
  }

  /** A slug nobody uses yet: `pc`, then `pc-2`, `pc-3`… (the suffix is kept within the 24 characters). */
  uniqueSlug(name: string): string {
    const base = slugify(name);
    const taken = (s: string) => this.db.prepare(`SELECT 1 FROM devices WHERE slug = ?`).get(s) !== undefined;
    if (!taken(base)) return base;
    for (let i = 2; ; i++) {
      const suffix = `-${i}`;
      const candidate = `${base.slice(0, 24 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken(candidate)) return candidate;
    }
  }

  /**
   * Adds a device. The slug is fixed here for good: it is part of the connection name and of every grant made for the
   * device, so renaming the device later changes what is shown, never what grants are keyed to.
   */
  create(input: { name: string; platform: DevicePlatform; agentVersion: string; tokenHash: string; policy?: DevicePolicy }): DeviceRow {
    const id = randomBytes(8).toString('hex');
    const slug = this.uniqueSlug(input.name);
    this.db.prepare(`INSERT INTO devices (id, name, slug, platform, agent_version, token_hash, policy) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, slug, input.platform, input.agentVersion, input.tokenHash, JSON.stringify(input.policy ?? DEFAULT_DEVICE_POLICY));
    return this.get(id)!;
  }

  rename(id: string, name: string): void {
    this.db.prepare(`UPDATE devices SET name = ? WHERE id = ?`).run(name, id);
  }

  setPolicy(id: string, policy: DevicePolicy): void {
    this.db.prepare(`UPDATE devices SET policy = ? WHERE id = ?`).run(JSON.stringify(policy), id);
  }

  setReport(id: string, report: DeviceReport | null, agentVersion?: string): void {
    this.db.prepare(`UPDATE devices SET report = ?, agent_version = COALESCE(NULLIF(?, ''), agent_version) WHERE id = ?`)
      .run(report ? JSON.stringify(report) : null, agentVersion ?? '', id);
  }

  markConnected(id: string): void {
    const t = now();
    this.db.prepare(`UPDATE devices SET connected_at = ?, last_seen_at = ? WHERE id = ?`).run(t, t, id);
  }

  markDisconnected(id: string): void {
    this.db.prepare(`UPDATE devices SET connected_at = NULL, last_seen_at = ? WHERE id = ?`).run(now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id).changes > 0;
  }

  connectionName(row: Pick<DeviceRow, 'slug'>): string {
    return connectionNameOf(row.slug);
  }
}
