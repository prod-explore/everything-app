/**
 * Device-code pairing client (ADR 0018, the flow of `gh auth login`): start → show the code and open the approval page →
 * poll until the person approves, denies, or the code expires. The device token comes back exactly once, in the final poll.
 */

export type PairingFailure = 'denied' | 'expired' | 'aborted' | 'rejected' | 'network';

export class PairingError extends Error {
  constructor(public readonly reason: PairingFailure, message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

export interface PairingRequest {
  server: string;
  name: string;
  platform: 'windows' | 'macos' | 'linux';
  agentVersion: string;
}

export interface PairingCode {
  userCode: string;
  /** Absolute URL of the approval page, `<server>/devices/pair?code=XXXX-XXXX`. */
  url: string;
}

export interface PairingResult {
  deviceId: string;
  deviceToken: string;
  connectionName: string;
}

export interface PairingOptions {
  request: PairingRequest;
  /** Called once with the code to show; the caller opens the URL (the tray, or the headless CLI printing it). */
  onCode: (code: PairingCode) => void | Promise<void>;
  signal?: AbortSignal;
  /** Seams for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface StartResponse {
  deviceCode: string;
  userCode: string;
  verificationPath: string;
  expiresIn: number;
  interval: number;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** `<server>/<path>`, keeping any path prefix the server is mounted under (https://host/evvapp). */
export function endpoint(server: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), server.endsWith('/') ? server : `${server}/`).toString();
}

async function postJson(f: typeof fetch, url: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
  } catch {
    /* non-JSON body (a proxy error page): the status tells enough */
  }
  return { status: res.status, json };
}

export async function pairDevice(opts: PairingOptions): Promise<PairingResult> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const { server } = opts.request;
  const aborted = (): PairingError => new PairingError('aborted', 'pairing cancelled');

  let start: StartResponse;
  try {
    const res = await postJson(
      f,
      endpoint(server, 'api/devices/pair/start'),
      { name: opts.request.name, platform: opts.request.platform, agentVersion: opts.request.agentVersion },
      opts.signal,
    );
    if (res.status === 429) throw new PairingError('rejected', 'the server is rate-limiting pairings — wait a minute and try again');
    if (res.status !== 200 || typeof res.json['deviceCode'] !== 'string' || typeof res.json['userCode'] !== 'string') {
      const detail = typeof res.json['error'] === 'string' ? `: ${res.json['error']}` : '';
      throw new PairingError('rejected', `the server refused to start pairing (HTTP ${res.status}${detail})`);
    }
    start = res.json as unknown as StartResponse;
  } catch (err) {
    if (err instanceof PairingError) throw err;
    if (opts.signal?.aborted) throw aborted();
    throw new PairingError('network', `cannot reach ${server}: ${(err as Error).message}`);
  }

  const deadline = now() + Math.max(1, Number(start.expiresIn) || 600) * 1000;
  const intervalMs = Math.max(1000, (Number(start.interval) || 2) * 1000);
  await opts.onCode({ userCode: start.userCode, url: endpoint(server, start.verificationPath) });

  let failures = 0;
  while (now() < deadline) {
    await sleep(intervalMs, opts.signal);
    if (opts.signal?.aborted) throw aborted();
    try {
      const res = await postJson(f, endpoint(server, 'api/devices/pair/poll'), { deviceCode: start.deviceCode }, opts.signal);
      failures = 0;
      if (res.status === 410) {
        throw res.json['status'] === 'denied'
          ? new PairingError('denied', 'pairing was denied')
          : new PairingError('expired', 'the pairing code expired — start again');
      }
      if (res.status === 200 && res.json['status'] === 'approved') {
        const { deviceId, deviceToken, connectionName } = res.json;
        if (typeof deviceId !== 'string' || typeof deviceToken !== 'string') {
          throw new PairingError('rejected', 'the server approved the pairing but sent no token');
        }
        return { deviceId, deviceToken, connectionName: typeof connectionName === 'string' ? connectionName : '' };
      }
      if (res.status === 429) await sleep(intervalMs, opts.signal); // slow down, keep waiting
      else if (res.status === 404) {
        // The server answers 410 for a pairing it does not know (also after a restart), so a 404 means this address
        // has no pairing endpoint (wrong URL, or a server without the device bridge) — waiting longer cannot help.
        throw new PairingError('expired', 'the server has no pairing to poll at this address (wrong server URL?) — start again');
      }
    } catch (err) {
      if (err instanceof PairingError) throw err;
      if (opts.signal?.aborted) throw aborted();
      // A dropped connection while the person is still reading the code is not the end of pairing; give up after a streak.
      if (++failures >= 10) throw new PairingError('network', `lost contact with ${server}: ${(err as Error).message}`);
    }
  }
  throw new PairingError('expired', 'the pairing code expired — start again');
}
