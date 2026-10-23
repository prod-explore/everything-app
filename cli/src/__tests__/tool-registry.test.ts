import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, withoutOrchestratorParams } from '../tool-registry.js';
import type { McpConnectionLike, McpToolInfo, McpToolCallResult } from '../mcp-client.js';

function fakeConnection(
  name: string,
  tools: McpToolInfo[],
  onCall?: (toolName: string, args: Record<string, unknown>) => McpToolCallResult,
): McpConnectionLike {
  return {
    name,
    async listTools() {
      return tools;
    },
    async callTool(toolName, args) {
      return onCall?.(toolName, args) ?? { text: `${toolName} called`, isError: false };
    },
  };
}

const sandboxTools: McpToolInfo[] = [
  { name: 'run_bash', description: 'run a command', inputSchema: { type: 'object' } },
  { name: 'read_log', description: 'read the log', inputSchema: { type: 'object' } },
];

const obsidianTools: McpToolInfo[] = [
  { name: 'get_path', description: 'read/list', inputSchema: { type: 'object' } },
  { name: 'write_note', description: 'write a note', inputSchema: { type: 'object' } },
];

describe('ToolRegistry', () => {
  it('namespaces tool names per server to avoid collisions', async () => {
    const registry = new ToolRegistry(['read_log', 'get_path']);
    await registry.loadFrom([fakeConnection('sandbox', sandboxTools), fakeConnection('obsidian', obsidianTools)]);

    const names = registry.toLlmTools().map(t => t.name).sort();
    assert.deepEqual(names, ['obsidian__get_path', 'obsidian__write_note', 'sandbox__read_log', 'sandbox__run_bash']);
  });

  it('does not show the model the parameters the orchestrator sets itself, and leaves the registered schema alone', async () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
        _conversation_id: { type: 'string', description: 'Internal' },
        _policy: { type: 'object', properties: { js: { type: 'string' } } },
        _custom: { type: 'string' }, // not ours: stays
      },
      required: ['url', '_conversation_id'],
    };
    const registry = new ToolRegistry([]);
    await registry.loadFrom([fakeConnection('pw', [{ name: 'browser_open', description: 'open', inputSchema: schema }])]);
    const shown = registry.toLlmTools()[0]!.input_schema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(shown.properties), ['url', '_custom']);
    assert.deepEqual(shown.required, ['url']);
    assert.ok('_conversation_id' in schema.properties, 'the original schema is not mutated');
    // No orchestrator params at all: the very same object comes back.
    const plain = { type: 'object', properties: { a: { type: 'string' } } };
    assert.equal(withoutOrchestratorParams(plain), plain);
    // Only orchestrator params: an empty property list, and no `required` left behind.
    const only = withoutOrchestratorParams({ type: 'object', properties: { _conversation_id: {} }, required: ['_conversation_id'] });
    assert.deepEqual(only, { type: 'object', properties: {} });
  });

  it('default-denies approval for anything not explicitly whitelisted', async () => {
    const registry = new ToolRegistry(['read_log', 'get_path']);
    await registry.loadFrom([fakeConnection('sandbox', sandboxTools), fakeConnection('obsidian', obsidianTools)]);

    assert.equal(registry.requiresApproval('sandbox__run_bash'), true);
    assert.equal(registry.requiresApproval('obsidian__write_note'), true);
    assert.equal(registry.requiresApproval('sandbox__read_log'), false);
    assert.equal(registry.requiresApproval('obsidian__get_path'), false);
  });

  it('an unknown exposed name still requires approval (fail safe, not fail open)', async () => {
    const registry = new ToolRegistry(['read_log']);
    assert.equal(registry.requiresApproval('totally__unknown'), true);
  });

  it('routes a call to the owning connection using the real (unprefixed) tool name', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const registry = new ToolRegistry([]);
    await registry.loadFrom([
      fakeConnection('sandbox', sandboxTools, (toolName, args) => {
        calls.push({ tool: toolName, args });
        return { text: 'ok', isError: false };
      }),
    ]);

    const result = await registry.call('sandbox__run_bash', { command: 'echo hi' });

    assert.equal(result.text, 'ok');
    assert.deepEqual(calls, [{ tool: 'run_bash', args: { command: 'echo hi' } }]);
  });

  it('calling an unknown tool returns an error result instead of throwing', async () => {
    const registry = new ToolRegistry([]);
    await registry.loadFrom([fakeConnection('sandbox', sandboxTools)]);

    const result = await registry.call('sandbox__does_not_exist', {});
    assert.equal(result.isError, true);
  });
});
