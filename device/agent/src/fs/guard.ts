import { realpath as realpathCb } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';
import { expandHome } from '../config.js';

/**
 * Path containment for the file tools (ADR 0019): the folders in `files.roots` are the ceiling, resolved with `realpath`
 * so that `..` tricks and symlinks cannot lead out of them.
 *
 * Every tool works on the RESOLVED path this returns, never on the one the model wrote, so a link swapped in after the
 * check cannot redirect an operation made through the original name (a narrow race remains between check and open — the
 * price of path-based APIs; the dangerous cases, a link already in place at check time, are all closed).
 */

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

export interface Resolved {
  /** Canonical absolute path; for a target that does not exist yet, the canonical parent plus the missing tail. */
  path: string;
  /** The root it lies in (canonical). */
  root: string;
  exists: boolean;
}

const win = process.platform === 'win32';

/** Git Bash style `/c/Users/x` → `C:\Users\x` (models copy paths out of a bash shell). */
function fromMsysPath(p: string): string {
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : p;
}

function inside(root: string, target: string): boolean {
  const a = win ? root.toLowerCase() : root;
  const b = win ? target.toLowerCase() : target;
  const rel = nodePath.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
}

/** `realpath.native`: resolves symlinks AND returns the on-disk casing (matters on case-insensitive volumes). */
function canonical(p: string): Promise<string> {
  return new Promise((resolve, reject) => realpathCb.native(p, (err, out) => (err ? reject(err) : resolve(out))));
}

export class PathGuard {
  private canonicalRoots: Promise<string[]> | null = null;

  constructor(
    readonly roots: readonly string[],
    private readonly home: string = homedir(),
  ) {}

  /** Canonical roots; a root that does not exist (yet) is left out, which refuses everything under it. */
  private async realRoots(): Promise<string[]> {
    this.canonicalRoots ??= Promise.all(this.roots.map(r => canonical(r).catch(() => null))).then(rs => rs.filter((r): r is string => !!r));
    return this.canonicalRoots;
  }

  /** Forget cached roots (a folder may have been created since). */
  refresh(): void {
    this.canonicalRoots = null;
  }

  /** The absolute, normalised form of what the model wrote: relative → under the first root. */
  private lexical(input: string): string {
    let p = input.trim();
    if (!p) throw new PathError('path is empty');
    if (p.includes('\0')) throw new PathError('path contains a NUL byte');
    p = expandHome(p, this.home);
    if (win) p = fromMsysPath(p);
    return nodePath.isAbsolute(p) ? nodePath.resolve(p) : nodePath.resolve(this.roots[0] ?? '.', p);
  }

  async resolve(input: string): Promise<Resolved> {
    if (this.roots.length === 0) throw new PathError('no folders are shared on this device');
    const lexical = this.lexical(input);
    const roots = await this.realRoots();
    const outside = (): PathError =>
      new PathError(`"${input}" is outside the folders this device shares (${this.roots.join(', ')}); symlinks that lead out of them are refused too`);

    let existing = lexical;
    const missing: string[] = [];
    let real: string | null = null;
    for (;;) {
      try {
        real = await canonical(existing);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new PathError(`cannot access "${input}": ${(err as Error).message}`);
      }
      // realpath failed with ENOENT. If something is there anyway it is a dangling symlink — whose target could be outside
      // and would be created by a write. Refuse rather than guess.
      if (await lstat(existing).then(() => true, () => false)) {
        throw new PathError(`"${input}" is a symlink whose target does not exist; refused`);
      }
      const parent = nodePath.dirname(existing);
      if (parent === existing) throw new PathError(`cannot resolve "${input}"`);
      missing.unshift(nodePath.basename(existing));
      existing = parent;
    }
    const target = missing.length ? nodePath.join(real, ...missing) : real;
    const root = roots.find(r => inside(r, target));
    if (!root) throw outside();
    return { path: target, root, exists: missing.length === 0 };
  }
}
