import { lstat, open, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as nodePath from 'node:path';
import type { DevicePlatform } from '../detect.js';

/**
 * Is a Chromium-family browser already running on this profile directory? Launching a second instance on it does not
 * fail cleanly — Chromium hands the request to the running process and the automation connection never comes — so the
 * agent checks first and says what to do (ADR 0020).
 *
 * Linux/macOS: the running browser keeps `SingletonLock`, a symlink whose target is `<hostname>-<pid>`. A crash leaves a
 * stale one behind (Chromium itself cleans it up), so a link to a dead pid on this host does not count.
 * Windows: the browser holds `lockfile` open without sharing; opening it for reading fails with EBUSY/EPERM/EACCES while it runs.
 */
export async function profileInUse(userDataDir: string, platform: DevicePlatform): Promise<boolean> {
  if (platform === 'windows') {
    const lockfile = nodePath.win32.join(userDataDir, 'lockfile');
    try {
      const fh = await open(lockfile, 'r');
      await fh.close();
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
  }
  const lock = nodePath.join(userDataDir, 'SingletonLock');
  if (!(await lstat(lock).then(() => true, () => false))) return false;
  const target = await readlink(lock).catch(() => null);
  const m = target ? /^(.*)-(\d+)$/.exec(target) : null;
  if (!m) return true; // a lock in a shape we do not know: believe it
  if (m[1] !== hostname()) return true; // a profile on a shared/synced folder, locked by another machine
  try {
    process.kill(Number(m[2]), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = exists, owned by someone else
  }
}
