import { stat } from 'node:fs/promises';
import { ShellSession, type ShellSpec } from './session.js';

/**
 * The device's shell sessions, keyed by (conversation, session name): a chat gets its own shells, and "main" in one chat
 * is not "main" in another. At most `maxSessions` per device; a session nobody touched for `idleMs` is closed by the reaper.
 */

export class SessionLimitError extends Error {
  constructor(max: number, open: string[]) {
    super(`this device already has ${max} shell sessions open (${open.join(', ')}); close one with shell_close first`);
    this.name = 'ShellSessionLimitError';
  }
}

export interface ManagerOptions {
  spec: ShellSpec;
  defaultCwd: string;
  maxSessions?: number;
  idleMs?: number;
  reapEveryMs?: number;
}

export interface SessionSummary {
  name: string;
  running: string | null;
  cwd: string;
  idleSeconds: number;
}

const key = (conv: string, name: string): string => `${conv}\u0000${name}`;

export class ShellManager {
  private readonly sessions = new Map<string, { conv: string; name: string; session: Promise<ShellSession> }>();
  private readonly live = new Set<ShellSession>();
  private reaper: NodeJS.Timeout | null = null;
  private readonly max: number;
  private readonly idleMs: number;

  constructor(private readonly opts: ManagerOptions) {
    this.max = opts.maxSessions ?? 8;
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.reaper = setInterval(() => void this.reap(), opts.reapEveryMs ?? 60_000);
    this.reaper.unref();
  }

  get shell(): ShellSpec {
    return this.opts.spec;
  }

  /** Existing live session, or null. */
  async get(conv: string, name: string): Promise<ShellSession | null> {
    const entry = this.sessions.get(key(conv, name));
    if (!entry) return null;
    const s = await entry.session.catch(() => null);
    return s && !s.isDead ? s : null;
  }

  /** The session for (conv, name), started if it does not exist. `cwd` only matters for a new one. */
  async acquire(conv: string, name: string, cwd?: string): Promise<{ session: ShellSession; created: boolean }> {
    const existing = await this.get(conv, name);
    if (existing) return { session: existing, created: false };
    this.sessions.delete(key(conv, name)); // a dead one
    if (this.sessions.size >= this.max) {
      throw new SessionLimitError(this.max, [...this.sessions.values()].map(e => e.name));
    }
    const startDir = cwd ?? this.opts.defaultCwd;
    const info = await stat(startDir).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`cwd "${startDir}" is not a directory on this device`);
    const k = key(conv, name);
    const session = ShellSession.start(this.opts.spec, startDir, s => {
      this.live.delete(s);
      // Drop a shell that ended on its own (the slot may already hold a newer session: compare identity).
      if (this.sessions.get(k) === entry) this.sessions.delete(k);
    });
    const entry = { conv, name, session };
    this.sessions.set(k, entry);
    try {
      const started = await session;
      this.live.add(started);
      return { session: started, created: true };
    } catch (err) {
      if (this.sessions.get(k) === entry) this.sessions.delete(k);
      throw err;
    }
  }

  async list(conv: string): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const e of this.sessions.values()) {
      if (e.conv !== conv) continue;
      const s = await e.session.catch(() => null);
      if (!s || s.isDead) continue;
      out.push({ name: e.name, running: s.runningCommand, cwd: s.cwd, idleSeconds: Math.round((Date.now() - s.lastActivity) / 1000) });
    }
    return out;
  }

  async close(conv: string, name: string): Promise<boolean> {
    const k = key(conv, name);
    const entry = this.sessions.get(k);
    if (!entry) return false;
    this.sessions.delete(k);
    const s = await entry.session.catch(() => null);
    await s?.close();
    return true;
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map(async e => (await e.session.catch(() => null))?.close()));
  }

  /** Stops the reaper and closes everything. */
  async dispose(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await this.closeAll();
  }

  /** Closes sessions nobody touched for the idle period. Public so tests need not wait for the timer. */
  async reap(now = Date.now()): Promise<number> {
    let closed = 0;
    for (const [k, e] of [...this.sessions]) {
      const s = await e.session.catch(() => null);
      if (!s) continue;
      if (now - s.lastActivity > this.idleMs) {
        this.sessions.delete(k);
        await s.close();
        closed++;
      }
    }
    return closed;
  }

  /** Synchronous last resort for process exit (where nothing async runs any more): SIGKILL every shell's process group. */
  killAllNow(): void {
    for (const s of this.live) s.hardKill();
  }
}
