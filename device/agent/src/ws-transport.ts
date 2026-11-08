import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type WebSocket from 'ws';

/**
 * MCP transport over one WebSocket: one JSON-RPC message per TEXT frame, 16 MiB at most per frame. The server has the
 * mirror image (`cli/src/devices/ws-transport.ts`); the two stay ~60 lines each, with no shared package between two
 * deployables (ADR 0017).
 *
 * The socket is created and owned by the caller (the connection dials it and decides about reconnects); the transport
 * only frames messages and reports the socket closing as the MCP session ending.
 */

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class WebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  private closed = false;

  /** Frames that arrived before start(): the server speaks first, and its `initialize` can share a read with the 101. */
  private early: Array<{ data: WebSocket.RawData; isBinary: boolean }> | null = [];

  constructor(private readonly socket: WebSocket) {
    // Listening from construction (not from start()) so that nothing the peer sends right after the upgrade is lost.
    socket.on('message', (data, isBinary) => {
      if (this.early) this.early.push({ data, isBinary });
      else this.receive(data, isBinary);
    });
    socket.on('error', err => this.onerror?.(err));
    socket.on('close', () => this.finish());
  }

  async start(): Promise<void> {
    const early = this.early ?? [];
    this.early = null;
    for (const f of early) this.receive(f.data, f.isBinary);
  }

  private receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      // The protocol is text-only: a binary frame is a peer that is not speaking it. Drop it, keep the session.
      this.onerror?.(new Error('binary frame ignored: the device protocol is text-only'));
      return;
    }
    try {
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
      this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(text)));
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      throw new Error(`message of ${Buffer.byteLength(text)} bytes exceeds the ${MAX_FRAME_BYTES}-byte frame limit`);
    }
    if (this.socket.readyState !== this.socket.OPEN) throw new Error('device connection is not open');
    await new Promise<void>((resolve, reject) => this.socket.send(text, { binary: false }, err => (err ? reject(err) : resolve())));
  }

  async close(): Promise<void> {
    if (!this.closed && (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING)) {
      this.socket.close(1000, 'closing');
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
