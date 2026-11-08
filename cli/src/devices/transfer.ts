import type * as Llm from '../llm-types.js';
import type { VirtualTool } from '../llm-loop.js';
import type { SandboxExec } from '../supervisor-client.js';
import { resolveWorkspacePath, writeWorkspaceBytes } from '../workspace-write.js';
import type { DeviceHub } from './hub.js';
import type { DeviceStore } from './store.js';

/**
 * `device_transfer`: copies one file between a device and the chat's sandbox workspace (or between two devices), through
 * the device's internal `_fs_read_b64` / `_fs_write_b64` tools and the workspace write path. The model cannot call the
 * internal tools itself; this is the one door.
 *
 * Approval (ADR 0019 / 0010): putting a file ONTO a device is a file write there and follows that device's `filesWrite`
 * level; into the workspace needs none. A fixed yes/no would either ask for every transfer (a download into the workspace
 * is harmless) or for none (an upload onto a device that asks for file writes would slip through), so
 * `VirtualTool.requiresApproval` is a function of the call here, and `approvalLabel` scopes the grant to the target
 * device (`device-pc/device_transfer`): "always" for the desktop never covers the laptop and revoking a device deletes it.
 * The decision therefore rides the loop's ordinary gate — unattended runs, Gazeta cards, notifications and audit all work.
 */

/**
 * The most one transfer moves. The wire carries a file as base64 inside one JSON-RPC frame and a frame is limited to
 * 16 MiB (docs/devices.md), so 12 MB of file (16 MB of base64) is the largest that fits; a 25 MB file would be 33 MB of
 * base64, which could never be sent in one frame. A device must refuse bigger files in `_fs_read_b64`.
 */
export const TRANSFER_MAX_BYTES = 12_000_000;

export type Endpoint =
  | { kind: 'workspace'; path: string }
  | { kind: 'device'; connection: string; path: string };

/** `workspace:out/report.pdf` or `device-pc:C:\Users\me\file.txt` (the first colon separates the place from the path). */
export function parseEndpoint(raw: unknown): Endpoint | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'expected "workspace:<path>" or "device-<name>:<path>"' };
  const i = raw.indexOf(':');
  const place = i < 0 ? '' : raw.slice(0, i);
  const path = i < 0 ? '' : raw.slice(i + 1);
  if (!path.trim()) return { error: `"${raw}" has no path — write "workspace:<path>" or "device-<name>:<path>"` };
  if (place === 'workspace') return { kind: 'workspace', path };
  if (/^device-[a-z0-9-]{1,24}$/.test(place)) return { kind: 'device', connection: place, path };
  return { error: `unknown place "${place}" in "${raw}" — use "workspace" or a device connection name such as device-pc` };
}

export const deviceTransferDefinition = (online: readonly string[]): Llm.Tool => ({
  name: 'device_transfer',
  description:
    'Copy a file between a connected device and this chat\'s workspace (or between two devices). `from` and `to` are each ' +
    '"workspace:<path>" or "<device>:<path>", e.g. from "device-pc:C:\\\\Users\\\\me\\\\report.pdf" to "workspace:inbox/report.pdf". ' +
    'If `to` ends with a slash the file keeps its name. Works for any file type up to 12 MB. ' +
    'Copying onto a device may ask the user for approval; into the workspace it does not. A file that already exists on a device is only replaced with overwrite=true. ' +
    `Devices online now: ${online.join(', ') || 'none'}.`,
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source: "workspace:<path>" or "device-<name>:<path>".' },
      to: { type: 'string', description: 'Destination: "workspace:<path>" or "device-<name>:<path>".' },
      overwrite: { type: 'boolean', description: 'Replace an existing file on the destination device. Default false.' },
    },
    required: ['from', 'to'],
  },
});

export interface TransferDeps {
  hub: DeviceHub;
  store: DeviceStore;
  /** Workspace owner of the chat (its project, else the chat). */
  owner: string;
  sandbox: SandboxExec;
  readFile: (owner: string, path: string) => Promise<Buffer>;
  /** After a successful copy, for the audit log. */
  onTransfer?: (info: { from: string; to: string; bytes: number }) => void;
}

const err = (text: string) => ({ text, isError: true as const });
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** The tool, or nothing: it is offered only while a device is online (no device, nothing to copy to or from). */
export function deviceTransferTools(deps: TransferDeps): VirtualTool[] {
  const online = deps.hub.list().map(d => d.connectionName);
  if (online.length === 0) return [];

  const rowOf = (connection: string) => deps.store.getBySlug(connection.slice('device-'.length));

  /**
   * Why a device end cannot take part, or null. Checked from the device's own report (its ceiling, ADR 0019) before any
   * approval is asked: a card for a copy the device would refuse anyway is a click for nothing.
   */
  const refusal = (connection: string, role: 'from' | 'to'): string | null => {
    const row = rowOf(connection);
    const files = row?.report?.files;
    const name = row?.name ?? connection;
    if (!files?.enabled) return `Files are switched off on ${name}. They can be switched on in the device's tray app (Files).`;
    if (role === 'to' && !files.write) return `${name} shares its folders read-only, so nothing can be copied onto it. Write access is set in the device's tray app.`;
    return null;
  };

  /** Does this call put a file onto a device whose `filesWrite` level asks? */
  const targetAsks = (input: Record<string, unknown>): boolean => {
    const to = parseEndpoint(input['to']);
    if ('error' in to || to.kind !== 'device') return false;
    if (refusal(to.connection, 'to')) return false; // refused in the handler without a card
    const row = rowOf(to.connection);
    return row === null || row.policy.filesWrite === 'ask'; // an unknown device fails in the handler; asking first is harmless
  };

  return [{
    definition: deviceTransferDefinition(online),
    requiresApproval: targetAsks,
    approvalLabel: input => {
      const to = parseEndpoint(input['to']);
      return !('error' in to) && to.kind === 'device' ? `${to.connection}/device_transfer` : 'device_transfer';
    },
    handler: async input => {
      const from = parseEndpoint(input['from']);
      const to = parseEndpoint(input['to']);
      if ('error' in from) return err(`from: ${from.error}`);
      if ('error' in to) return err(`to: ${to.error}`);
      if (from.kind === 'workspace' && to.kind === 'workspace') return err('Both ends are the workspace — use a shell command to copy inside it.');
      for (const [e, role] of [[from, 'from'], [to, 'to']] as const) {
        if (e.kind !== 'device') continue;
        if (!deps.hub.get(e.connection)) return err(`${e.connection} is not online right now.`);
        const why = refusal(e.connection, role);
        if (why) return err(why);
      }

      // Read.
      let data: Buffer;
      let name: string;
      try {
        if (from.kind === 'workspace') {
          const path = resolveWorkspacePath(from.path);
          data = await deps.readFile(deps.owner, path);
          name = baseName(path);
        } else {
          const r = await deps.hub.get(from.connection)!.callInternal('_fs_read_b64', { path: from.path });
          if (typeof r['base64'] !== 'string') return err(`${from.connection} did not return the file.`);
          data = Buffer.from(r['base64'], 'base64');
          name = typeof r['name'] === 'string' && r['name'] ? r['name'] : baseName(from.path);
          if (typeof r['size'] === 'number' && r['size'] !== data.length) return err(`The file arrived damaged (${data.length} bytes instead of ${r['size']}). Nothing was written.`);
        }
      } catch (e) {
        return err(`Could not read ${input['from']}: ${(e as Error).message}`);
      }
      if (data.length > TRANSFER_MAX_BYTES) return err(`The file is ${(data.length / 1e6).toFixed(1)} MB; a transfer carries at most ${TRANSFER_MAX_BYTES / 1e6} MB. Split or compress it first.`);

      // Write.
      const target = /[\\/]$/.test(to.path) ? `${to.path}${name}` : to.path;
      try {
        if (to.kind === 'workspace') {
          const r = await writeWorkspaceBytes(deps.sandbox, deps.owner, target, data);
          deps.onTransfer?.({ from: String(input['from']), to: `workspace:${r.path}`, bytes: r.bytes });
          return { text: `Copied ${r.bytes} bytes to workspace:${r.path}.` };
        }
        await deps.hub.get(to.connection)!.callInternal('_fs_write_b64', { path: target, base64: data.toString('base64'), overwrite: input['overwrite'] === true });
        deps.onTransfer?.({ from: String(input['from']), to: `${to.connection}:${target}`, bytes: data.length });
        return { text: `Copied ${data.length} bytes to ${to.connection}:${target}.` };
      } catch (e) {
        return err(`Could not write ${to.kind === 'workspace' ? 'workspace:' : `${to.connection}:`}${target}: ${(e as Error).message}`);
      }
    },
  }];
}
