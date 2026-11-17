import { createContext, useContext } from 'react';
import type { ModelOption, TurnErrorKind } from '../types';

/** What a message's own controls (retry, continue, version picker, edit of a reply, other model) can ask of the chat. */
export interface ChatActions {
  retry: (model?: string) => void | Promise<void>;
  regenerate: (model?: string) => void | Promise<void>;
  continueReply: (model?: string) => void | Promise<void>;
  selectVersion: (messageId: number) => void | Promise<void>;
  editReply: (rowId: number, text: string, index: number) => void | Promise<void>;
  /** The next regenerate the library runs answers with this model (undefined = the chat's own). */
  setReloadModel: (model: string | undefined) => void;
  /** Models a single answer can be asked of (the "Try another model" / "Regenerate with…" menu). */
  models: ModelOption[];
  /** The model the chat uses now, left out of that menu. */
  currentModel: string | null;
  /** The chat only takes local models (ghost chat). */
  onlyLocal: boolean;
  /** How the last turn failed (kind and the provider's own words), for the actions its error block offers. */
  turnError: { kind?: TurnErrorKind; detail?: string } | null;
  /** Summarise the older chat, then try again — offered when the conversation no longer fits the model. */
  compactAndRetry?: () => void;
  /** A message may be edited / regenerated / continued only while nothing runs. */
  busy: boolean;
}

const NONE: ChatActions = {
  retry: () => {},
  regenerate: () => {},
  continueReply: () => {},
  selectVersion: () => {},
  editReply: () => {},
  setReloadModel: () => {},
  models: [],
  currentModel: null,
  onlyLocal: false,
  turnError: null,
  busy: false,
};

export const ChatActionsContext = createContext<ChatActions>(NONE);
export const useChatActions = (): ChatActions => useContext(ChatActionsContext);
