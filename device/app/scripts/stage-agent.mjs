#!/usr/bin/env node
// Builds device/agent and stages it as a Tauri resource:
//   src-tauri/resources/agent/{dist/, package.json, node_modules/ (production only)}
// The tray app runs `<resources>/agent/dist/main.mjs --stdio` with the bundled Node.
//
// Usage: node scripts/stage-agent.mjs [--skip-build]

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '..', '..');
const agentDir = join(repoRoot, 'device', 'agent');
const playwrightMcp = join(repoRoot, 'playwright-mcp');
const stage = join(appRoot, 'src-tauri', 'resources', 'agent');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, cwd, env = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}   (${cwd})`);
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm.cmd needs a shell on Windows
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ...env },
  });
}

if (!existsSync(join(agentDir, 'package.json'))) throw new Error(`${agentDir} has no package.json`);

if (!process.argv.includes('--skip-build')) {
  // The agent bundles playwright-mcp's sources, so its dependencies must be installed first.
  if (existsSync(join(playwrightMcp, 'package.json'))) run(npm, ['ci'], playwrightMcp);
  run(npm, ['ci'], agentDir);
  run(npm, ['run', 'build'], agentDir);
}
if (!existsSync(join(agentDir, 'dist', 'main.mjs'))) throw new Error('device/agent/dist/main.mjs is missing after the build');

// Clear the stage but keep the placeholder that lets `cargo check` work on a bare checkout.
mkdirSync(stage, { recursive: true });
for (const entry of readdirSync(stage)) if (entry !== '.gitkeep') rmSync(join(stage, entry), { recursive: true, force: true });

cpSync(join(agentDir, 'dist'), join(stage, 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json']) {
  if (existsSync(join(agentDir, f))) cpSync(join(agentDir, f), join(stage, f));
}
run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
console.log(`staged the agent in ${stage}`);
