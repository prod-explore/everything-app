import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, readlink, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { createInterface } from 'node:readline';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ResolvedConfig } from '../config.js';
import { atomicWrite } from '../fs/atomic.js';
import { matchesGlob } from '../fs/glob.js';
import { PathError, PathGuard, type Resolved } from '../fs/guard.js';
import { deviceLabel } from '../report.js';
import { errMessage, fail, ok, type ToolResult } from './common.js';

/**
 * fs_* tools: the folders the owner shared (`files.roots`), nothing else. Reading needs no approval in the app once the
 * capability is on; the write tools exist only when `files.write` is true (ADR 0019) and are approval-gated by the server.
 */

// 12 000 000 bytes (the server enforces the same figure): base64 of it is 16 000 000 characters, inside the 16 MiB frame. The contract's 25 MB would be closed by the server with 1009.
export const MAX_B64_BYTES = 12_000_000;
const MAX_EDIT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_READ_CHARS = 60_000;
const MAX_LINE_CHARS = 2_000;
const MAX_LIST_ENTRIES = 500;
const SEARCH_DEADLINE_MS = 15_000;
const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** NUL bytes in the first 8 KB: the cheap, reliable "this is not text" test. */
async function looksBinary(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

async function resolveOrFail(guard: PathGuard, input: string): Promise<Resolved | ToolResult> {
  try {
    return await guard.resolve(input);
  } catch (err) {
    if (err instanceof PathError) return fail(err.message);
    throw err;
  }
}

const isFailure = (r: Resolved | ToolResult): r is ToolResult => 'content' in r;

// ─── fs_list ────────────────────────────────────────────────────────────────────

async function listTree(dir: string, depth: number, indent: string, out: string[], budget: { left: number }): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    out.push(`${indent}[cannot read: ${(err as NodeJS.ErrnoException).code ?? errMessage(err)}]`);
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.left-- <= 0) {
      if (budget.left === -1) out.push(`${indent}[… more entries not shown (limit ${MAX_LIST_ENTRIES})]`);
      return;
    }
    const full = nodePath.join(dir, e.name);
    if (e.isSymbolicLink()) {
      const target = await readlink(full).catch(() => '?');
      out.push(`${indent}${e.name} -> ${target}  (symlink, not followed)`);
    } else if (e.isDirectory()) {
      out.push(`${indent}${e.name}/`);
      if (depth > 1) await listTree(full, depth - 1, `${indent}  `, out, budget);
    } else {
      const size = await stat(full).then(s => humanSize(s.size), () => '?');
      out.push(`${indent}${e.name}  (${size})`);
    }
  }
}

// ─── fs_search ──────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['.git', 'node_modules']);

async function* walk(root: string, deadline: number): AsyncGenerator<{ full: string; rel: string }> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (Date.now() > deadline) return;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirs: string[] = [];
    for (const e of entries) {
      const full = nodePath.join(dir, e.name);
      // Symlinks are never followed: a link inside a shared folder can point anywhere.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(full);
      } else if (e.isFile()) {
        yield { full, rel: nodePath.relative(root, full) };
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]!);
  }
}

async function grepFile(full: string, needle: string, max: number): Promise<Array<{ line: number; text: string }>> {
  const hits: Array<{ line: number; text: string }> = [];
  const rl = createInterface({ input: createReadStream(full, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      n++;
      if (line.includes(needle)) {
        hits.push({ line: n, text: line.trim().slice(0, 200) });
        if (hits.length >= max) break;
      }
    }
  } finally {
    rl.close();
  }
  return hits;
}

// ─── fs_read ────────────────────────────────────────────────────────────────────

async function readLines(path: string, offset: number, limit: number): Promise<{ text: string; shown: [number, number] | null; total: number; cut: boolean }> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines: string[] = [];
  let n = 0;
  let chars = 0;
  let cut = false;
  try {
    for await (const raw of rl) {
      n++;
      if (n < offset || cut || lines.length >= limit) continue;
      let line = n === 1 ? raw.replace(/^﻿/, '') : raw;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]`;
      const numbered = `${n}\t${line}`;
      if (chars + numbered.length > MAX_READ_CHARS) {
        cut = true;
        continue;
      }
      chars += numbered.length + 1;
      lines.push(numbered);
    }
  } finally {
    rl.close();
  }
  return { text: lines.join('\n'), shown: lines.length ? [offset, offset + lines.length - 1] : null, total: n, cut };
}

// ─── fs_edit ────────────────────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** Applies Claude Code's Edit semantics; returns the new text or an error message. Pure. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { ok: true; text: string; replacements: number; firstIndex: number } | { ok: false; error: string } {
  if (oldString === '') return { ok: false, error: 'old_string is empty — use fs_write to create or replace a whole file' };
  if (oldString === newString) return { ok: false, error: 'old_string and new_string are identical — nothing to change' };
  let from = oldString;
  let to = newString;
  // A CRLF file edited with LF text from the model: match and write in the file's own line endings.
  if (content.includes('\r\n') && !from.includes('\r') && from.includes('\n') && !content.includes(from)) {
    from = from.replace(/\n/g, '\r\n');
    to = to.replace(/\r?\n/g, '\r\n');
  }
  const count = countOccurrences(content, from);
  if (count === 0) {
    const trimmed = from.trim();
    const hint = trimmed && trimmed !== from && content.includes(trimmed) ? ' (the text exists without its leading/trailing whitespace — check indentation and line breaks)' : '';
    return { ok: false, error: `old_string was not found in the file${hint}. It must match exactly, including whitespace — fs_read the file again.` };
  }
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `old_string occurs ${count} times. Add surrounding context so it is unique, or pass replace_all: true to change every occurrence.` };
  }
  const firstIndex = content.indexOf(from);
  const text = replaceAll ? content.split(from).join(to) : content.slice(0, firstIndex) + to + content.slice(firstIndex + from.length);
  return { ok: true, text, replacements: replaceAll ? count : 1, firstIndex };
}

function snippetAround(text: string, index: number, span: number): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // the empty piece after a final newline is not a line
  const lineNo = text.slice(0, index).split('\n').length;
  const from = Math.max(1, lineNo - 3);
  const to = Math.min(lines.length, lineNo + Math.max(0, span) + 3);
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}\t${l.length > 200 ? `${l.slice(0, 200)}…` : l}`)
    .join('\n');
}

// ─── Registration ───────────────────────────────────────────────────────────────

export function registerFileTools(server: McpServer, cfg: ResolvedConfig, guard = new PathGuard(cfg.files.roots)): void {
  const where = deviceLabel(cfg, false);
  const rootsText = cfg.files.roots.join(', ');
  const scope = `Paths are on ${where}, limited to the folders the user shared: ${rootsText}. A relative path starts at ${cfg.files.roots[0]}; absolute paths must lie inside a shared folder (symlinks that lead out are refused).`;

  server.registerTool(
    'fs_list',
    {
      title: 'List folder on the device',
      description: `List the contents of a folder, folders first, with file sizes. ${scope}`,
      inputSchema: {
        path: z.string().describe('Folder to list.'),
        depth: z.number().int().min(1).max(4).optional().describe('Levels to descend (default 1).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, depth }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      const info = await stat(r.path).catch(() => null);
      if (!info) return fail(`"${path}" does not exist.`);
      if (!info.isDirectory()) return fail(`"${path}" is a file, not a folder — use fs_read.`);
      const out: string[] = [`${r.path}${nodePath.sep}`];
      await listTree(r.path, depth ?? 1, '  ', out, { left: MAX_LIST_ENTRIES });
      return ok(out.join('\n'));
    },
  );

  server.registerTool(
    'fs_read',
    {
      title: 'Read file on the device',
      description:
        `Read a text file with line numbers (cat -n style: number, tab, line), 2000 lines per call by default — continue with offset. ` +
        `PNG, JPEG, GIF and WebP images up to 5 MB come back as images. Other binary files are refused (use device_transfer to copy them). ${scope}`,
      inputSchema: {
        path: z.string().describe('File to read.'),
        offset: z.number().int().min(1).optional().describe('First line to return, 1-based (default 1).'),
        limit: z.number().int().min(1).max(10_000).optional().describe('Most lines to return (default 2000).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, offset, limit }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      const info = await stat(r.path).catch(() => null);
      if (!info) return fail(`"${path}" does not exist.`);
      if (info.isDirectory()) return fail(`"${path}" is a folder — use fs_list.`);
      if (!info.isFile()) return fail(`"${path}" is not a regular file.`);
      const mime = IMAGE_TYPES[nodePath.extname(r.path).toLowerCase()];
      if (mime) {
        if (info.size > MAX_IMAGE_BYTES) return fail(`Image is ${humanSize(info.size)}; the limit for fs_read is 5 MB.`);
        const data = (await readFile(r.path)).toString('base64');
        return { content: [{ type: 'text', text: `Image ${nodePath.basename(r.path)} (${humanSize(info.size)})` }, { type: 'image', data, mimeType: mime }] };
      }
      if (info.size > 0 && (await looksBinary(r.path))) {
        return fail(`"${path}" is a binary file (${humanSize(info.size)}); fs_read only reads text and images. device_transfer copies files to the chat's workspace.`);
      }
      if (info.size === 0) return ok('(empty file)');
      const start = offset ?? 1;
      const res = await readLines(r.path, start, limit ?? 2000);
      if (!res.shown) return fail(`Offset ${start} is past the end of the file (${res.total} lines).`);
      const tail =
        res.shown[1] < res.total
          ? `\n[showing lines ${res.shown[0]}–${res.shown[1]} of ${res.total}${res.cut ? ' (output size limit)' : ''}; continue with offset ${res.shown[1] + 1}]`
          : '';
      return ok(res.text + tail);
    },
  );

  server.registerTool(
    'fs_search',
    {
      title: 'Search files on the device',
      description:
        'Find files by name pattern and/or by text inside them, under a folder. glob: `*.ts` matches file names at any depth, `src/**/*.test.ts` matches the path; ' +
        '`**`, `?`, `[ab]` and `{a,b}` work. contains: literal, case-sensitive text; returns path:line: text. Skips .git and node_modules, binary and very large files; ' +
        `does not follow symlinks; stops after 15 seconds. ${scope}`,
      inputSchema: {
        path: z.string().describe('Folder to search under.'),
        glob: z.string().min(1).optional().describe('File name or path pattern.'),
        contains: z.string().min(1).optional().describe('Text to look for inside files.'),
        max_results: z.number().int().min(1).max(500).optional().describe('Default 100.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, glob, contains, max_results }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      const info = await stat(r.path).catch(() => null);
      if (!info?.isDirectory()) return fail(`"${path}" is not a folder.`);
      const max = max_results ?? 100;
      const deadline = Date.now() + SEARCH_DEADLINE_MS;
      const results: string[] = [];
      let scanned = 0;
      let stopped: string | null = null;
      for await (const f of walk(r.path, deadline)) {
        if (glob && !matchesGlob(glob, f.rel)) continue;
        if (contains) {
          const fi = await stat(f.full).catch(() => null);
          if (!fi || fi.size > SEARCH_MAX_FILE_BYTES || (fi.size > 0 && (await looksBinary(f.full).catch(() => true)))) continue;
          scanned++;
          const hits = await grepFile(f.full, contains, max - results.length).catch(() => []);
          for (const h of hits) results.push(`${f.full}:${h.line}: ${h.text}`);
        } else {
          results.push(f.full);
        }
        if (results.length >= max) {
          stopped = `stopped at ${max} results`;
          break;
        }
      }
      if (!stopped && Date.now() > deadline) stopped = 'stopped after 15 seconds';
      if (results.length === 0) return ok(stopped ? `No matches (${stopped}).` : 'No matches.');
      return ok(results.join('\n') + (stopped ? `\n[${stopped}; narrow the search or raise max_results]` : ''));
    },
  );

  // Internal transfer reads: the server calls these for device_transfer; models never see them.
  server.registerTool(
    '_fs_read_b64',
    {
      title: 'Read file as base64 (internal)',
      description: `Internal: read a whole file as base64 for device_transfer (at most ${humanSize(MAX_B64_BYTES)}). ${scope}`,
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      const info = await stat(r.path).catch(() => null);
      if (!info) return fail(`"${path}" does not exist.`);
      if (!info.isFile()) return fail(`"${path}" is not a regular file.`);
      if (info.size > MAX_B64_BYTES) return fail(`"${path}" is ${humanSize(info.size)}; a transfer carries at most ${humanSize(MAX_B64_BYTES)}.`);
      const base64 = (await readFile(r.path)).toString('base64');
      const result = { name: nodePath.basename(r.path), size: info.size, base64 };
      return ok(JSON.stringify(result), result);
    },
  );

  if (!cfg.files.write) return;

  server.registerTool(
    'fs_write',
    {
      title: 'Write file on the device',
      description:
        `Create a file or replace it entirely with \`content\` (missing parent folders are created). The write is atomic and keeps an existing file's permissions. ` +
        `To change part of a file use fs_edit. This changes the user's real files. ${scope}`,
      inputSchema: {
        path: z.string().describe('File to write.'),
        content: z.string().max(MAX_EDIT_BYTES).describe('The complete new content (UTF-8).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, content }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      try {
        const { created } = await atomicWrite(r.path, content);
        return ok(`${created ? 'Created' : 'Overwrote'} ${r.path} (${Buffer.byteLength(content)} bytes).`);
      } catch (err) {
        return fail(`fs_write error: ${errMessage(err)}`);
      }
    },
  );

  server.registerTool(
    'fs_edit',
    {
      title: 'Edit file on the device',
      description:
        'Replace exact text in a file. old_string must match the file exactly (whitespace included) and be unique, unless replace_all is true; ' +
        'otherwise the edit is refused and nothing changes. Read the file first. Include a few surrounding lines in old_string to make it unique. ' +
        `Do not include fs_read's line-number prefixes. ${scope}`,
      inputSchema: {
        path: z.string().describe('File to edit.'),
        old_string: z.string().describe('The exact text to replace.'),
        new_string: z.string().describe('The replacement (may be empty to delete).'),
        replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, old_string, new_string, replace_all }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      const info = await stat(r.path).catch(() => null);
      if (!info) return fail(`"${path}" does not exist — use fs_write to create it.`);
      if (!info.isFile()) return fail(`"${path}" is not a regular file.`);
      if (info.size > MAX_EDIT_BYTES) return fail(`"${path}" is ${humanSize(info.size)}; fs_edit handles files up to ${humanSize(MAX_EDIT_BYTES)}.`);
      if (await looksBinary(r.path)) return fail(`"${path}" is a binary file; fs_edit only edits text.`);
      const content = await readFile(r.path, 'utf8');
      const edit = applyEdit(content, old_string, new_string, replace_all === true);
      if (!edit.ok) return fail(`fs_edit error: ${edit.error}`);
      try {
        await atomicWrite(r.path, edit.text);
      } catch (err) {
        return fail(`fs_edit error: ${errMessage(err)}`);
      }
      const span = new_string.split('\n').length - 1;
      return ok(`Edited ${r.path} (${edit.replacements} replacement${edit.replacements === 1 ? '' : 's'}).\n${snippetAround(edit.text, edit.firstIndex, span)}`);
    },
  );

  server.registerTool(
    'fs_mkdir',
    {
      title: 'Create folder on the device',
      description: `Create a folder, including missing parents (like mkdir -p). Succeeds if it already exists. ${scope}`,
      inputSchema: { path: z.string().describe('Folder to create.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }): Promise<ToolResult> => {
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      try {
        const info = await stat(r.path).catch(() => null);
        if (info && !info.isDirectory()) return fail(`"${path}" exists and is a file.`);
        await mkdir(r.path, { recursive: true });
        return ok(info ? `${r.path} already exists.` : `Created ${r.path}.`);
      } catch (err) {
        return fail(`fs_mkdir error: ${errMessage(err)}`);
      }
    },
  );

  server.registerTool(
    '_fs_write_b64',
    {
      title: 'Write file from base64 (internal)',
      description: `Internal: write a whole file from base64 for device_transfer (at most ${humanSize(MAX_B64_BYTES)}). ${scope}`,
      inputSchema: { path: z.string(), base64: z.string(), overwrite: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path, base64, overwrite }): Promise<ToolResult> => {
      if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(base64)) return fail('base64 is not valid.');
      const data = Buffer.from(base64, 'base64');
      if (data.length > MAX_B64_BYTES) return fail(`${humanSize(data.length)} is over the transfer limit of ${humanSize(MAX_B64_BYTES)}.`);
      const r = await resolveOrFail(guard, path);
      if (isFailure(r)) return r;
      try {
        await atomicWrite(r.path, data, { overwrite: overwrite === true });
        const result = { path: r.path, size: data.length };
        return ok(JSON.stringify(result), result);
      } catch (err) {
        return fail(`_fs_write_b64 error: ${errMessage(err)}`);
      }
    },
  );
}
