import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trimTrailingSlashes } from '../text-utils.js';

describe('trimTrailingSlashes', () => {
  it('matches /\\/+$/ on ordinary input', () => {
    for (const s of ['', '/', '////', 'a', 'a/', 'a//', '/a/b///', 'dir/sub/']) assert.equal(trimTrailingSlashes(s), s.replace(/\/+$/, ''), JSON.stringify(s));
  });

  it('is linear on a long run of slashes followed by a non-slash (tar entry names are untrusted)', () => {
    const evil = '/'.repeat(100_000) + 'x';
    const t0 = performance.now();
    assert.equal(trimTrailingSlashes(evil), evil);
    assert.equal(trimTrailingSlashes('/'.repeat(100_000)), '');
    assert.ok(performance.now() - t0 < 200);
  });
});
