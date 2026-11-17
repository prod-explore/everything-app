import { describe, expect, it } from 'vitest';
import type { ModelOption } from '../types';
import { otherModels } from './modelChoices';

const m = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({ id, kind: 'chat', toolSchemaMode: 'full', available: true, locality: 'cloud', ...over }) as ModelOption;

describe('otherModels', () => {
  it('leaves out the current model, unavailable ones, non-chat ones and ones without tools', () => {
    const list = [m('a'), m('b'), m('c', { available: false }), m('d', { kind: 'embedding' as ModelOption['kind'] }), m('e', { toolSchemaMode: 'none' })];
    expect(otherModels(list, 'a', false).map(x => x.id)).toEqual(['b']);
  });

  it('offers only local models to a ghost chat', () => {
    const list = [m('a', { locality: 'local' }), m('b'), m('c', { locality: 'local' })];
    expect(otherModels(list, 'a', true).map(x => x.id)).toEqual(['c']);
  });
});
