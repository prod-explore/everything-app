#!/usr/bin/env node
// Downloads the official Node.js binary for a Rust target triple from nodejs.org, verifies its SHA-256 against
// SHASUMS256.txt and places it where Tauri's `externalBin` expects it:
//   src-tauri/binaries/evvapp-node-<triple>[.exe]
//
// Usage: node scripts/fetch-node.mjs [--target <triple>] [--version 22|22.x.y] [--force]
// The target defaults to the host triple (from `rustc -vV`). The default version is the newest Node 22 release.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = 'https://nodejs.org/dist';

// triple -> [nodejs.org platform, windows?]
const TARGETS = {
  'x86_64-pc-windows-msvc': ['win-x64', true],
  'aarch64-pc-windows-msvc': ['win-arm64', true],
  'aarch64-apple-darwin': ['darwin-arm64', false],
  'x86_64-apple-darwin': ['darwin-x64', false],
  'x86_64-unknown-linux-gnu': ['linux-x64', false],
  'aarch64-unknown-linux-gnu': ['linux-arm64', false],
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = /^host: (.+)$/m.exec(out);
  if (!m) throw new Error('cannot read the host triple from `rustc -vV`; pass --target');
  return m[1].trim();
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveVersion(want) {
  if (/^\d+\.\d+\.\d+$/.test(want)) return `v${want}`;
  const index = JSON.parse((await get(`${DIST}/index.json`)).toString('utf8'));
  const hit = index.find((r) => r.version.startsWith(`v${want}.`));
  if (!hit) throw new Error(`no Node ${want} release found in ${DIST}/index.json`);
  return hit.version;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const triple = arg('target') ?? hostTriple();
const target = TARGETS[triple];
if (!target) throw new Error(`unsupported target ${triple}; supported: ${Object.keys(TARGETS).join(', ')}`);
const [platform, windows] = target;

const outDir = join(root, 'src-tauri', 'binaries');
const outFile = join(outDir, `evvapp-node-${triple}${windows ? '.exe' : ''}`);
if (existsSync(outFile) && !process.argv.includes('--force')) {
  console.log(`${outFile} exists (use --force to replace it)`);
  process.exit(0);
}

const version = await resolveVersion(arg('version') ?? '22');
console.log(`Node ${version} for ${triple} (${platform})`);

const sums = new Map();
for (const line of (await get(`${DIST}/${version}/SHASUMS256.txt`)).toString('utf8').split('\n')) {
  const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
  if (m) sums.set(m[2], m[1]);
}

// Windows: the bare node.exe is published (and listed in SHASUMS256.txt); elsewhere take it out of the tarball.
const remote = windows ? `${platform}/node.exe` : `node-${version}-${platform}.tar.gz`;
const expected = sums.get(remote);
if (!expected) throw new Error(`${remote} is not listed in SHASUMS256.txt for ${version}`);

const data = await get(`${DIST}/${version}/${remote}`);
const actual = sha256(data);
if (actual !== expected) throw new Error(`SHA-256 mismatch for ${remote}: expected ${expected}, got ${actual}`);
console.log(`SHA-256 ok: ${actual}`);

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'evvapp-node-'));
try {
  let binary;
  if (windows) {
    binary = join(work, 'node.exe');
    writeFileSync(binary, data);
  } else {
    const archive = join(work, 'node.tar.gz');
    writeFileSync(archive, data);
    const member = `node-${version}-${platform}/bin/node`;
    execFileSync('tar', ['-xzf', archive, '-C', work, member], { stdio: 'inherit' });
    binary = join(work, member);
  }
  copyFileSync(binary, outFile); // tmpdir may be on another device, so no rename
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!windows) chmodSync(outFile, 0o755);
console.log(`wrote ${outFile} (${(readFileSync(outFile).length / 1048576).toFixed(0)} MiB)`);
