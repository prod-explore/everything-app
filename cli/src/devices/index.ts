import type * as express from 'express';
import type Database from 'better-sqlite3';
import type { CommandScopeResolver } from '../web-approval.js';
import type { ToolRegistry } from '../tool-registry.js';
import { DeviceHub, type HubOptions } from './hub.js';
import { PairingManager, type PairingOptions } from './pairing.js';
import { createDeviceRoutes } from './routes.js';
import { DeviceStore, migrateDevices } from './store.js';
import { deviceTransferTools, type TransferDeps } from './transfer.js';

/**
 * The device bridge as the rest of the server sees it: build it once, mount `routes`, register `hub.handleUpgrade` for
 * `CONNECT_PATH`, hand `commandScope` to the approval gate, and ask `transferTools` for the per-chat virtual tool.
 */

export interface DeviceServiceOptions {
  db: Database.Database;
  registry: ToolRegistry;
  onChange?: (deviceId: string) => void;
  hub?: Partial<Pick<HubOptions, 'pingIntervalMs' | 'deadAfterMs' | 'initTimeoutMs' | 'log'>>;
  pairing?: PairingOptions;
}

export interface DeviceService {
  store: DeviceStore;
  hub: DeviceHub;
  pairing: PairingManager;
  routes: { public: express.Router; api: express.Router };
  /** For `WebApprovalGate.setCommandScopeResolver`. */
  commandScope: CommandScopeResolver;
  /** `device_transfer`, or nothing while no device is online. */
  transferTools: (deps: Omit<TransferDeps, 'hub' | 'store'>) => ReturnType<typeof deviceTransferTools>;
}

export function createDeviceService(opts: DeviceServiceOptions): DeviceService {
  migrateDevices(opts.db);
  const store = new DeviceStore(opts.db);
  const hub = new DeviceHub({ store, registry: opts.registry, onChange: opts.onChange, ...opts.hub });
  const pairing = new PairingManager({
    ...opts.pairing,
    // An approval whose token was never collected leaves a device that can never connect: remove it, unless it did connect somehow.
    onUncollected: id => {
      const row = store.get(id);
      if (row && row.lastSeenAt === null) { store.delete(id); opts.onChange?.(id); }
      opts.pairing?.onUncollected?.(id);
    },
  });
  const routes = createDeviceRoutes({ db: opts.db, store, hub, registry: opts.registry, pairing, onChange: opts.onChange });

  /**
   * Commands of a device's shell are judged by the device's own level (ADR 0019), not by a project's policy, and their
   * grants live in the device's namespace. PowerShell is not parsed by the command policy, so `allowlist` — which relies
   * on recognising read-only commands — becomes `strict` for it; so it does for a device that sent no usable report,
   * and an unknown device (revoked while a call was pending) is strict too.
   */
  const commandScope: CommandScopeResolver = toolLabel => {
    const server = toolLabel.split('/')[0] ?? '';
    if (!server.startsWith('device-')) return null;
    const row = store.getBySlug(server.slice('device-'.length));
    const level = row?.policy.shell ?? 'strict';
    const posix = row?.report?.shell.kind === 'posix';
    return { namespace: server, mode: level === 'allowlist' && !posix ? 'strict' : level };
  };

  return { store, hub, pairing, routes, commandScope, transferTools: deps => deviceTransferTools({ ...deps, hub, store }) };
}

export { CONNECT_PATH } from './types.js';
