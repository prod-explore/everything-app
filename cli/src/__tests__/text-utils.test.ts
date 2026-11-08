import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trimLeadingChars, trimLeadingSlashes, trimTrailingChars, trimTrailingSlashes } from '../text-utils.js';

describe('text-utils', () => {
  it('trimTrailingSlashes matches /\\/+$/ on ordinary input', () => {
    for (const s of ['', '/', '////', 'a', 'a/', 'a//', '/a/b///', 'https://x.test/', 'a/b/c', '//a//b']) {
      assert.equal(trimTrailingSlashes(s), s.replace(/\/+$/, ''), JSON.stringify(s));
    }
  });

  it('trimLeadingSlashes matches /^\\/+/ on ordinary input', () => {
    for (const s of ['', '/', '////', 'a', '/a', '//a//', '///workspace/x']) {
      assert.equal(trimLeadingSlashes(s), s.replace(/^\/+/, ''), JSON.stringify(s));
    }
  });

  it('trims arbitrary single characters from either end only', () => {
    assert.equal(trimTrailingChars('a--b---', '-'), 'a--b');
    assert.equal(trimLeadingChars('--a--b', '-'), 'a--b');
  });

  it('completes in linear time on adversarial input (100k slashes then a non-slash)', () => {
    const evil = '/'.repeat(100_000) + 'x';
    const t0 = performance.now();
    assert.equal(trimTrailingSlashes(evil), evil);
    assert.equal(trimLeadingSlashes('x' + '/'.repeat(100_000)), 'x' + '/'.repeat(100_000));
    assert.equal(trimTrailingSlashes('/'.repeat(100_000)), '');
    assert.equal(trimLeadingSlashes('/'.repeat(100_000) + 'x'), 'x');
    assert.ok(performance.now() - t0 < 200, 'must not be quadratic');
  });
});
