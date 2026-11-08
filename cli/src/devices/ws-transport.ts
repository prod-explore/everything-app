import type { RawData, WebSocket } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP over a WebSocket, as the device bridge uses it (ADR 0017): one JSON-RPC message per text frame. The device agent
 * has the mirror image (device/agent/src/ws-transport.ts) — two deployables, no shared package.
 *
 * Strict on purpose: a binary frame or a frame over 16 MiB is not something a well-behaved peer sends, so the socket is
 * closed (1003 / 1009) instead of the frame being skipped, and a frame that is not a JSON-RPC message closes it with 1007.
 * Closing is the transport's only way to say "no" — MCP has no reply to a message that is not a message.
 */

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const OPEN = 1; // WebSocket.OPEN, without importing the value (the type import keeps this file free of the library at load time)

function sizeOf(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data.toString('utf8');
}

export class WsTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private started = false;
  private closedNotified = false;

  constructor(private readonly ws: WebSocket) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('WsTransport already started');
    this.started = true;
    const { ws } = this;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.refuse(1003, 'text frames only', new Error('binary frame received'));
      if (sizeOf(data) > MAX_FRAME_BYTES) return this.refuse(1009, 'frame too large', new Error('frame over the size limit'));
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(textOf(data)));
      } catch (err) {
        return this.refuse(1007, 'not a JSON-RPC message', err instanceof Error ? err : new Error(String(err)));
      }
      this.onmessage?.(message);
    });
    ws.on('error', err => this.onerror?.(err));
    ws.on('close', () => this.notifyClosed());
    if (ws.readyState === 0) {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('WebSocket closed before it opened')));
      });
    } else if (ws.readyState !== OPEN) {
      this.notifyClosed();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== OPEN) throw new Error('WebSocket is not open');
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new Error('message is larger than the 16 MiB frame limit');
    await new Promise<void>((resolve, reject) => this.ws.send(text, err => (err ? reject(err) : resolve())));
  }

  async close(): Promise<void> {
    if (this.ws.readyState === OPEN || this.ws.readyState === 0) this.ws.close(1000);
  }

  private refuse(code: number, reason: string, error: Error): void {
    this.onerror?.(error);
    if (this.ws.readyState === OPEN) this.ws.close(code, reason);
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }
}
