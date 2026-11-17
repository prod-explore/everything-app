// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatActionsContext, type ChatActions } from '../../lib/chatActions';
import type { ModelOption } from '../../types';
import { TurnErrorBlock } from './TurnErrorBlock';
import { VersionPicker } from './VersionPicker';
import { ModelMenu } from './ModelMenu';

const model = (id: string, label = id): ModelOption => ({ id, label, providerLabel: 'Prov', kind: 'chat', toolSchemaMode: 'full', available: true, locality: 'cloud', description: '' }) as ModelOption;

function actions(over: Partial<ChatActions> = {}): ChatActions {
  return {
    retry: vi.fn(), regenerate: vi.fn(), continueReply: vi.fn(), selectVersion: vi.fn(), editReply: vi.fn(), setReloadModel: vi.fn(),
    models: [model('a'), model('b', 'Model B')], currentModel: 'a', onlyLocal: false, turnError: null, busy: false, ...over,
  };
}
const withChat = (a: ChatActions, ui: ReactNode) => render(<ChatActionsContext.Provider value={a}>{ui}</ChatActionsContext.Provider>);

describe('TurnErrorBlock', () => {
  it('says "Stopped" and offers Continue and Retry, but not Regenerate, for a reply the person stopped', async () => {
    const a = actions();
    withChat(a, <TurnErrorBlock variant="stopped" hasReply canContinue />);
    expect(screen.getByRole('status').textContent).toContain('Stopped');
    await userEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(a.continueReply).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(a.retry).toHaveBeenCalledWith();
    expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
  });

  it('says "Interrupted" with the reason after a failure that left text, and offers every way on', async () => {
    const a = actions();
    withChat(a, <TurnErrorBlock variant="error" message="terminated" hasReply canContinue />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Interrupted — terminated');
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(a.regenerate).toHaveBeenCalled();
  });

  it('shows the plain sentence when nothing was answered, with no Continue', () => {
    withChat(actions(), <TurnErrorBlock variant="error" message="The model returned an empty answer." hasReply={false} canContinue={false} />);
    expect(screen.getByRole('alert').textContent).toContain('The model returned an empty answer.');
    expect(screen.queryByText('Interrupted')).toBeNull();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
  });

  it('does not offer a plain retry where only another model can help', () => {
    withChat(actions(), <TurnErrorBlock variant="error" kind="auth" message="bad key" hasReply={false} canContinue={false} />);
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Try another model/ })).toBeTruthy();
  });

  it('retries with the model picked from "Try another model"', async () => {
    const a = actions();
    withChat(a, <TurnErrorBlock variant="error" message="x" hasReply canContinue />);
    await userEvent.click(screen.getByRole('button', { name: /Try another model/ }));
    expect(screen.queryByRole('menuitem', { name: /^a/ })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: /Model B/ }));
    expect(a.retry).toHaveBeenCalledWith('b');
  });

  it('offers compacting when the chat no longer fits, and disables everything while busy', async () => {
    const compact = vi.fn();
    const { unmount } = withChat(actions({ compactAndRetry: compact }), <TurnErrorBlock variant="error" kind="context_too_long" message="too long" hasReply={false} canContinue={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Compact/ }));
    expect(compact).toHaveBeenCalled();
    unmount();
    withChat(actions({ busy: true }), <TurnErrorBlock variant="stopped" hasReply canContinue />);
    expect((screen.getByRole('button', { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is only a label when actions are off (an older message)', () => {
    withChat(actions(), <TurnErrorBlock variant="stopped" hasReply canContinue actions={false} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('ModelMenu', () => {
  it('renders nothing when there is no other model to ask', () => {
    const { container } = render(<ModelMenu models={[model('a')]} current="a" onlyLocal={false} onPick={() => {}}>Pick</ModelMenu>);
    expect(container).toBeEmptyDOMElement();
  });

  it('closes on Escape', async () => {
    render(<ModelMenu models={[model('a'), model('b')]} current="a" onlyLocal={false} onPick={() => {}}>Pick</ModelMenu>);
    await userEvent.click(screen.getByRole('button', { name: /Pick/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('VersionPicker', () => {
  it('shows the place among the versions and moves to the neighbours', async () => {
    const a = actions();
    withChat(a, <VersionPicker versions={[4, 9, 12]} current={9} />);
    expect(screen.getByText('2 / 3')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Previous version'));
    expect(a.selectVersion).toHaveBeenCalledWith(4);
    await userEvent.click(screen.getByLabelText('Next version'));
    expect(a.selectVersion).toHaveBeenCalledWith(12);
  });

  it('stops at the ends, and is absent for a single version', () => {
    const { unmount } = withChat(actions(), <VersionPicker versions={[4, 9]} current={4} />);
    expect((screen.getByLabelText('Previous version') as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const { container } = withChat(actions(), <VersionPicker versions={[4]} current={4} />);
    expect(container).toBeEmptyDOMElement();
  });
});
