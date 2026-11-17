import type { ModelOption } from '../types';

/** Chat models that can be asked now (tools, a key, local when the chat is a ghost chat), the chat's own model left out. */
export function otherModels(models: ModelOption[], current: string | null, onlyLocal: boolean): ModelOption[] {
  return models.filter(m => m.kind === 'chat' && m.toolSchemaMode !== 'none' && m.available && m.id !== current && (!onlyLocal || m.locality === 'local'));
}
