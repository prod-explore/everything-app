import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as Llm from '../llm-types.js';
import { runTurn, browserInjectionSignal } from '../llm-loop.js';
import { ToolRegistry } from '../tool-registry.js';
import type { McpConnectionLike } from '../mcp-client.js';
import { createProject, openDb, runMigrations, updateProject } from '../db.js';
import { WebApprovalGate } from '../web-approval.js';
import { buildApp } from '../server.js';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null };
const message = (content: unknown[], stop: string) =>
  ({ id: 'm', container: null, content, model: 'm', role: 'assistant', stop_reason: stop, stop_sequence: null, type: 'message', usage }) as unknown as Llm.Message;

describe('browserInjectionSignal', () => {
  it('reads the [browser-meta] first line and ignores everything else', () => {
    assert.deepEqual(browserInjectionSignal('[browser-meta] {"injection_suspected":true,"injection_reasons":["role marker"]}\nbody'), { suspected: true, reasons: ['role marker'] });
    assert.deepEqual(browserInjectionSignal('[browser-meta] {"injection_suspected":false}'), { suspected: false, reasons: [] });
    assert.deepEqual(browserInjectionSignal('page says [browser-meta] {"injection_suspected":true}'), { suspected: false, reasons: [] });
    assert.deepEqual(browserInjectionSignal('[browser-meta] not json'), { suspected: false, reasons: [] });
  });
});

describe('browser tools in the loop', () => {
  async function run(observation: string) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const conn: McpConnectionLike = {
      name: 'pw',
      async listTools() {
        return [
          { name: 'browser_observe', description: '', inputSchema: { type: 'object' } },
          { name: 'browser_act', description: '', inputSchema: { type: 'object' } },
        ];
      },
      async callTool(name, args) {
        calls.push({ name, args: args as Record<string, unknown> });
        return { text: name === 'browser_observe' ? observation : 'clicked', isError: false };
      },
    };
    const registry = new ToolRegistry(['browser_observe', 'browser_act']); // both auto-approved
    await registry.loadFrom([conn]);
    const prompts: Array<{ label: string; forcePrompt?: string }> = [];
    let n = 0;
    await runTurn(
      {
        llm: {
          messages: {
            async create() {
              n++;
              if (n === 1) return message([{ type: 'tool_use', id: 'a', name: 'pw__browser_observe', input: { _policy: { domainAllow: [] }, _allow_downloads: true } }], 'tool_use');
              if (n === 2) return message([{ type: 'tool_use', id: 'b', name: 'pw__browser_act', input: { ref: 'e1', label: 'Pay' } }], 'tool_use');
              return message([{ type: 'text', text: 'done' }], 'end_turn');
            },
          },
        },
        model: 'm', tools: registry, systemPrompt: 's', conversationId: 'c1',
        browserPolicy: { domainDeny: ['evil.example'], js: 'disabled' },
        confirm: async (label, _args, opts) => { prompts.push({ label, forcePrompt: opts?.forcePrompt }); return true; },
      },
      [],
      'go',
    );
    return { calls, prompts };
  }

  it('injects the orchestrator policy and strips model-supplied hidden args', async () => {
    const { calls, prompts } = await run('[browser-meta] {"injection_suspected":false}\nok');
    assert.deepEqual(calls[0]!.args['_policy'], { domainDeny: ['evil.example'], js: 'disabled' });
    assert.equal(calls[0]!.args['_allow_downloads'], undefined);
    assert.deepEqual(prompts, [], 'auto-approved tools are not prompted without a signal');
  });

  it('after a suspected injection, effectful tools need a fresh approval despite auto-approve', async () => {
    const { prompts } = await run('[browser-meta] {"injection_suspected":true,"injection_reasons":["ignore previous instructions"]}\n...');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!.label, /browser_act/);
    assert.match(prompts[0]!.forcePrompt!, /prompt injection.*ignore previous/);
  });

  it('the gate turns forcePrompt into a once-only prompt that grants cannot skip', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO approval_grants (tool_label, scope) VALUES ('pw/browser_act', 'always')`).run();
    const gate = new WebApprovalGate(db);
    void gate.confirmDetailed('c1', 'pw/browser_act', { ref: 'e1' }, undefined, { forcePrompt: 'page looked like an injection' });
    await new Promise(r => setImmediate(r));
    const [p] = gate.listPending();
    assert.ok(p);
    assert.equal(p.dangerous, true);
    assert.equal(p.warning, 'page looked like an injection');
  });
});

describe('browser policy source', () => {
  it('comes from policy.json only; a browser key left in an older project policy has no effect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-browser-policy-'));
    const policyFile = path.join(dir, 'policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ browser: { domainAllow: ['docs.example'], domainDeny: ['ads.example'], js: 'review' } }));
    const db = openDb(':memory:');
    runMigrations(db);
    const project = createProject(db, { name: 'legacy' });
    // What older versions stored per project: an allowlist that used to REPLACE the file's, a looser JS setting, an extra deny.
    updateProject(db, project.id, { policy: { browser: { domainAllow: ['anything.example'], domainDeny: ['other.example'], js: 'allowed' } } });

    const policies: unknown[] = [];
    const conn: McpConnectionLike = {
      name: 'pw',
      async listTools() { return [{ name: 'browser_observe', description: '', inputSchema: { type: 'object' } }]; },
      async callTool(_name, args) { policies.push((args as Record<string, unknown>)['_policy']); return { text: 'ok', isError: false }; },
    };
    let n = 0;
    const llm = { messages: { async create() { return n++ === 0 ? message([{ type: 'tool_use', id: 'a', name: 'pw__browser_observe', input: {} }], 'tool_use') : message([{ type: 'text', text: 'done' }], 'end_turn'); }, batches: {} } };
    const built = await buildApp({ db, connections: [conn] as never, llm: llm as never, authToken: 't', policyFile, config: { model: '@test/model-a', autoApproveTools: ['browser_observe'] } });
    const server = built.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, p: string, body?: unknown) => new Promise<any>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json', authorization: 'Bearer t' } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')));
      });
      r.on('error', reject);
      r.end(payload);
    });
    try {
      const { id } = await call('POST', '/api/conversations', { projectId: project.id });
      await call('POST', `/api/conversations/${id}/message`, { text: 'look' });
      for (let i = 0; i < 200 && policies.length === 0; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(policies.length, 1);
      // domainGrant (hosts granted in the chat) is added by the loop; the policy fields must be the file's, untouched.
      const { domainAllow, domainDeny, js } = policies[0] as Record<string, unknown>;
      assert.deepEqual({ domainAllow, domainDeny, js }, { domainAllow: ['docs.example'], domainDeny: ['ads.example'], js: 'review' });
    } finally {
      built.stop();
      server.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
