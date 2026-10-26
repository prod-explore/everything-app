import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromiumLaunchArgs } from '../browserContext.js';

// dist/__tests__ → package root
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Dockerfile', () => {
  it('uses the Playwright image that matches the locked playwright package (its Chromium revision)', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
    const version = lock.packages['node_modules/playwright']?.version;
    assert.ok(version, 'playwright is in package-lock.json');
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const tag = /^ARG PLAYWRIGHT_IMAGE_TAG=(\S+)$/m.exec(docker)?.[1];
    assert.equal(tag, `v${version}-noble`, 'bump ARG PLAYWRIGHT_IMAGE_TAG in Dockerfile together with the playwright dependency');
  });

  // Chromium runs with --no-sandbox, which is only acceptable while the container is locked down instead.
  it('runs Chromium unsandboxed only inside a non-root, capability-free, no-new-privileges container', () => {
    assert.ok(chromiumLaunchArgs().includes('--no-sandbox'));
    const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const user = [...docker.matchAll(/^USER\s+(\S+)/gm)].pop()?.[1];
    assert.ok(user && user !== 'root' && user !== '0', `final USER is non-root (got ${user})`);
    const compose = readFileSync(join(root, '..', 'docker-compose.yml'), 'utf8');
    const service = /^ {2}playwright-mcp:\n((?: {4}.*\n|\s*\n)+)/m.exec(compose)?.[1];
    assert.ok(service, 'playwright-mcp service in docker-compose.yml');
    assert.match(service, /^ {4}cap_drop: \[ALL\]$/m);
    assert.match(service, /^ {4}security_opt: \["no-new-privileges:true"\]$/m);
  });
});
