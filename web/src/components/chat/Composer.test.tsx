// @vitest-environment jsdom
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

const onNew = vi.fn(async () => {});

function Harness({ id = 'c1' }: { id?: string }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [], isRunning: false, convertMessage: m => m, onNew });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer conversationId={id} />
    </AssistantRuntimeProvider>
  );
}

function stubTouch(touch: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: touch && query.includes('pointer: coarse'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => { onNew.mockClear(); localStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

describe('Composer', () => {
  it('sends on Enter with a mouse, and keeps Shift+Enter for a new line', async () => {
    stubTouch(false);
    render(<Harness />);
    const box = screen.getByRole('textbox');
    await userEvent.type(box, 'hello{Shift>}{Enter}{/Shift}there');
    expect(onNew).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('on a touch screen Enter is a line break, and the send button sends', async () => {
    stubTouch(true);
    render(<Harness />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await userEvent.type(box, 'one{Enter}two');
    expect(onNew).not.toHaveBeenCalled();
    expect(box.value).toBe('one\ntwo');
    expect(box.getAttribute('enterkeyhint')).toBe('enter');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('keeps what is typed as the chat\'s draft, and brings it back', async () => {
    stubTouch(false);
    const first = render(<Harness id="c1" />);
    await userEvent.type(screen.getByRole('textbox'), 'unsent');
    first.unmount();
    expect(localStorage.getItem('ea.draft.c1')).toBe('unsent');
    render(<Harness id="c1" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('unsent');
  });

  it('gives another chat its own, empty box', () => {
    stubTouch(false);
    localStorage.setItem('ea.draft.c1', 'mine');
    render(<Harness id="c2" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });
});
