import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../tools/index.js';
import type { PlaywrightConfig } from '../config.js';
import type { BrowserSessionPool } from '../sessionPool.js';

async function listTools() {
  const server = new McpServer({ name: 'test', version: '0' });
  // Registration only wires handlers; neither dependency is used until a tool is called.
  registerAllTools(server, {} as PlaywrightConfig, {} as BrowserSessionPool);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe('tool metadata', () => {
  it('every tool has a title, an input schema and the behaviour hints clients use to decide about approval', async () => {
    const tools = await listTools();
    assert.ok(tools.length > 0);
    for (const t of tools) {
      assert.ok(t.title, `${t.name}: title`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: input schema`);
      assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name}: readOnlyHint`);
      assert.equal(typeof t.annotations?.openWorldHint, 'boolean', `${t.name}: openWorldHint`);
      if (t.annotations?.readOnlyHint === false) {
        assert.equal(typeof t.annotations.destructiveHint, 'boolean', `${t.name}: destructiveHint`);
        assert.equal(typeof t.annotations.idempotentHint, 'boolean', `${t.name}: idempotentHint`);
      }
    }
  });

  it('observing and screenshots are read-only, acting on a page is not', async () => {
    const byName = new Map((await listTools()).map(t => [t.name, t.annotations]));
    for (const name of ['browser_observe', 'browser_screenshot']) {
      assert.equal(byName.get(name)?.readOnlyHint, true, name);
    }
    assert.equal(byName.get('browser_act')?.readOnlyHint, false);
    assert.equal(byName.get('browser_act')?.destructiveHint, true);
  });
});
