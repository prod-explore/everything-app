/**
 * The consent a person gave, in one chat, to let it drive their PERSONAL browser profile on one device (ADR 0019/0020).
 *
 * Consent is asked once per browser session, not per call: after "Allow", further `browser_open` / `browser_tabs` calls of
 * that chat on that device go through without a card. It therefore has to end when the session does, or the server would keep
 * waving through calls that now open a brand-new session in the user's logged-in browser. It ends when
 *  - the model calls `browser_close`, or opens the dedicated profile instead (the loop revokes),
 *  - the device goes offline (`retainDevices`),
 *  - the device says the session is over (`browser_session_closed` notification: idle timeout, window closed, ...),
 *  - the chat has not used the device's browser for `ttlMs` — the safety net for an agent that is too old to send the
 *    notification, or for a notification that was lost with a dropped connection. The device closes an idle session after
 *    30 minutes, so the default is a little shorter than that.
 *
 * Every use of the device's browser by the chat refreshes the clock (`touch`), as it refreshes the device's own.
 */

/** The idle limit of a browser session on the device (playwright-mcp's default; the device agent has no setting for it). */
export const DEVICE_BROWSER_IDLE_MS = 30 * 60_000;
/** How much sooner than the device the server lets go, so that it never trusts a session the device has just closed. */
const SAFETY_MARGIN_MS = 5 * 60_000;
export const DEFAULT_PERSONAL_GRANT_IDLE_MINUTES = (DEVICE_BROWSER_IDLE_MS - SAFETY_MARGIN_MS) / 60_000;
const MAX_IDLE_MINUTES = 24 * 60;

/**
 * DEVICE_PERSONAL_BROWSER_IDLE_MINUTES: minutes without browser use after which a chat's consent for a device's personal
 * browser profile lapses and is asked for again. Unset = 25, 0 = no idle limit (only the device's own signal, `browser_close`
 * and the device going offline end it); anything that is not a whole number from 0 to 1440 = the default.
 */
export function personalGrantIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['DEVICE_PERSONAL_BROWSER_IDLE_MINUTES'] ?? '').trim();
  if (raw === '') return DEFAULT_PERSONAL_GRANT_IDLE_MINUTES * 60_000;
  const n = Number(raw);
  return (Number.isInteger(n) && n >= 0 && n <= MAX_IDLE_MINUTES ? n : DEFAULT_PERSONAL_GRANT_IDLE_MINUTES) * 60_000;
}

export interface PersonalGrantsOptions {
  /** Idle time after which a grant lapses; 0 or less = never. */
  ttlMs: number;
  now?: () => number;
}

export class PersonalBrowserGrants {
  private readonly lastUsed = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: PersonalGrantsOptions) {
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /** `(conversation, device connection)` → the key a grant lives under. A conversation-less call is the empty id. */
  static key(conversationId: string | null | undefined, connectionName: string): string {
    return `${conversationId ?? ''}:${connectionName}`;
  }

  private expired(at: number): boolean {
    return this.ttlMs > 0 && this.now() - at >= this.ttlMs;
  }

  /** Is there a live grant? A lapsed one is dropped on the way. */
  has(key: string): boolean {
    const at = this.lastUsed.get(key);
    if (at === undefined) return false;
    if (this.expired(at)) {
      this.lastUsed.delete(key);
      return false;
    }
    return true;
  }

  /** The person (or the policy) allowed the personal profile now: starts or renews the grant. */
  grant(key: string): void {
    this.prune();
    this.lastUsed.set(key, this.now());
  }

  /** The chat used the device's browser: renews a live grant. Does nothing for a missing or lapsed one — use never creates consent. */
  touch(key: string): void {
    if (this.has(key)) this.lastUsed.set(key, this.now());
  }

  /** Ends one grant. True when there was one. */
  revoke(key: string): boolean {
    return this.lastUsed.delete(key);
  }

  /** Ends the grants of all chats on a device (it went offline). Returns how many there were. */
  revokeDevice(connectionName: string): number {
    let n = 0;
    for (const key of [...this.lastUsed.keys()]) {
      if (key.slice(key.indexOf(':') + 1) === connectionName) {
        this.lastUsed.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Ends the grants of every device that is not in `online` (connection names). */
  retainDevices(online: ReadonlySet<string>): void {
    for (const key of [...this.lastUsed.keys()]) {
      if (!online.has(key.slice(key.indexOf(':') + 1))) this.lastUsed.delete(key);
    }
  }

  get size(): number {
    this.prune();
    return this.lastUsed.size;
  }

  private prune(): void {
    for (const [key, at] of this.lastUsed) if (this.expired(at)) this.lastUsed.delete(key);
  }
}
