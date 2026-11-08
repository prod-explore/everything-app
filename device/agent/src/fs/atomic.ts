import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

/**
 * Atomic file writes: the data goes to a temporary file in the same directory and is renamed over the target, so a reader
 * (or a crash) never sees half a file. An existing file keeps its permission bits. `path` must already be resolved by
 * PathGuard — this module trusts it.
 */
export async function atomicWrite(path: string, data: string | Buffer, opts: { overwrite?: boolean } = {}): Promise<{ created: boolean }> {
  const overwrite = opts.overwrite ?? true;
  const existing = await lstat(path).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`"${path}" is a directory`);
  if (existing && !overwrite) throw new Error(`"${path}" already exists (pass overwrite: true to replace it)`);
  await mkdir(nodePath.dirname(path), { recursive: true });
  const mode = existing ? existing.mode & 0o7777 : 0o644;
  const tmp = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.evv-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, { flag: 'wx', mode });
    await chmod(tmp, mode).catch(() => {}); // umask must not narrow the mode of a file we replace
    if (overwrite) await rename(tmp, path);
    else {
      // Exclusive create: a hard link fails with EEXIST if something appeared since the check above; where links are
      // unavailable (FAT, some network shares) fall back to a plain rename.
      try {
        await link(tmp, path);
        await unlink(tmp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`"${path}" already exists (pass overwrite: true to replace it)`);
        await rename(tmp, path);
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { created: !existing };
}
