import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('defaults sessionIdleTimeoutMs to 3600000 (60 min)', () => {
    const prevKey = process.env['MCP_API_KEY'];
    const prevIdle = process.env['PLAYWRIGHT_SESSION_IDLE_TIMEOUT_MS'];
    try {
      process.env['MCP_API_KEY'] = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';
      delete process.env['PLAYWRIGHT_SESSION_IDLE_TIMEOUT_MS'];
      const config = loadConfig();
      assert.equal(config.sessionIdleTimeoutMs, 3600000);
    } finally {
      if (prevKey === undefined) delete process.env['MCP_API_KEY'];
      else process.env['MCP_API_KEY'] = prevKey;
      if (prevIdle === undefined) delete process.env['PLAYWRIGHT_SESSION_IDLE_TIMEOUT_MS'];
      else process.env['PLAYWRIGHT_SESSION_IDLE_TIMEOUT_MS'] = prevIdle;
    }
  });
});
