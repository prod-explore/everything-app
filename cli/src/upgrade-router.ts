import type * as http from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * One owner of the server's `upgrade` event. An HTTP server hands every WebSocket handshake to its `upgrade` listeners,
 * and each listener sees every path: with two of them, each would have to ignore the other's paths yet someone has to
 * close a handshake that nobody wants. This router is that one listener — it sends a handshake to the handler
 * registered for its exact path and destroys the connection of any other path (the server has no other WebSocket
 * endpoints, and an unanswered upgrade would otherwise hang a socket).
 *
 * Endpoints: `/api/liveview` (browser live view relay, liveview-proxy.ts) and `/api/devices/connect` (device bridge,
 * devices/hub.ts). Authentication is each handler's own business: the two accept different credentials.
 */

export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;

export function attachUpgradeRouter(server: http.Server, routes: Readonly<Record<string, UpgradeHandler>>): void {
  server.on('upgrade', (req, socket, head) => {
    // A client that resets the connection before the handshake finishes must not become an uncaught 'error' event.
    socket.on('error', () => socket.destroy());
    let pathname: string;
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { socket.destroy(); return; }
    const handler = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
    if (!handler) { socket.destroy(); return; }
    handler(req, socket, head);
  });
}
