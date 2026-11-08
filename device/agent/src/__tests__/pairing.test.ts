import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { endpoint, pairDevice, PairingError, type PairingOptions } from '../pairing.js';

type Handler = (body: Record<string, unknown>, res: http.ServerResponse, req: http.IncomingMessage) => void;

describe('pairing client against a fake server', () => {
  let server: http.Server;
  let base: string;
  const handlers = new Map<string, Handler>();
  const seen: Array<{ path: string; body: Record<string, unknown>; method?: string }> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        seen.push({ path: req.url!, body, ...(req.method ? { method: req.method } : {}) });
        // Look the handler up explicitly and only call something that really is a function: an unknown
        // path (whatever the client sent as req.url) answers 404 instead of being invoked blindly.
        const h = handlers.get(req.url ?? '');
        if (typeof h !== 'function') {
          res.writeHead(404).end();
          return;
        }
        h(body, res, req);
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>(r => server.close(() => r())));

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const startOk: Handler = (_b, res) =>
    json(res, 200, { deviceCode: 'DEV-CODE', userCode: 'ABCD-2345', verificationPath: '/devices/pair?code=ABCD-2345', expiresIn: 600, interval: 2 });
  const instant = async (): Promise<void> => {};

  function opts(extra: Partial<PairingOptions> = {}, codes: Array<{ userCode: string; url: string }> = []): PairingOptions {
    return {
      request: { server: base, name: 'PC', platform: 'linux', agentVersion: '0.1.0' },
      onCode: c => void codes.push(c),
      sleep: instant,
      ...extra,
    };
  }

  it('start → shows the code → polls until approved, sending the contract bodies', async () => {
    seen.length = 0;
    handlers.set('/api/devices/pair/start', startOk);
    let polls = 0;
    handlers.set('/api/devices/pair/poll', (_b, res) => {
      polls++;
      if (polls < 3) return json(res, 200, { status: 'pending' });
      json(res, 200, { status: 'approved', deviceId: '0123456789abcdef', deviceToken: 'TOKEN', connectionName: 'device-pc' });
    });
    const codes: Array<{ userCode: string; url: string }> = [];
    const result = await pairDevice(opts({}, codes));
    assert.deepEqual(result, { deviceId: '0123456789abcdef', deviceToken: 'TOKEN', connectionName: 'device-pc' });
    assert.deepEqual(codes, [{ userCode: 'ABCD-2345', url: `${base}/devices/pair?code=ABCD-2345` }]);
    assert.equal(polls, 3);
    assert.deepEqual(seen[0], { path: '/api/devices/pair/start', body: { name: 'PC', platform: 'linux', agentVersion: '0.1.0' }, method: 'POST' });
    assert.deepEqual(seen[1]!.body, { deviceCode: 'DEV-CODE' });
  });

  it('honours the poll interval from the server (at least one second)', async () => {
    handlers.set('/api/devices/pair/start', startOk);
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 200, { status: 'approved', deviceId: 'i', deviceToken: 't', connectionName: 'c' }));
    const waits: number[] = [];
    await pairDevice(opts({ sleep: async ms => void waits.push(ms) }));
    assert.deepEqual(waits, [2000]);
  });

  it('denied and expired are distinct outcomes', async () => {
    handlers.set('/api/devices/pair/start', startOk);
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 410, { status: 'denied' }));
    await assert.rejects(pairDevice(opts()), (e: PairingError) => e.reason === 'denied');
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 410, { status: 'expired' }));
    await assert.rejects(pairDevice(opts()), (e: PairingError) => e.reason === 'expired');
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 404, {}));
    await assert.rejects(pairDevice(opts()), (e: PairingError) => e.reason === 'expired');
  });

  it('gives up when the code lifetime passes', async () => {
    handlers.set('/api/devices/pair/start', startOk);
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 200, { status: 'pending' }));
    let t = 0;
    await assert.rejects(
      pairDevice(opts({ now: () => (t += 200_000) })),
      (e: PairingError) => e.reason === 'expired',
    );
  });

  it('a refused start (429, 500) is reported, an unreachable server is a network error', async () => {
    handlers.set('/api/devices/pair/start', (_b, res) => json(res, 429, { error: 'slow down' }));
    await assert.rejects(pairDevice(opts()), (e: PairingError) => e.reason === 'rejected' && /rate-limiting/.test(e.message));
    handlers.set('/api/devices/pair/start', (_b, res) => json(res, 500, { error: 'boom' }));
    await assert.rejects(pairDevice(opts()), /HTTP 500: boom/);
    await assert.rejects(
      pairDevice(opts({ request: { server: 'http://127.0.0.1:1', name: 'PC', platform: 'linux', agentVersion: '0.1.0' } })),
      (e: PairingError) => e.reason === 'network',
    );
  });

  it('a dropped connection during polling is retried, not fatal', async () => {
    handlers.set('/api/devices/pair/start', startOk);
    let polls = 0;
    handlers.set('/api/devices/pair/poll', (_b, res, req) => {
      if (++polls === 1) return void req.socket.destroy();
      json(res, 200, { status: 'approved', deviceId: 'i', deviceToken: 't', connectionName: 'c' });
    });
    assert.equal((await pairDevice(opts())).deviceToken, 't');
    assert.equal(polls, 2);
  });

  it('can be cancelled', async () => {
    handlers.set('/api/devices/pair/start', startOk);
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 200, { status: 'pending' }));
    const ac = new AbortController();
    const p = pairDevice(opts({ signal: ac.signal, sleep: async () => ac.abort() }));
    await assert.rejects(p, (e: PairingError) => e.reason === 'aborted');
  });

  it('an approval without a token is an error, not a half-paired device', async () => {
    handlers.set('/api/devices/pair/start', startOk);
    handlers.set('/api/devices/pair/poll', (_b, res) => json(res, 200, { status: 'approved', deviceId: 'x' }));
    await assert.rejects(pairDevice(opts()), /sent no token/);
  });

  it('endpoint() keeps a path prefix the server is mounted under', () => {
    assert.equal(endpoint('https://h.example/evv', 'api/devices/pair/start'), 'https://h.example/evv/api/devices/pair/start');
    assert.equal(endpoint('https://h.example/', '/devices/pair?code=A'), 'https://h.example/devices/pair?code=A');
  });
});
