// @vitest-environment jsdom
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatActionsContext, type ChatActions } from '../../lib/chatActions';
import type { ModelOption } from '../../types';
import { AssistantBubble, UserBubble } from './MessageBubble';

vi.mock('./MarkdownText', () => ({ MarkdownText: ({ text }: { text: string }) => <p>{text}</p> }));

const model = (id: string, label: string): ModelOption => ({ id, label, providerLabel: 'P', kind: 'chat', toolSchemaMode: 'full', available: true, locality: 'cloud', description: '' }) as ModelOption;

function chatActions(over: Partial<ChatActions> = {}): ChatActions {
  return {
    retry: vi.fn(), regenerate: vi.fn(), continueReply: vi.fn(), selectVersion: vi.fn(), editReply: vi.fn(), setReloadModel: vi.fn(),
    models: [model('a', 'A'), model('b', 'Model B')], currentModel: 'a', onlyLocal: false, turnError: null, busy: false, ...over,
  };
}

function Harness({ messages, actions }: { messages: ThreadMessageLike[]; actions: ChatActions }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages, isRunning: false, convertMessage: m => m, onNew: async () => {}, onReload: async () => {} });
  return (
    <ChatActionsContext.Provider value={actions}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserBubble /> : <AssistantBubble />)}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </ChatActionsContext.Provider>
  );
}

const custom = (c: Record<string, unknown>) => ({ metadata: { custom: c } });
const user = (over: Partial<ThreadMessageLike> = {}): ThreadMessageLike => ({ id: '1', role: 'user', content: [{ type: 'text', text: 'question' }], ...over });
const reply = (text: string, c: Record<string, unknown> = {}): ThreadMessageLike => ({ id: '2', role: 'assistant', content: [{ type: 'text', text }], status: { type: 'complete', reason: 'stop' }, ...custom(c) });

function stubHover(canHover: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: canHover && query.includes('hover: hover'), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}
beforeEach(() => stubHover(true));
afterEach(() => vi.unstubAllGlobals());

describe('AssistantBubble', () => {
  it('marks a reply the person stopped, with Continue, and nothing for a complete one', async () => {
    const a = chatActions();
    const { unmount } = render(<Harness messages={[user(), reply('half', { incomplete: 'stopped', textEdit: { rowId: 2, index: 0 } })]} actions={a} />);
    expect(screen.getByTestId('turn-error').textContent).toContain('Stopped');
    await userEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(a.continueReply).toHaveBeenCalled();
    unmount();
    render(<Harness messages={[user(), reply('whole')]} actions={chatActions()} />);
    expect(screen.queryByTestId('turn-error')).toBeNull();
  });

  it('shows why a failed reply stopped', () => {
    render(<Harness messages={[user(), reply('half', { incomplete: 'error', errorText: 'terminated' })]} actions={chatActions()} />);
    expect(screen.getByRole('alert').textContent).toContain('Interrupted — terminated');
  });

  it('keeps an older cut-short reply as a label, with no buttons of its own', () => {
    const later: ThreadMessageLike[] = [user(), reply('half', { incomplete: 'stopped' }), user({ id: '3' }), { ...reply('fine'), id: '4' }];
    render(<Harness messages={later} actions={chatActions()} />);
    const block = screen.getByTestId('turn-error');
    expect(block.querySelector('button')).toBeNull();
  });

  it('shows versions on the reply and switches them', async () => {
    const a = chatActions();
    render(<Harness messages={[user(), reply('r', { versions: [1, 7], currentVersion: 7 })]} actions={a} />);
    expect(screen.getByText('2 / 2')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Previous version'));
    expect(a.selectVersion).toHaveBeenCalledWith(1);
  });

  it('regenerates with another model: sets it, then reloads', async () => {
    const a = chatActions();
    render(<Harness messages={[user(), reply('r')]} actions={a} />);
    await userEvent.click(screen.getByRole('button', { name: /Regenerate with/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Model B/ }));
    expect(a.setReloadModel).toHaveBeenCalledWith('b');
  });

  it('edits the text of a stored reply in place, without asking the model again', async () => {
    const a = chatActions();
    render(<Harness messages={[user(), reply('old text', { textEdit: { rowId: 2, index: 0 } })]} actions={a} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit reply' }));
    const box = screen.getByRole('textbox', { name: 'Edit reply' });
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(a.editReply).toHaveBeenCalledWith(2, 'new text', 0);
    expect(a.regenerate).not.toHaveBeenCalled();
  });

  it('has no "Edit reply" for a reply that is not stored yet', () => {
    render(<Harness messages={[user(), reply('live')]} actions={chatActions()} />);
    expect(screen.queryByRole('button', { name: 'Edit reply' })).toBeNull();
  });

  it('shows the time of a stored message', () => {
    render(<Harness messages={[user({ createdAt: new Date('2026-01-02T10:00:00Z') }), reply('r')]} actions={chatActions()} />);
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-02T10:00:00.000Z');
  });
});

describe('action rows on touch', () => {
  it('waits for the pointer with a mouse, and is always visible without hover', () => {
    const { unmount } = render(<Harness messages={[user(), reply('r')]} actions={chatActions()} />);
    expect(screen.getAllByRole('button', { name: 'Copy' })[0]!.parentElement!.className).toContain('group-hover:opacity-100');
    unmount();
    stubHover(false);
    render(<Harness messages={[user(), reply('r')]} actions={chatActions()} />);
    for (const copy of screen.getAllByRole('button', { name: 'Copy' })) expect(copy.parentElement!.className).not.toContain('opacity-0');
  });
});
