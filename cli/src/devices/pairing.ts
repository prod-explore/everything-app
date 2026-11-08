import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { DevicePlatform } from './types.js';

/**
 * Device pairing (ADR 0018): the device-authorization flow of RFC 8628. A device starts a pairing and gets a secret
 * `deviceCode` (it polls with it) and a short `userCode` (the person compares it on both screens); a logged-in user
 * approves the code in the browser; the next poll returns the device token, exactly once.
 *
 * Everything here is in memory — a restart cancels pending pairings, which is harmless — and nothing is created until a
 * person approves. The device code is stored only as its SHA-256, like the token it leads to will be. The clock is
 * injectable so expiry and the rate limit can be tested without waiting.
 */

/** No 0/O, 1/I/L look-alikes. */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const USER_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_PAIRINGS = 20;
export const STARTS_PER_MINUTE = 10;
export const POLL_INTERVAL_S = 2;

export class PairingError extends Error {
  constructor(readonly code: 'rate_limited' | 'too_many_pending', message: string) { super(message); }
}

export interface PairingRequest {
  name: string;
  platform: DevicePlatform;
  agentVersion: string;
  /** Address the pairing was started from — shown to the approver, who should recognise it. */
  ip: string;
}

/** What the approval page shows. */
export interface PendingPairingView extends PairingRequest {
  userCode: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairingGrant {
  deviceId: string;
  deviceToken: string;
  connectionName: string;
}

export type PollResult =
  | { status: 'pending' }
  | ({ status: 'approved' } & PairingGrant)
  | { status: 'denied' | 'expired' };

interface Entry {
  req: PairingRequest;
  userCode: string;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  grant?: PairingGrant;
}

export interface PairingOptions {
  now?: () => number;
  ttlMs?: number;
  maxPending?: number;
  startsPerMinute?: number;
  /** An approval that was never collected expired: the device row made for it is orphaned (it never got its token). */
  onUncollected?: (deviceId: string) => void;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class PairingManager {
  /** Keyed by sha256(deviceCode). */
  private readonly byDevice = new Map<string, Entry>();
  private readonly byUser = new Map<string, string>();
  private readonly starts = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly perMinute: number;

  constructor(private readonly opts: PairingOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PAIRING_TTL_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING_PAIRINGS;
    this.perMinute = opts.startsPerMinute ?? STARTS_PER_MINUTE;
  }

  start(req: PairingRequest): { deviceCode: string; userCode: string; verificationPath: string; expiresIn: number; interval: number } {
    this.sweep();
    const t = this.now();
    // Sliding window per address. Every attempt counts, including the refused ones, so hammering does not get through later.
    const recent = (this.starts.get(req.ip) ?? []).filter(at => t - at < 60_000);
    recent.push(t);
    this.starts.set(req.ip, recent);
    if (recent.length > this.perMinute) throw new PairingError('rate_limited', 'too many pairing attempts from this address — wait a minute');
    const pending = [...this.byDevice.values()].filter(e => e.state === 'pending').length;
    if (pending >= this.maxPending) throw new PairingError('too_many_pending', 'too many pairings are waiting for approval — try again in a few minutes');

    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = this.newUserCode();
    this.byDevice.set(sha256(deviceCode), { req, userCode, createdAt: t, expiresAt: t + this.ttlMs, state: 'pending' });
    this.byUser.set(userCode, sha256(deviceCode));
    return {
      deviceCode,
      userCode,
      verificationPath: `/devices/pair?code=${userCode}`,
      expiresIn: Math.round(this.ttlMs / 1000),
      interval: POLL_INTERVAL_S,
    };
  }

  /**
   * The device's poll. `approved` is returned once and the pairing is gone afterwards; so is `denied`. A code that is
   * unknown — expired, already collected, never issued — reads as `expired`: all three mean "start again".
   */
  poll(deviceCode: string): PollResult {
    this.sweep();
    const key = sha256(deviceCode);
    const e = this.byDevice.get(key);
    if (!e) return { status: 'expired' };
    if (e.state === 'pending') return { status: 'pending' };
    this.remove(key, e);
    return e.state === 'approved' ? { status: 'approved', ...e.grant! } : { status: 'denied' };
  }

  /** The pending pairing behind a user code, for the approval page; null when there is none (or it is decided or expired). */
  view(userCode: string): PendingPairingView | null {
    this.sweep();
    const e = this.pendingByUserCode(userCode);
    if (!e) return null;
    return { ...e.req, userCode: e.userCode, createdAt: new Date(e.createdAt).toISOString(), expiresAt: new Date(e.expiresAt).toISOString() };
  }

  /**
   * Approves a pending pairing. `issue` runs only then: it creates the device and returns its token, which waits in
   * memory for the device's next poll. Returns null when the code is not pending.
   */
  approve(userCode: string, issue: (req: PairingRequest) => PairingGrant): PairingGrant | null {
    this.sweep();
    const e = this.pendingByUserCode(userCode);
    if (!e) return null;
    e.grant = issue(e.req);
    e.state = 'approved';
    return e.grant;
  }

  deny(userCode: string): boolean {
    this.sweep();
    const e = this.pendingByUserCode(userCode);
    if (!e) return false;
    e.state = 'denied';
    return true;
  }

  pendingCount(): number {
    this.sweep();
    return [...this.byDevice.values()].filter(e => e.state === 'pending').length;
  }

  /** Drops what has expired (and forgets old rate-limit windows). Called by every operation; cheap. */
  sweep(): void {
    const t = this.now();
    for (const [key, e] of this.byDevice) {
      if (e.expiresAt > t) continue;
      this.remove(key, e);
      if (e.state === 'approved' && e.grant) this.opts.onUncollected?.(e.grant.deviceId);
    }
    for (const [ip, times] of this.starts) if (times.every(at => t - at >= 60_000)) this.starts.delete(ip);
  }

  private pendingByUserCode(userCode: string): Entry | null {
    const key = this.byUser.get(userCode.trim().toUpperCase());
    const e = key ? this.byDevice.get(key) : undefined;
    return e && e.state === 'pending' ? e : null;
  }

  private remove(key: string, e: Entry): void {
    this.byDevice.delete(key);
    this.byUser.delete(e.userCode);
  }

  private newUserCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
      const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
      if (!this.byUser.has(userCode)) return userCode;
    }
  }
}
