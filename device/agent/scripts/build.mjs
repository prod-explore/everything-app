// Bundles the agent into dist/main.mjs. The shippable unit is that file plus node_modules: every package import stays
// external (`packages: 'external'`), which includes the bare 'playwright'/'zod'/SDK imports inside the playwright-mcp
// sources pulled in through src/tools/browser.ts — they resolve at run time from device/agent/node_modules, next to the bundle.
import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  // The `paths` in tsconfig.json point at .d.ts files for the type checker; bundling must not follow them.
  tsconfig: 'tsconfig.build.json',
  logLevel: 'info',
});
await chmod(new URL('../dist/main.mjs', import.meta.url), 0o755);
