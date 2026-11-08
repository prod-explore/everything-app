import * as http from 'node:http';
import * as https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { parseIPv4, parseIPv6 } from './web/url-safety.js';

/**
 * SSRF guard for the notification webhook, the one place where the server POSTs to a URL a person typed in.
 *
 * Rules (same address ranges as web_fetch's url-safety.ts, but classified, because a self-hosted owner may
 * legitimately point the webhook at a LAN service such as ntfy on 192.168.x):
 *  - only http(s), no credentials in the URL;
 *  - every address the host resolves to is classified; loopback, link-local (169.254.0.0/16 and fe80::/10, which
 *    includes the cloud metadata address 169.254.169.254), unspecified, multicast/reserved and documentation ranges
 *    are ALWAYS refused. Private (RFC 1918, unique-local), CGNAT/Tailscale ranges are refused unless the operator
 *    opts in with NOTIFY_ALLOW_PRIVATE_NETWORK=true;
 *  - IPv4 inside IPv6 (::ffff:a.b.c.d, ::a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16) is judged as the IPv4 address;
 *  - the check is repeated inside the connection's `lookup`, and the socket connects to exactly the addresses that
 *    lookup returned, so a DNS answer that changes between the check and the connect (rebinding) cannot reach a
 *    forbidden address. Redirects are never followed.
 */

export class WebhookBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookBlockedError';
  }
}

export type AddressClass = 'public' | 'loopback' | 'link-local' | 'unspecified' | 'private' | 'cgnat' | 'reserved';

function classifyV4(b: number[]): AddressClass {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  if (a === 0) return 'unspecified'; // 0.0.0.0/8
  if (a === 127) return 'loopback';
  if (a === 169 && c === 254) return 'link-local';
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168)) return 'private';
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat';
  if (
    (a === 192 && c === 0 && (d === 0 || d === 2)) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && d === 100) ||
    (a === 203 && c === 0 && d === 113) ||
    a >= 224
  ) return 'reserved';
  return 'public';
}

function classifyV6(b: number[]): AddressClass {
  const zero = (from: number, to: number) => b.slice(from, to).every(x => x === 0);
  if (zero(0, 16)) return 'unspecified';
  if (zero(0, 15) && b[15] === 1) return 'loopback';
  if (zero(0, 12)) return classifyV4(b.slice(12)); // IPv4-compatible
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)); // IPv4-mapped
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return classifyV4(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return 'reserved'; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved'; // documentation
  if ((b[0]! & 0xfe) === 0xfc) return 'private'; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local'; // fe80::/10
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return 'reserved'; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return 'reserved'; // multicast
  return 'public';
}

/** Classifies one IP literal. Anything unparseable is 'reserved' (fail closed). */
export function classifyAddress(ip: string): AddressClass {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v = isIP(bare.split('%')[0]!);
  if (v === 4) {
    const b = parseIPv4(bare);
    return b ? classifyV4(b) : 'reserved';
  }
  if (v === 6) {
    const b = parseIPv6(bare);
    return b ? classifyV6(b) : 'reserved';
  }
  return 'reserved';
}

export interface WebhookGuardOptions {
  /** NOTIFY_ALLOW_PRIVATE_NETWORK: also allow RFC 1918, unique-local and CGNAT targets. Loopback and link-local stay blocked. */
  allowPrivateNetwork?: boolean;
  /** Test seam / DNS: must return every address of the host. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

export const allowPrivateFromEnv = (env: NodeJS.ProcessEnv): boolean => /^(1|true|yes|on)$/i.test((env['NOTIFY_ALLOW_PRIVATE_NETWORK'] ?? '').trim());

const defaultResolve = (host: string) =>
  new Promise<LookupAddress[]>((res, rej) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? rej(err) : res(addrs))));

function refusal(host: string, cls: AddressClass, allowPrivate: boolean): string | null {
  switch (cls) {
    case 'public': return null;
    case 'private':
    case 'cgnat':
      return allowPrivate ? null : `"${host}" is on a private network. Set NOTIFY_ALLOW_PRIVATE_NETWORK=true to allow a webhook on your LAN.`;
    case 'loopback': return `"${host}" is a loopback address; a webhook may not target the server itself.`;
    case 'link-local': return `"${host}" is a link-local / cloud-metadata address, which is never allowed.`;
    case 'unspecified': return `"${host}" is an unspecified address.`;
    default: return `"${host}" is a reserved address.`;
  }
}

/** Syntax only: http(s), parseable, no credentials. Returns the parsed URL. */
export function parseWebhookUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new WebhookBlockedError('That is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebhookBlockedError('The webhook URL must start with http:// or https://.');
  if (u.username || u.password) throw new WebhookBlockedError('Put no credentials in the webhook URL (use a secret path or token instead).');
  return u;
}

function hostOf(u: URL): string {
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Throws WebhookBlockedError when any address in `addrs` is not allowed. */
function assertAddresses(host: string, addrs: LookupAddress[], allowPrivate: boolean): void {
  if (addrs.length === 0) throw new WebhookBlockedError(`Could not resolve "${host}".`);
  // ANY forbidden record blocks: a name with a public and a private address is a rebinding setup.
  for (const a of addrs) {
    const msg = refusal(host, classifyAddress(a.address), allowPrivate);
    if (msg) throw new WebhookBlockedError(msg);
  }
}

/** Full check before saving or sending: syntax, then resolves the host and classifies every address. */
export async function assertSafeWebhookTarget(raw: string, opts: WebhookGuardOptions = {}): Promise<URL> {
  const u = parseWebhookUrl(raw);
  const host = hostOf(u);
  const allowPrivate = opts.allowPrivateNetwork === true;
  if (isIP(host)) {
    const msg = refusal(host, classifyAddress(host), allowPrivate);
    if (msg) throw new WebhookBlockedError(msg);
    return u;
  }
  let addrs: LookupAddress[];
  try { addrs = await (opts.resolve ?? defaultResolve)(host); } catch { throw new WebhookBlockedError(`Could not resolve "${host}".`); }
  assertAddresses(host, addrs, allowPrivate);
  return u;
}

type LookupCb = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;

/** A `lookup` for http(s).request that re-validates at connect time and hands the socket only vetted addresses. */
function makeGuardedLookup(opts: WebhookGuardOptions) {
  const resolve = opts.resolve ?? defaultResolve;
  const allowPrivate = opts.allowPrivateNetwork === true;
  return (hostname: string, options: { all?: boolean }, cb: LookupCb): void => {
    resolve(hostname).then(addrs => {
      try { assertAddresses(hostname, addrs, allowPrivate); } catch (e) { return cb(e as Error); }
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0]!.address, addrs[0]!.family);
    }, err => cb(err instanceof Error ? err : new Error(String(err))));
  };
}

export interface GuardedPostResult { status: number }

/**
 * POSTs once to a vetted target. No pooled sockets (so the connect-time check runs for every request), no
 * redirects (a 3xx is returned as a status), response body discarded.
 */
export async function guardedPost(
  rawUrl: string,
  req: { headers: Record<string, string>; body: string },
  opts: WebhookGuardOptions & { timeoutMs?: number } = {},
): Promise<GuardedPostResult> {
  const u = await assertSafeWebhookTarget(rawUrl, opts);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8_000);
  return new Promise<GuardedPostResult>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(u, {
      method: 'POST',
      agent: false,
      lookup: makeGuardedLookup(opts) as never,
      headers: { ...req.headers, 'Content-Length': String(Buffer.byteLength(req.body)) },
      signal,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('error', reject);
    });
    r.on('error', err => reject(signal.aborted ? Object.assign(new Error('timeout'), { name: 'TimeoutError' }) : err));
    r.end(req.body);
  });
}
