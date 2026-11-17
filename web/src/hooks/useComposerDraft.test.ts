// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDraft, saveDraft } from './useComposerDraft';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('composer draft storage', () => {
  it('keeps one draft per chat', () => {
    saveDraft('a', 'hello');
    saveDraft('b', 'other');
    expect(loadDraft('a')).toBe('hello');
    expect(loadDraft('b')).toBe('other');
    expect(loadDraft('c')).toBe('');
  });

  it('an empty text removes the draft', () => {
    saveDraft('a', 'hello');
    saveDraft('a', '');
    expect(localStorage.getItem('ea.draft.a')).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(loadDraft('a')).toBe('');
    expect(() => saveDraft('a', 'x')).not.toThrow();
  });
});
