import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listenHost } from '../config.js';

describe('listenHost', () => {
  it('binds to loopback unless LISTEN_HOST says otherwise', () => {
    assert.equal(listenHost({}), '127.0.0.1');
    assert.equal(listenHost({ LISTEN_HOST: '' }), '127.0.0.1');
    assert.equal(listenHost({ LISTEN_HOST: '   ' }), '127.0.0.1');
    assert.equal(listenHost({ LISTEN_HOST: '0.0.0.0' }), '0.0.0.0');
    assert.equal(listenHost({ LISTEN_HOST: ' 10.0.0.5 ' }), '10.0.0.5');
  });
});
