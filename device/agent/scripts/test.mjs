// Runs the tests the way the agent ships: each test file is bundled by esbuild exactly like dist/main.mjs (packages
// external, no tsx) and run by node:test. This matters beyond style: tsx keeps function names with a `__name` helper that
// does not exist inside a browser page, which breaks playwright-mcp's page.evaluate() code, and a bundle is what runs
// on a device.
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const nodeArgs = process.argv.slice(2).filter(a => a.startsWith('-'));
const files = (await readdir('src/__tests__')).filter(f => f.endsWith('.test.ts') && (only.length === 0 || only.some(o => f.includes(o))));
await rm('.test-build', { recursive: true, force: true });
await build({
  entryPoints: files.map(f => `src/__tests__/${f}`),
  outdir: '.test-build',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'inline',
  tsconfig: 'tsconfig.build.json',
  logLevel: 'warning',
});
const child = spawn(process.execPath, ['--enable-source-maps', '--test', ...nodeArgs, ...files.map(f => `.test-build/${f.replace(/\.ts$/, '.mjs')}`)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
