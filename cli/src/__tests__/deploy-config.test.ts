import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_AUTO_APPROVE_TOOLS } from '../config.js';
import { DEFAULT_GHOST_CONNECTORS } from '../ghost.js';
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS } from '../output-truncator.js';
import { DEFAULT_RETENTION_MONTHS } from '../retention.js';
import { DEFAULT_SCHEDULE_MAX_STEPS } from '../server.js';

// dist/__tests__ → repository root
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(join(repo, '.env.example'), 'utf8');

/** Every `${VAR…}` in the compose file, with its default (`${VAR:-x}` / `${VAR-x}`), or null when it has none. */
function composeVariables(): Map<string, Set<string | null>> {
  const vars = new Map<string, Set<string | null>>();
  for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?:(:?-)([^}]*)|:\?[^}]*)?\}/g)) {
    const set = vars.get(m[1]!) ?? new Set();
    set.add(m[2] ? m[3]! : null);
    vars.set(m[1]!, set);
  }
  return vars;
}

/** `.env.example` assignments: active ones with their value, and commented-out examples (`# VAR=…`). */
function envExampleVariables(): { active: Map<string, string>; all: Set<string> } {
  const active = new Map<string, string>();
  const all = new Set<string>();
  for (const m of envExample.matchAll(/^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    all.add(m[2]!);
    if (!m[1]) active.set(m[2]!, m[3]!.trim());
  }
  return { active, all };
}

/** The default docker-compose.yml gives one of the web server's variables; fails when it gives none. */
function webDefault(name: string): string {
  const block = /^ {2}everythingapp-web:\n((?: {4}.*\n|\s*\n)+)/m.exec(compose)?.[1] ?? '';
  const m = new RegExp(`^ {6}${name}: \\$\\{${name}:?-([^}]*)\\}`, 'm').exec(block);
  assert.ok(m, `docker-compose.yml passes ${name} to everythingapp-web with a default`);
  return m[1]!;
}

describe('deployment configuration', () => {
  it('.env.example lists exactly the variables docker-compose.yml reads (anything else in .env would do nothing)', () => {
    const fromCompose = [...composeVariables().keys()].sort();
    const fromExample = [...envExampleVariables().all].sort();
    assert.deepEqual(fromExample.filter(v => !fromCompose.includes(v)), [], 'in .env.example but never read by compose');
    assert.deepEqual(fromCompose.filter(v => !fromExample.includes(v)), [], 'read by compose but missing from .env.example');
  });

  it('a value in .env.example is the default compose uses, and compose uses one default per variable', () => {
    const vars = composeVariables();
    for (const [name, defaults] of vars) {
      const given = [...defaults].filter(d => d !== null);
      assert.ok(new Set(given).size <= 1, `${name} has different defaults in compose: ${given.join(' | ')}`);
    }
    for (const [name, value] of envExampleVariables().active) {
      if (value === '') continue;
      assert.equal(value, [...vars.get(name)!].find(d => d !== null), `${name} in .env.example vs docker-compose.yml`);
    }
  });

  it('compose passes the web server its tunables with the defaults the code has', () => {
    assert.equal(webDefault('AUTO_APPROVE_TOOLS'), DEFAULT_AUTO_APPROVE_TOOLS.join(','));
    assert.equal(webDefault('TOOL_OUTPUT_MAX_CHARS'), String(DEFAULT_TOOL_OUTPUT_MAX_CHARS));
    assert.equal(webDefault('SCHEDULE_MAX_STEPS'), String(DEFAULT_SCHEDULE_MAX_STEPS));
    assert.equal(webDefault('RETENTION_MONTHS'), String(DEFAULT_RETENTION_MONTHS));
    assert.equal(webDefault('GHOST_CONNECTORS'), DEFAULT_GHOST_CONNECTORS.join(','));
    assert.ok(envExample.includes(DEFAULT_AUTO_APPROVE_TOOLS.join(',')), '.env.example names the default auto-approve list');
  });
});
