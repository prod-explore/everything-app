import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedConfig } from '../config.js';
import { atomicWrite } from '../fs/atomic.js';
import { globToRegExp, matchesGlob } from '../fs/glob.js';
import { PathError, PathGuard } from '../fs/guard.js';
import { applyEdit, registerFileTools } from '../tools/files.js';

const posix = process.platform !== 'win32';

interface Fixture {
  root: string; // canonical
  share: string; // <root>/share — the shared folder
  secret: string; // <root>/outside/secret.txt
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'evv-fs-')));
  const share = nodePath.join(root, 'share');
  const outside = nodePath.join(root, 'outside');
  await mkdir(nodePath.join(share, 'sub', 'deep'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(nodePath.join(outside, 'secret.txt'), 'TOP SECRET');
  await writeFile(nodePath.join(share, 'a.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(nodePath.join(share, 'sub', 'b.ts'), 'export const x = 1;\n// needle here\n');
  await writeFile(nodePath.join(share, 'sub', 'deep', 'c.ts'), 'needle again\n');
  return { root, share, secret: nodePath.join(outside, 'secret.txt') };
}

describe('PathGuard', () => {
  let f: Fixture;
  let guard: PathGuard;
  before(async () => {
    f = await fixture();
    guard = new PathGuard([f.share]);
  });

  it('relative paths start at the first root; absolute paths inside a root are fine', async () => {
    assert.equal((await guard.resolve('a.txt')).path, nodePath.join(f.share, 'a.txt'));
    assert.equal((await guard.resolve(nodePath.join(f.share, 'sub'))).path, nodePath.join(f.share, 'sub'));
    assert.equal((await guard.resolve('.')).path, f.share);
    assert.equal((await guard.resolve('sub/../a.txt')).path, nodePath.join(f.share, 'a.txt'));
  });

  it('refuses paths outside, including .. escapes and sibling-prefix tricks', async () => {
    await assert.rejects(guard.resolve('../outside/secret.txt'), PathError);
    await assert.rejects(guard.resolve(f.secret), /outside the folders/);
    await assert.rejects(guard.resolve('/etc/passwd'), PathError);
    await assert.rejects(guard.resolve('sub/../../outside'), PathError);
    // /…/share-evil must not count as inside /…/share
    await mkdir(`${f.share}-evil`, { recursive: true });
    await assert.rejects(guard.resolve(`${f.share}-evil`), PathError);
  });

  it('a target that does not exist yet resolves through its nearest existing parent', async () => {
    const r = await guard.resolve('sub/new/dir/file.txt');
    assert.equal(r.path, nodePath.join(f.share, 'sub', 'new', 'dir', 'file.txt'));
    assert.equal(r.exists, false);
    await assert.rejects(guard.resolve('../outside/new.txt'), PathError);
  });

  it('rejects empty paths and NUL bytes; no roots means nothing is reachable', async () => {
    await assert.rejects(guard.resolve('  '), /empty/);
    await assert.rejects(guard.resolve('a\0b'), /NUL/);
    await assert.rejects(new PathGuard([]).resolve('x'), /no folders/);
  });

  it('~ expands to the home directory (then must still be inside a root)', async () => {
    await assert.rejects(new PathGuard([f.share], '/home/nobody').resolve('~/x'), PathError);
    const home = new PathGuard([f.share], f.share);
    assert.equal((await home.resolve('~/a.txt')).path, nodePath.join(f.share, 'a.txt'));
  });

  describe('symlinks', { skip: !posix }, () => {
    before(async () => {
      await symlink(nodePath.join(f.root, 'outside'), nodePath.join(f.share, 'link-to-outside'));
      await symlink(f.secret, nodePath.join(f.share, 'link-to-secret'));
      await symlink(nodePath.join(f.share, 'a.txt'), nodePath.join(f.share, 'link-inside'));
      await symlink(nodePath.join(f.root, 'outside', 'not-yet.txt'), nodePath.join(f.share, 'dangling'));
      await symlink('../outside', nodePath.join(f.share, 'sub', 'rel-escape'));
    });

    it('a symlink that leads out of the root is refused, whether directory or file, absolute or relative', async () => {
      await assert.rejects(guard.resolve('link-to-outside'), PathError);
      await assert.rejects(guard.resolve('link-to-outside/secret.txt'), PathError);
      await assert.rejects(guard.resolve('link-to-secret'), PathError);
      await assert.rejects(guard.resolve('sub/rel-escape/secret.txt'), PathError);
    });

    it('a symlink that stays inside is followed, and the resolved target is what comes back', async () => {
      assert.equal((await guard.resolve('link-inside')).path, nodePath.join(f.share, 'a.txt'));
    });

    it('a dangling symlink is refused: writing through it would create a file outside', async () => {
      await assert.rejects(guard.resolve('dangling'), /symlink whose target does not exist/);
      await assert.rejects(guard.resolve('link-to-outside/brand-new.txt'), PathError);
    });

    it('a root that is itself reached through a symlink works (roots are canonicalised)', async () => {
      const viaLink = nodePath.join(f.root, 'root-link');
      await symlink(f.share, viaLink);
      const g = new PathGuard([viaLink]);
      assert.equal((await g.resolve('a.txt')).path, nodePath.join(f.share, 'a.txt'));
      await assert.rejects(g.resolve(f.secret), PathError);
    });
  });
});

describe('glob', () => {
  it('matches names at any depth without a slash, paths with one', () => {
    assert.ok(matchesGlob('*.ts', 'a/b/c.ts'));
    assert.ok(!matchesGlob('*.ts', 'a/b/c.tsx'));
    assert.ok(matchesGlob('src/**/*.test.ts', 'src/x/y/z.test.ts'));
    assert.ok(matchesGlob('src/**/*.test.ts', 'src/z.test.ts'));
    assert.ok(!matchesGlob('src/*.ts', 'src/x/y.ts'));
    assert.ok(matchesGlob('*.{js,mjs}', 'x/y.mjs'));
    assert.ok(matchesGlob('file?.txt', 'file1.txt'));
    assert.ok(matchesGlob('[ab].txt', 'a.txt'));
    assert.ok(!matchesGlob('[!ab].txt', 'a.txt'));
    assert.ok(matchesGlob('a.b', 'a.b') && !matchesGlob('a.b', 'axb'));
    assert.ok(globToRegExp('**').test('x/y/z'));
  });
});

describe('applyEdit (Claude Code Edit semantics)', () => {
  it('replaces a unique match', () => {
    const r = applyEdit('one two three', 'two', '2', false);
    assert.deepEqual(r.ok && [r.text, r.replacements], ['one 2 three', 1]);
  });
  it('refuses a missing match, an ambiguous one, an empty or identical old_string', () => {
    assert.match((applyEdit('abc', 'x', 'y', false) as { error: string }).error, /not found/);
    assert.match((applyEdit('a a', 'a', 'b', false) as { error: string }).error, /occurs 2 times/);
    assert.match((applyEdit('abc', '', 'y', false) as { error: string }).error, /empty/);
    assert.match((applyEdit('abc', 'a', 'a', false) as { error: string }).error, /identical/);
  });
  it('replace_all changes every occurrence', () => {
    const r = applyEdit('a a a', 'a', 'b', true);
    assert.deepEqual(r.ok && [r.text, r.replacements], ['b b b', 3]);
  });
  it('is literal: regex characters and $ patterns in new_string are not interpreted', () => {
    const r = applyEdit('price (1+1) = $x', '(1+1)', '$&$1', false);
    assert.equal(r.ok && r.text, 'price $&$1 = $x');
  });
  it('hints when only whitespace differs', () => {
    assert.match((applyEdit('  indented', '    indented', 'x', false) as { error: string }).error, /whitespace/);
  });
  it('edits a CRLF file with LF text and keeps its line endings', () => {
    const r = applyEdit('a\r\nb\r\nc\r\n', 'a\nb', 'A\nB', false);
    assert.equal(r.ok && r.text, 'A\r\nB\r\nc\r\n');
  });
});

describe('atomicWrite', { skip: !posix }, () => {
  it('keeps the mode of an existing file, leaves no temp file, creates parents', async () => {
    const f = await fixture();
    const file = nodePath.join(f.share, 'script.sh');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    const r = await atomicWrite(file, 'new');
    assert.equal(r.created, false);
    assert.equal((await stat(file)).mode & 0o777, 0o755);
    assert.equal(await readFile(file, 'utf8'), 'new');
    const created = await atomicWrite(nodePath.join(f.share, 'x', 'y', 'z.txt'), 'hi');
    assert.equal(created.created, true);
    assert.deepEqual((await readdir(f.share)).filter(n => n.includes('.evv-')), []);
  });
  it('overwrite: false refuses an existing file and a directory', async () => {
    const f = await fixture();
    await assert.rejects(atomicWrite(nodePath.join(f.share, 'a.txt'), 'x', { overwrite: false }), /already exists/);
    assert.equal(await readFile(nodePath.join(f.share, 'a.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
    await assert.rejects(atomicWrite(nodePath.join(f.share, 'sub'), 'x'), /is a directory/);
  });
});

describe('file tools over MCP', () => {
  async function setup(write: boolean): Promise<{ f: Fixture; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean; raw: { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown> } }>; client: Client }> {
    const f = await fixture();
    const cfg = { deviceName: 'PC', platform: 'linux', files: { enabled: true, roots: [f.share], write }, shell: { enabled: false } } as unknown as ResolvedConfig;
    const server = new McpServer({ name: 't', version: '0' });
    registerFileTools(server, cfg);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const raw = (await client.callTool({ name, arguments: args })) as { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean };
      return { text: raw.content.map(c => String(c['text'] ?? '')).join('\n'), isError: raw.isError === true, raw };
    };
    return { f, call, client };
  }

  it('write tools exist only when files.write is true', async () => {
    const ro = await setup(false);
    assert.deepEqual((await ro.client.listTools()).tools.map(t => t.name).sort(), ['_fs_read_b64', 'fs_list', 'fs_read', 'fs_search']);
    const rw = await setup(true);
    assert.deepEqual((await rw.client.listTools()).tools.map(t => t.name).sort(), ['_fs_read_b64', '_fs_write_b64', 'fs_edit', 'fs_list', 'fs_mkdir', 'fs_read', 'fs_search', 'fs_write']);
    const read = (await rw.client.listTools()).tools.find(t => t.name === 'fs_read')!;
    assert.match(read.description!, /the user's own computer 'PC'/);
    assert.ok(read.description!.includes(rw.f.share));
  });

  it('fs_list: folders first, sizes, depth', async () => {
    const { f, call } = await setup(false);
    const r = await call('fs_list', { path: '.' });
    assert.equal(r.text, `${f.share}${nodePath.sep}\n  sub/\n  a.txt  (17 B)`);
    const deep = await call('fs_list', { path: '.', depth: 3 });
    assert.match(deep.text, /sub\/\n {4}deep\/\n {6}c\.ts/);
    assert.equal((await call('fs_list', { path: 'a.txt' })).isError, true);
    assert.equal((await call('fs_list', { path: '/etc' })).isError, true);
  });

  it('fs_read: numbered lines, offset/limit, continuation hint, missing/binary/outside', async () => {
    const { f, call } = await setup(false);
    assert.equal((await call('fs_read', { path: 'a.txt' })).text, '1\talpha\n2\tbeta\n3\tgamma');
    const part = await call('fs_read', { path: 'a.txt', offset: 2, limit: 1 });
    assert.equal(part.text, '2\tbeta\n[showing lines 2–2 of 3; continue with offset 3]');
    assert.match((await call('fs_read', { path: 'a.txt', offset: 9 })).text, /past the end/);
    assert.match((await call('fs_read', { path: 'nope.txt' })).text, /does not exist/);
    await writeFile(nodePath.join(f.share, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    assert.match((await call('fs_read', { path: 'bin.dat' })).text, /binary file/);
    await writeFile(nodePath.join(f.share, 'empty.txt'), '');
    assert.equal((await call('fs_read', { path: 'empty.txt' })).text, '(empty file)');
    assert.equal((await call('fs_read', { path: f.secret })).isError, true);
    await writeFile(nodePath.join(f.share, 'crlf.txt'), 'x\r\ny\r\n');
    assert.equal((await call('fs_read', { path: 'crlf.txt' })).text, '1\tx\n2\ty');
  });

  it('fs_read returns images as image content, and refuses oversized ones', async () => {
    const { f, call } = await setup(false);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
    await writeFile(nodePath.join(f.share, 'p.png'), png);
    const r = await call('fs_read', { path: 'p.png' });
    const img = r.raw.content.find(c => c['type'] === 'image')!;
    assert.equal(img['mimeType'], 'image/png');
    assert.equal(img['data'], png.toString('base64'));
    await writeFile(nodePath.join(f.share, 'big.jpg'), Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.match((await call('fs_read', { path: 'big.jpg' })).text, /limit for fs_read is 5 MB/);
  });

  it('fs_search: by glob, by text with line numbers, skips node_modules/.git/binary, honours max_results', async () => {
    const { f, call } = await setup(false);
    await mkdir(nodePath.join(f.share, 'node_modules', 'm'), { recursive: true });
    await writeFile(nodePath.join(f.share, 'node_modules', 'm', 'd.ts'), 'needle in modules');
    await writeFile(nodePath.join(f.share, 'bin.dat'), Buffer.from('needle\0'));
    const byGlob = await call('fs_search', { path: '.', glob: '*.ts' });
    assert.deepEqual(byGlob.text.split('\n').sort(), [nodePath.join(f.share, 'sub', 'b.ts'), nodePath.join(f.share, 'sub', 'deep', 'c.ts')].sort());
    const byText = await call('fs_search', { path: '.', contains: 'needle' });
    assert.deepEqual(byText.text.split('\n').sort(), [`${nodePath.join(f.share, 'sub', 'b.ts')}:2: // needle here`, `${nodePath.join(f.share, 'sub', 'deep', 'c.ts')}:1: needle again`].sort());
    const both = await call('fs_search', { path: '.', glob: 'c.*', contains: 'needle' });
    assert.equal(both.text.split('\n').length, 1);
    const limited = await call('fs_search', { path: '.', contains: 'needle', max_results: 1 });
    assert.match(limited.text, /stopped at 1 results/);
    assert.equal((await call('fs_search', { path: '.', contains: 'zzz-nothing' })).text, 'No matches.');
    assert.equal((await call('fs_search', { path: '/etc', contains: 'root' })).isError, true);
  });

  it('fs_search does not follow symlinks', { skip: !posix }, async () => {
    const { f, call } = await setup(false);
    await symlink(nodePath.join(f.root, 'outside'), nodePath.join(f.share, 'out'));
    assert.equal((await call('fs_search', { path: '.', contains: 'TOP SECRET' })).text, 'No matches.');
    assert.match((await call('fs_list', { path: '.' })).text, /out -> .*\(symlink, not followed\)/);
    assert.equal((await call('fs_read', { path: 'out/secret.txt' })).isError, true);
  });

  it('fs_write: creates, overwrites, refuses outside and symlink escapes; fs_edit: unique/ambiguous/replace_all', async () => {
    const { f, call } = await setup(true);
    assert.match((await call('fs_write', { path: 'new/dir/n.txt', content: 'hello' })).text, /Created .*n\.txt \(5 bytes\)/);
    assert.equal(await readFile(nodePath.join(f.share, 'new', 'dir', 'n.txt'), 'utf8'), 'hello');
    assert.match((await call('fs_write', { path: 'new/dir/n.txt', content: 'bye' })).text, /Overwrote/);
    assert.equal((await call('fs_write', { path: '../outside/evil.txt', content: 'x' })).isError, true);
    assert.deepEqual(await readdir(nodePath.join(f.root, 'outside')), ['secret.txt']);

    const edit = await call('fs_edit', { path: 'a.txt', old_string: 'beta', new_string: 'BETA' });
    assert.match(edit.text, /Edited .*a\.txt \(1 replacement\)\.\n1\talpha\n2\tBETA\n3\tgamma$/);
    assert.equal(await readFile(nodePath.join(f.share, 'a.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
    await writeFile(nodePath.join(f.share, 'dup.txt'), 'x\nx\n');
    const ambiguous = await call('fs_edit', { path: 'dup.txt', old_string: 'x', new_string: 'y' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /occurs 2 times/);
    assert.equal(await readFile(nodePath.join(f.share, 'dup.txt'), 'utf8'), 'x\nx\n', 'a refused edit changes nothing');
    assert.match((await call('fs_edit', { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true })).text, /2 replacements/);
    assert.equal((await call('fs_edit', { path: 'missing.txt', old_string: 'a', new_string: 'b' })).isError, true);
    await writeFile(nodePath.join(f.share, 'bin.dat'), Buffer.from([0, 1]));
    assert.match((await call('fs_edit', { path: 'bin.dat', old_string: 'a', new_string: 'b' })).text, /binary/);
  });

  it('fs_write through a symlink out of the share is refused and nothing is written', { skip: !posix }, async () => {
    const { f, call } = await setup(true);
    await symlink(nodePath.join(f.root, 'outside'), nodePath.join(f.share, 'out'));
    await symlink(f.secret, nodePath.join(f.share, 'out-file'));
    assert.equal((await call('fs_write', { path: 'out/pwn.txt', content: 'x' })).isError, true);
    assert.equal((await call('fs_write', { path: 'out-file', content: 'pwned' })).isError, true);
    assert.equal((await call('fs_edit', { path: 'out-file', old_string: 'TOP', new_string: 'X' })).isError, true);
    assert.equal((await call('fs_mkdir', { path: 'out/newdir' })).isError, true);
    assert.equal(await readFile(f.secret, 'utf8'), 'TOP SECRET');
    assert.deepEqual(await readdir(nodePath.join(f.root, 'outside')), ['secret.txt']);
  });

  it('fs_mkdir is recursive and idempotent', async () => {
    const { f, call } = await setup(true);
    assert.match((await call('fs_mkdir', { path: 'p/q/r' })).text, /Created/);
    assert.match((await call('fs_mkdir', { path: 'p/q/r' })).text, /already exists/);
    assert.ok((await stat(nodePath.join(f.share, 'p', 'q', 'r'))).isDirectory());
    assert.equal((await call('fs_mkdir', { path: 'a.txt' })).isError, true);
  });

  it('_fs_read_b64 / _fs_write_b64 round-trip; overwrite flag; size limits', async () => {
    const { f, call } = await setup(true);
    const data = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    await writeFile(nodePath.join(f.share, 'blob.bin'), data);
    const read = await call('_fs_read_b64', { path: 'blob.bin' });
    assert.deepEqual(read.raw.structuredContent, { name: 'blob.bin', size: 7, base64: data.toString('base64') });
    assert.deepEqual(JSON.parse(read.text), read.raw.structuredContent);

    const w = await call('_fs_write_b64', { path: 'copy/blob.bin', base64: data.toString('base64') });
    assert.equal(w.isError, false);
    assert.deepEqual(await readFile(nodePath.join(f.share, 'copy', 'blob.bin')), data);
    const again = await call('_fs_write_b64', { path: 'copy/blob.bin', base64: 'AA==' });
    assert.match(again.text, /already exists/);
    assert.equal((await call('_fs_write_b64', { path: 'copy/blob.bin', base64: 'AA==', overwrite: true })).isError, false);
    assert.match((await call('_fs_write_b64', { path: 'x.bin', base64: '***' })).text, /not valid/);
    assert.equal((await call('_fs_write_b64', { path: '../outside/x.bin', base64: 'AA==' })).isError, true);

    await writeFile(nodePath.join(f.share, 'huge.bin'), Buffer.alloc(12_000_001));
    assert.match((await call('_fs_read_b64', { path: 'huge.bin' })).text, /carries at most/);
  });
});
